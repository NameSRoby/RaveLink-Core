/** Compile the real host and exercise loopback requests and owned processes.
 * Unique high ports isolate IPC from the user's running Core instance. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const windows = process.platform === "win32";
let build;
function compiled() {
  if (build) return build;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-host-"));
  const source = path.join(root, "desktop/windows-host/RaveLinkCoreHost.cs");
  const harness = path.join(dir, "Harness.cs");
  fs.writeFileSync(
    harness,
    `using System; using RaveLink.Core.WindowsHost;
class Harness { [STAThread] static void Main(string[] args) {
 if(args[0]=="blocked-ui") {
   System.Windows.Forms.Application.EnableVisualStyles();
   var context = new CoreApplicationContext(args[1], true);
   var timer = new System.Windows.Forms.Timer { Interval = 500 };
   timer.Tick += delegate { if(!System.IO.File.Exists(System.IO.Path.Combine(args[1],"child.pid")))return; timer.Stop(); System.IO.File.WriteAllText(System.IO.Path.Combine(args[1],"blocked"),"ready"); System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite); };
   timer.Start(); System.Windows.Forms.Application.Run(context); return;
 }
 if(args[0]=="stop") ServerControl.RequestStopAsync(int.Parse(args[1])).GetAwaiter().GetResult();
 else Console.WriteLine(ServerControl.IsHealthyVersionAsync(int.Parse(args[1]),args.Length>2?args[2]:"").GetAwaiter().GetResult());
} }`,
  );
  const compiler = path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  for (const name of ["Harness", "RaveLink-Core"]) {
    const args = [
      "/nologo",
      "/platform:x64",
      "/warnaserror+",
      "/reference:System.Drawing.dll",
      "/reference:System.Windows.Forms.dll",
      `/out:${path.join(dir, name + ".exe")}`,
    ];
    if (name === "Harness") args.push("/main:Harness");
    else args.push("/target:winexe");
    args.push(source);
    if (name === "Harness") args.push(harness);
    const result = spawnSync(compiler, args, { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  return (build = {
    dir,
    harness: path.join(dir, "Harness.exe"),
    host: path.join(dir, "RaveLink-Core.exe"),
  });
}
function run(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, ...options });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("host command exceeded its deadline"));
    }, 10000);
    child.stdout?.on("data", (b) => (stdout += b));
    child.stderr?.on("data", (b) => (stderr += b));
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
async function listener(t, handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((r) => server.close(r));
  });
  return server.address().port;
}
for (const body of [false, true])
  test(
    `host health deadline covers stalled ${body ? "body" : "headers"}`,
    { skip: !windows },
    async (t) => {
      const port = await listener(t, (_req, res) => {
        if (body) {
          res.writeHead(200);
          res.write("{");
        }
      });
      const harness = compiled().harness;
      const at = performance.now();
      const result = await run(harness, ["health", String(port)]);
      assert.equal(result.stdout.trim(), "False");
      assert(performance.now() - at < 2500);
    },
  );
test(
  "host refuses unrelated health and never sends it a shutdown",
  { skip: !windows },
  async (t) => {
    let stops = 0;
    const port = await listener(t, (req, res) => {
      if (req.url === "/system/stop") stops++;
      res.end('{"ok":true}');
    });
    assert.equal((await run(compiled().harness, ["health", String(port)])).stdout.trim(), "False");
    await run(compiled().harness, ["stop", String(port)]);
    assert.equal(stops, 0);
  },
);
test("host validates version and bounds a hung shutdown", { skip: !windows }, async (t) => {
  const port = await listener(t, (req, res) => {
    if (req.url === "/health")
      res.end('{"ok":true,"profile":"clean-slate-core+features","version":"0.7.4a"}');
  });
  assert.equal(
    (await run(compiled().harness, ["health", String(port), "0.7.4a"])).stdout.trim(),
    "True",
  );
  assert.equal(
    (await run(compiled().harness, ["health", String(port), "other"])).stdout.trim(),
    "False",
  );
  const at = performance.now();
  await run(compiled().harness, ["stop", String(port)]);
  assert(performance.now() - at < 3000);
});
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error("host lifecycle did not settle");
    await new Promise((r) => setTimeout(r, 50));
  }
}
for (const starts of [false, true, "blocked"])
  test(
    `actual tray host can ${starts === "blocked" ? "exit despite a blocked UI thread" : starts ? "start, restart and exit" : "cancel a server that never becomes ready"}`,
    { skip: !windows },
    async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-host-process-"));
      const exe = path.join(dir, "RaveLink-Core.exe");
      fs.copyFileSync(compiled().host, exe);
      fs.mkdirSync(path.join(dir, "runtime"));
      fs.copyFileSync(process.execPath, path.join(dir, "runtime/RaveLink-Core-Node.exe"));
      const app = path.join(dir, "src/app/optional");
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(
        path.join(app, "feature-enabled-server.js"),
        `require('fs').writeFileSync('child.pid',String(process.pid));
    ${starts === true ? `const s=require('http').createServer((q,r)=>{r.end(JSON.stringify({ok:true,profile:'clean-slate-core+features',version:'0.7.4a',pid:process.pid}));if(q.url==='/system/stop')s.close(()=>process.exit(0));});s.listen(Number(process.env.PORT),'127.0.0.1');` : "setInterval(()=>{},1000);"}`,
      );
      const tempServer = http.createServer();
      await new Promise((r) => tempServer.listen(0, "127.0.0.1", r));
      const port = tempServer.address().port;
      await new Promise((r) => tempServer.close(r));
      const env = {
        ...process.env,
        PORT: String(port),
        PATH: path.join(process.env.WINDIR, "System32"),
        HOST: "invalid.example",
      };
      const child = spawn(
        starts === "blocked" ? compiled().harness : exe,
        starts === "blocked" ? ["blocked-ui", dir] : ["--background"],
        { cwd: dir, env, windowsHide: true },
      );
      let exited = false;
      child.once("exit", () => (exited = true));
      t.after(async () => {
        if (!exited) await run(exe, ["--stop"], { env });
        if (!exited) child.kill();
      });
      await until(() => fs.existsSync(path.join(dir, "child.pid")));
      let pid = Number(fs.readFileSync(path.join(dir, "child.pid"), "utf8"));
      if (starts === "blocked") await until(() => fs.existsSync(path.join(dir, "blocked")));
      if (starts === true) {
        await until(async () => {
          try {
            return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
          } catch {
            return false;
          }
        });
        await run(exe, ["--restart"], { env });
        await until(() => Number(fs.readFileSync(path.join(dir, "child.pid"), "utf8")) !== pid);
        pid = Number(fs.readFileSync(path.join(dir, "child.pid"), "utf8"));
      }
      await run(exe, ["--stop"], { env });
      await until(() => exited);
      assert.throws(() => process.kill(pid, 0));
    },
  );
