const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const createCoreServer = require("../src/app/core/create-core-server");
const root = path.resolve(__dirname, "..");
let built;
async function cleanProfile(port) {
  const parent = path.resolve(process.env.LOCALAPPDATA, "RaveLink/Core/WebView2");
  const id = crypto
    .createHash("sha256")
    .update(path.resolve(compiled().directory).replace(/\\$/, "").toUpperCase() + ":" + port)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  const target = path.resolve(parent, id);
  if (!/^[A-F0-9]{24}$/.test(id) || path.dirname(target) !== parent)
    throw Error("Invalid test profile path");
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
function compiled() {
  if (built) return built;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-desktop-test-"));
  const restored = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts/restore-webview2.ps1"),
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  const deps = path.join(root, "runtime/desktop");
  fs.cpSync(deps, path.join(directory, "runtime/desktop"), { recursive: true });
  const exe = path.join(directory, "DesktopHarness.exe");
  const args = [
    "/nologo",
    "/platform:x64",
    "/warnaserror+",
    "/main:DesktopHarness",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Web.Extensions.dll",
    `/reference:${path.join(deps, "Microsoft.Web.WebView2.Core.dll")}`,
    `/reference:${path.join(deps, "Microsoft.Web.WebView2.WinForms.dll")}`,
    `/out:${exe}`,
    ...[
      "RaveLinkCoreHost.cs",
      "DashboardWindow.cs",
      "DesktopPolicy.cs",
      "DesktopBrowserActions.cs",
    ].map((name) => path.join(root, "desktop/windows-host", name)),
    path.join(__dirname, "support/windows-desktop-harness.cs"),
  ];
  const result = spawnSync(
    path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
    args,
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return (built = { exe, directory });
}
function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(compiled().exe, args, {
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let output = "",
      errors = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("desktop harness timeout: " + output + errors));
    }, 45000);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(Error(output + errors));
      else resolve(JSON.parse(output.trim()));
    });
  });
}
test(
  "desktop navigation and theme bridge accept only bounded workspace presentation",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await run(["policy"]);
    assert.ok(
      Object.values(result).every((value) => value === true),
      JSON.stringify(result),
    );
  },
);
test(
  "real WebView2 renders Core, retains its profile, follows themes and preserves sign-in popup handles",
  { skip: process.platform !== "win32", timeout: 60000 },
  async (t) => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-desktop-state-"));
    const { app, services } = createCoreServer({
      runtimeDir: state,
      dryRun: true,
      fixtureSecretVaultOptions: require("./support/fixture-vault-codec.cjs"),
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    t.after(async () => {
      await services.lifecycle.stopAll();
      await new Promise((resolve) => server.close(resolve));
    });
    const picture = path.join(root, "runtime/desktop-workspace.png");
    const profilePort = server.address().port;
    t.after(() => cleanProfile(profilePort));
    const result = await run(["ui", compiled().directory, String(server.address().port), picture]);
    assert.equal(result.rendered, true);
    assert.equal(result.popup, true);
    assert.equal(result.theme, true);
    assert.equal(
      result.chrome,
      true,
      "toolbar stays dark and aligned after resize and tray hide/show",
    );
    assert.equal(result.retained, true);
    assert.equal(result.blocked, true);
    assert.equal(result.stored, '"retained"');
    assert.equal(result.clipboard, "true");
    assert.ok(fs.statSync(picture).size > 1000);
  },
);
test(
  "a missing browser runtime leaves Core available and shows a browser fallback",
  { skip: process.platform !== "win32", timeout: 60000 },
  async (t) => {
    const http = require("node:http");
    const server = await new Promise((resolve) => {
      const listener = http
        .createServer((_req, res) =>
          res.end(JSON.stringify({ ok: true, profile: "clean-slate-core" })),
        )
        .listen(0, "127.0.0.1", () => resolve(listener));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const result = await run(["fallback", compiled().directory, String(server.address().port)], {
      WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: path.join(compiled().directory, "absent-browser-runtime"),
    });
    assert.equal(result.visible, true);
    assert.match(result.fallback, /browser/i);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/health`)).status, 200);
  },
);
