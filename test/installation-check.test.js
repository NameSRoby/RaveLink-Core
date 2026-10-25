const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { checkInstallation } = require("../scripts/check-installation");
const createHost = require("../src/domains/music-to-light/music-to-light.service");

test("Music-to-Light deselection never restores grants, captures or writes settings", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-music-off-"));
  const operator = path.join(root, "operator.json");
  const text = JSON.stringify({
    version: 1,
    permissions: { capture: true, output: true },
    sources: [null, null, null],
    fixtures: [],
  });
  fs.writeFileSync(operator, text);
  let captures = 0;
  const host = createHost({
    installed: false,
    operatorPath: operator,
    controllerOptions: {
      probeApi: {
        available: () => true,
        capture: () => {
          captures++;
        },
        listSources: async () => [],
      },
    },
  });
  t.after(async () => {
    await host.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(host.view().installed, false);
  assert.equal(host.view().status.permissions.capture, false);
  assert.throws(() => host.permissions({ capture: true, output: true }), /music_not_installed/);
  assert.throws(() => host.manualRave(), /music_not_installed/);
  assert.equal(captures, 0);
  assert.equal(fs.readFileSync(operator, "utf8"), text);
});

test(
  "prerequisite audit reports missing modules and an unwritable data path",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-prereq-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({ packages: { "": {}, "node_modules/required": { version: "1.0.0" } } }),
    );
    fs.writeFileSync(path.join(root, "runtime"), "not a directory");
    const report = checkInstallation({ root, music: false });
    assert.equal(report.ok, false);
    assert(report.checks.some((r) => r.name === "Production dependencies" && !r.ok));
    assert(report.checks.some((r) => r.name === "Writable application data" && !r.ok));
  },
);

test("bundled Node crypto supports Hue without loading optional Visual C++ addons", () => {
  const entry = require.resolve("node-dtls-client");
  const aead = require.resolve("node-dtls-client/build/lib/AEADCrypto");
  const script = `require.extensions['.node']=()=>{throw Error('External native addons unavailable');}; require(${JSON.stringify(entry)}); const c=require(${JSON.stringify(aead)}); if(typeof c.ccm.encrypt!=='function'||typeof c.gcm.encrypt!=='function')process.exit(2);`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
