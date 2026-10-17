const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const installer = require("../integrations/spotify-desktop/installer.cjs");
const {
  readArchive,
  writeArchive,
  prepareArchive,
  injectHtml,
} = require("../integrations/spotify-desktop/archive.cjs");
const script =
  "function registerFactory(){};registerFactory();const platform={version:build,getPlayerAPI:()=>native};";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-install-")),
    apps = path.join(root, "Apps");
  fs.mkdirSync(apps);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entries = {
    "index.html":
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head><body><script defer src="/xpui.js"></script></body></html>',
    "xpui.js": script,
    "theme.css": "body{color:white}",
    "cover.png": Buffer.from([0, 1, 255]),
    ...overrides,
  };
  const original = await writeArchive(
    Object.entries(entries).map(([name, data]) => ({
      name,
      data: Buffer.from(data),
      compression: 8,
    })),
  );
  fs.writeFileSync(path.join(apps, "xpui.spa"), original);
  fs.writeFileSync(path.join(apps, "unrelated.spa"), "personal app");
  return { root, apps, original };
}

test("Spotify install planning is read-only and install/uninstall restores the exact original archive", async (t) => {
  const { apps, original } = await fixture(t),
    before = fs.readdirSync(apps);
  const plan = await installer.plan(apps);
  assert.equal(plan.archiveHash, hash(original));
  assert.deepEqual(fs.readdirSync(apps), before);
  const options = {
    isRunning: () => false,
    allowUnverifiedBuild: true,
    expectedArchiveHash: plan.archiveHash,
  };
  const result = await installer.install(apps, options);
  assert.equal(result.installed, true);
  const rows = await readArchive(fs.readFileSync(path.join(apps, "xpui.spa")));
  assert.ok(
    rows
      .find((row) => row.name === "index.html")
      .data.toString()
      .includes('<script src="/ravelink-spotify.js"></script>'),
  );
  assert.ok(
    rows
      .find((row) => row.name === "xpui.js")
      .data.toString()
      .includes("__ravelinkSpotify"),
  );
  assert.deepEqual(rows.find((row) => row.name === "cover.png").data, Buffer.from([0, 1, 255]));
  assert.equal(rows.find((row) => row.name === "theme.css").data.toString(), "body{color:white}");
  assert.equal(installer.status(apps).recoverable, true);
  assert.equal(installer.uninstall(apps, { isRunning: () => false }).restored, true);
  assert.deepEqual(fs.readFileSync(path.join(apps, "xpui.spa")), original);
  assert.deepEqual(fs.readdirSync(apps), before);
  assert.equal(fs.readFileSync(path.join(apps, "unrelated.spa"), "utf8"), "personal app");
});

test("Spotify installer refuses running clients, stale plans, unvalidated builds and unsupported layouts before writes", async (t) => {
  const { apps, original } = await fixture(t),
    plan = await installer.plan(apps);
  await assert.rejects(installer.install(apps), /live_validation_required/);
  await assert.rejects(
    installer.install(apps, {
      allowUnverifiedBuild: true,
      isRunning: () => true,
    }),
    /close_client_required/,
  );
  await assert.rejects(
    installer.install(apps, {
      allowUnverifiedBuild: true,
      isRunning: () => false,
      expectedArchiveHash: "0".repeat(64),
    }),
    /archive_changed/,
  );
  assert.deepEqual(fs.readFileSync(path.join(apps, "xpui.spa")), original);
  assert.equal(fs.readdirSync(apps).length, 2);
  fs.mkdirSync(path.join(apps, "xpui"));
  await assert.rejects(installer.plan(apps), /unpacked_client_detected/);
  assert.equal(plan.changes.length, 3);
  const unsupported = await fixture(t, { "xpui.js": "const unknown=1;" });
  await assert.rejects(installer.plan(unsupported.apps), /platform_hook_unavailable/);
  assert.deepEqual(fs.readFileSync(path.join(unsupported.apps, "xpui.spa")), unsupported.original);
});

test("Spotify removal refuses changed client files and corrupt backups instead of overwriting them", async (t) => {
  const { apps } = await fixture(t),
    plan = await installer.plan(apps);
  await installer.install(apps, {
    allowUnverifiedBuild: true,
    isRunning: () => false,
    expectedArchiveHash: plan.archiveHash,
  });
  const archive = path.join(apps, "xpui.spa"),
    patched = fs.readFileSync(archive);
  fs.writeFileSync(archive, "client updated");
  assert.equal(installer.status(apps).changed, true);
  assert.throws(() => installer.uninstall(apps, { isRunning: () => false }), /archive_changed/);
  assert.equal(fs.readFileSync(archive, "utf8"), "client updated");
  fs.writeFileSync(archive, patched);
  fs.writeFileSync(path.join(apps, ".ravelink-spotify-original.spa"), "corrupt backup");
  assert.throws(
    () => installer.uninstall(apps, { isRunning: () => false }),
    /backup_integrity_failed/,
  );
  assert.deepEqual(fs.readFileSync(archive), patched);
});

test("Spotify prepared transaction can be restored after interruption without deleting unrelated data", async (t) => {
  const { apps, original } = await fixture(t),
    plan = await installer.plan(apps);
  await installer.install(apps, {
    allowUnverifiedBuild: true,
    isRunning: () => false,
    expectedArchiveHash: plan.archiveHash,
  });
  const file = path.join(apps, ".ravelink-spotify-install.json"),
    journal = JSON.parse(fs.readFileSync(file));
  journal.phase = "prepared";
  fs.writeFileSync(file, JSON.stringify(journal));
  installer.uninstall(apps, { isRunning: () => false });
  assert.deepEqual(fs.readFileSync(path.join(apps, "xpui.spa")), original);
  assert.equal(fs.readFileSync(path.join(apps, "unrelated.spa"), "utf8"), "personal app");
});

test("Spotify asset patch refuses duplicate hooks, restrictive CSP and unsafe archive names", async (t) => {
  const { original } = await fixture(t, { "xpui-modules.js": script });
  await assert.rejects(prepareArchive(original, Buffer.from("test renderer")), /hook_ambiguous/);
  assert.throws(
    () =>
      injectHtml(
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><script src="/xpui.js"></script>',
      ),
    /policy_unsupported/,
  );
  const safe =
    '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><script src="/xpui.js"></script>';
  assert.ok(
    injectHtml(safe).startsWith(safe.slice(0, safe.indexOf("<script"))),
    "CSP remains intact",
  );
  const valid = await writeArchive([{ name: "safe.txt", data: Buffer.from("payload") }]);
  const unsafe = Buffer.from(valid);
  let at = 0;
  while ((at = unsafe.indexOf("safe.txt", at)) >= 0) {
    unsafe.write("../x.txt", at);
    at += 8;
  }
  await assert.rejects(readArchive(unsafe), /archive_invalid/);
});
