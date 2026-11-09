/** Execute the generated Inno prerequisite flow against a tiny fake vendor
 * installer and a unique registry key. Never alter the real WebView2 runtime. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const spec = require("../desktop/windows-host/prerequisites.json").webview2;
const compiler = [
  process.env.ISCC_PATH,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs/Inno Setup 6/ISCC.exe"),
  "C:/Program Files (x86)/Inno Setup 6/ISCC.exe",
].find((p) => p && fs.existsSync(p));
const run = (file, args, env) =>
  spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 45000,
    env: { ...process.env, ...env },
  });

test(
  "offline Setup skips installed runtimes, installs missing ones, and blocks failed/tampered prerequisites",
  { skip: process.platform !== "win32" || !compiler },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-setup-prereq-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stub = path.join(root, spec.file),
      source = path.join(root, "stub.cs");
    fs.writeFileSync(
      source,
      `using System; using System.IO; using Microsoft.Win32;
class Stub { static int Main(string[] args) {
  string id = Environment.GetEnvironmentVariable("RAVELINK_PREREQ_FIXTURE_ID");
  if (id == null || id.Length != 32) return 90;
  string key = "Software\\\\RaveLink\\\\SetupTests\\\\" + id;
  using (var user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry32)) {
    if (args.Length > 0 && args[0] == "--cleanup") { user.DeleteSubKeyTree(key, false); return 0; }
    if (args.Length == 0 || args[0] != "--preinstall") File.WriteAllText(Environment.GetEnvironmentVariable("RAVELINK_PREREQ_FIXTURE_MARKER"), "executed");
    if (Environment.GetEnvironmentVariable("RAVELINK_PREREQ_FIXTURE_FAIL") == "1") return 19;
    using (var installed = user.CreateSubKey(key)) installed.SetValue("pv", "157.0.1.0");
  } return 0;
} }`,
    );
    const csc = path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
    const built = run(csc, ["/nologo", "/target:exe", "/platform:x64", "/out:" + stub, source]);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(stub)).digest("hex");
    const actualKey =
      "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    for (const mode of ["missing", "existing", "failure", "tampered"]) {
      const directory = path.join(root, mode);
      fs.mkdirSync(directory);
      const id = crypto.randomBytes(16).toString("hex");
      const marker = path.join(directory, "executed.txt");
      const env = {
        RAVELINK_PREREQ_FIXTURE_ID: id,
        RAVELINK_PREREQ_FIXTURE_MARKER: marker,
        RAVELINK_PREREQ_FIXTURE_FAIL: mode === "failure" ? "1" : "0",
      };
      const fixtureKey = "Software\\RaveLink\\SetupTests\\" + id;
      try {
        if (mode === "existing") assert.equal(run(stub, ["--preinstall"], env).status, 0);
        const code = require("../scripts/installer-prerequisite-code")()
          .join("\n")
          .replaceAll(actualKey, fixtureKey)
          .replaceAll(spec.sha256, mode === "tampered" ? "0".repeat(64) : digest);
        const payload = path.join(directory, "installed.txt");
        fs.writeFileSync(payload, "ready");
        const script = path.join(directory, "fixture.iss");
        fs.writeFileSync(
          script,
          `[Setup]
AppId=RaveLinkPrerequisiteFixture${id}
AppName=RaveLink prerequisite test
AppVersion=1
DefaultDirName=${directory}\\app
OutputDir=${directory}
OutputBaseFilename=fixture
PrivilegesRequired=lowest
Uninstallable=no
CreateUninstallRegKey=no
DisableDirPage=yes
DisableProgramGroupPage=yes
UsePreviousAppDir=no
Compression=none
[Files]
Source: "${stub}"; Flags: dontcopy
Source: "${payload}"; DestDir: "{app}"
[Code]
${code}
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin Result := InstallBundledPrerequisites(NeedsRestart); end;
`,
        );
        const compiled = run(compiler, ["/Qp", script], env);
        assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
        const result = run(
          path.join(directory, "fixture.exe"),
          [
            "/VERYSILENT",
            "/SUPPRESSMSGBOXES",
            "/NORESTART",
            "/SP-",
            "/LOG=" + path.join(directory, "setup.log"),
          ],
          env,
        );
        const success = mode === "missing" || mode === "existing";
        assert.equal(
          result.status === 0,
          success,
          mode + ": " + fs.readFileSync(path.join(directory, "setup.log"), "utf8"),
        );
        assert.equal(fs.existsSync(path.join(directory, "app", "installed.txt")), success, mode);
        assert.equal(fs.existsSync(marker), mode === "missing" || mode === "failure", mode);
      } finally {
        assert.equal(run(stub, ["--cleanup"], env).status, 0);
      }
    }
  },
);
