const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const windows = process.platform === "win32";

function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

test("Windows updater preserves mutable data and can restore managed files", { skip: !windows }, t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-update-integration-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "install");
  const release = path.join(fixture, "release");
  const updateRoot = path.join(root, "runtime", "updates");
  const archive = path.join(updateRoot, "downloads", "RaveLink-Core-Windows-v0.6.2-self-contained.zip");

  write(root, "RELEASE_BUILD.json", JSON.stringify({ version: "0.6.1", channel: "release" }));
  write(root, "src/old.js", "old program");
  write(root, "RaveLink-Core.exe", "old host");
  write(root, "runtime/RaveLink-Core-Node.exe", "old node");
  write(root, "runtime/user-state.json", "preserve runtime");
  write(root, "config/user.json", "preserve config");
  write(root, "features/installed/custom/state.json", "preserve feature");

  write(release, "RELEASE_BUILD.json", JSON.stringify({ version: "0.6.2", channel: "release" }));
  write(release, "src/app/core/create-core-server.js", "new program");
  write(release, "RaveLink-Core.exe", "new host");
  write(release, "runtime/RaveLink-Core-Node.exe", "new node");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const zipped = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Compress-Archive -Path (Join-Path $env:RAVELINK_TEST_RELEASE '*') -DestinationPath $env:RAVELINK_TEST_ARCHIVE -Force"], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, RAVELINK_TEST_RELEASE: release, RAVELINK_TEST_ARCHIVE: archive }
  });
  assert.equal(zipped.status, 0, zipped.stderr);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  write(root, "runtime/updates/staged.json", JSON.stringify({ version: "0.6.2", archivePath: archive, sha256, verified: true }));

  const helper = path.resolve(__dirname, "../scripts/ravelink-update.ps1");
  const apply = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "-Action", "Apply", "-Root", root, "-NoLaunch"], { encoding: "utf8", windowsHide: true });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  assert.equal(fs.readFileSync(path.join(root, "src/app/core/create-core-server.js"), "utf8"), "new program");
  assert.equal(fs.existsSync(path.join(root, "src/old.js")), false);
  assert.equal(fs.readFileSync(path.join(root, "runtime/user-state.json"), "utf8"), "preserve runtime");
  assert.equal(fs.readFileSync(path.join(root, "config/user.json"), "utf8"), "preserve config");
  assert.equal(fs.readFileSync(path.join(root, "features/installed/custom/state.json"), "utf8"), "preserve feature");

  const rollback = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "-Action", "Rollback", "-Root", root, "-NoLaunch"], { encoding: "utf8", windowsHide: true });
  assert.equal(rollback.status, 0, `${rollback.stdout}\n${rollback.stderr}`);
  assert.equal(fs.readFileSync(path.join(root, "src/old.js"), "utf8"), "old program");
  assert.equal(fs.existsSync(path.join(root, "src/app/core/create-core-server.js")), false);
  assert.equal(fs.readFileSync(path.join(root, "runtime/user-state.json"), "utf8"), "preserve runtime");
});
