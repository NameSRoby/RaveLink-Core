const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateFeatureManifestV1 } = require("../src/capabilities/feature-platform/contracts/feature-manifest-v1");
const { verifyFeaturePackageDirectory } = require("../src/capabilities/feature-platform/packages/feature-package-integrity");

const root = path.join(__dirname, "..", "features", "song-request");

test("Song Request is a verified first-party feature package, not a mod", async () => {
  const verified = await verifyFeaturePackageDirectory(root);
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.manifest.publisher, "ravelink");
  assert.equal(verified.manifest.permissions.network.length, 0);
  assert.deepEqual(verified.manifest.provides, [
    "song.playlist.read.v1", "song.playlist.admin.v1",
    "song.queue.read.v1", "song.queue.submit.v1", "song.queue.admin.v1", "song.queue.events.v1",
    "song.playback.read.v1", "song.playback.driver.v1", "song.playback.observe.v1", "song.playback.events.v1",
    "song.observer.admin.v1",
    "song.overlay.read.v1", "song.overlay.admin.v1", "song.overlay.events.v1",
    "song.catalog.read.v1", "song.catalog.admin.v1"
  ]);
  assert.deepEqual(verified.manifest.contributes.pages.map(page => [page.id, page.surface]), [["player", "panel"], ["request-queue", "panel"], ["server-playlist", "panel"], ["now-playing", "panel"], ["obs-overlay", "overlay"], ["overlay-editor", "panel"]]);
  assert.equal(fs.existsSync(path.join(root, "ravelink.mod.json")), false);
});

test("feature manifest rejects non-RaveLink publishers and capability overlap", () => {
  const input = JSON.parse(fs.readFileSync(path.join(root, "ravelink.feature.json"), "utf8"));
  assert.equal(validateFeatureManifestV1({ ...input, publisher: "someone-else" }).ok, false);
  assert.equal(validateFeatureManifestV1({ ...input, consumes: ["song.queue.read.v1?"], provides: ["song.queue.read.v1"] }).ok, false);
  const missingPageHash = JSON.parse(JSON.stringify(input));
  delete missingPageHash.integrity.files["ui/player.html"];
  assert.equal(validateFeatureManifestV1(missingPageHash).ok, false);
});

test("feature package rejects payload tampering and undeclared files", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-feature-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.cpSync(root, temp, { recursive: true });
  fs.appendFileSync(path.join(temp, "dist", "main.js"), "\n// tampered\n");
  assert.equal((await verifyFeaturePackageDirectory(temp)).error, "integrity_hash_mismatch");
  fs.cpSync(root, temp, { recursive: true, force: true });
  fs.writeFileSync(path.join(temp, "undeclared.txt"), "no");
  assert.equal((await verifyFeaturePackageDirectory(temp)).error, "integrity_inventory_mismatch");
});

test("playlist management presents an explicit delete dialog and bounded toggle controls", () => {
  const html = fs.readFileSync(path.join(root, "ui", "server-playlist.html"), "utf8");
  assert.match(html, /<dialog id="deleteDialog">/);
  assert.match(html, /id="confirmDelete"/);
  assert.match(html, /deleteDialog\.showModal\(\)/);
  assert.match(html, /class="switchLabel"/);
});
