const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { audit } = require("../scripts/audit-repository-health");
const { sourceFiles } = require("../scripts/lib/source-inventory");

test("feature integrity check hashes actual checkout bytes and never repairs files in check mode", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-feature-bytes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(
    path.resolve(__dirname, "../scripts/refresh-feature-integrity.js"),
    path.join(root, "scripts/refresh-feature-integrity.js"),
  );
  const hash = crypto.createHash("sha256").update("line\n").digest("hex");
  for (const feature of ["song-request", "twitch-integration"]) {
    const directory = path.join(root, "features", feature);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "payload.txt"), "line\n");
    fs.writeFileSync(
      path.join(directory, "ravelink.feature.json"),
      JSON.stringify({ integrity: { files: { "payload.txt": hash } } }),
    );
  }
  const run = () =>
    execFileSync(process.execPath, ["scripts/refresh-feature-integrity.js", "--check"], {
      cwd: root,
      stdio: "pipe",
    });
  run();
  const payload = path.join(root, "features/song-request/payload.txt");
  fs.writeFileSync(payload, "line\r\n");
  assert.throws(run, /Feature text must use LF bytes/);
  assert.equal(fs.readFileSync(payload, "utf8"), "line\r\n");
});

test("source inventory distinguishes authored feature dist modules from rebuilt companion copies", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of [
    "features/song-request/dist/main.js",
    "integrations/spotify-desktop/adapter.cjs",
    "integrations/spotify-desktop/dist/renderer.js",
    "integrations/spotify-desktop/vendor/upstream.js",
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "module.exports = {};");
  }
  assert.deepEqual(sourceFiles(undefined, root), [
    "features/song-request/dist/main.js",
    "integrations/spotify-desktop/adapter.cjs",
  ]);
});

test("health audit catches copied implementations despite notes/spacing and catches broken local imports", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  const implementation =
    "module.exports = function values() { return [" +
    Array.from({ length: 60 }, (_, index) => index).join(",") +
    "]; };";
  fs.writeFileSync(path.join(root, "src/first.js"), implementation);
  fs.writeFileSync(
    path.join(root, "src/copied.js"),
    "// different explanatory notes\n" + implementation.replaceAll(",", ",\n"),
  );
  assert.match(audit(root).errors.join("\n"), /duplicate implementation/);
  fs.writeFileSync(path.join(root, "src/copied.js"), "module.exports = require('./missing');");
  assert.match(audit(root).errors.join("\n"), /unresolved local import/);
});

test("retired previews cannot return through catalog, authored source or generated player setup", () => {
  const root = path.resolve(__dirname, "..");
  const {
    OFFICIAL_FEATURE_SOURCES,
  } = require("../src/capabilities/feature-platform/packages/official-feature-sources");
  assert.equal(
    OFFICIAL_FEATURE_SOURCES.some((row) => row.id === "clip-studio"),
    false,
  );
  for (const relative of [
    "features/clip-studio",
    "experiments/tidal-luna",
    "scripts/build-tidal-experiment.js",
    "scripts/start-tidal-experiment.js",
  ]) {
    assert.equal(fs.existsSync(path.join(root, relative)), false, relative);
  }
  const player = fs.readFileSync(path.join(root, "features/song-request/ui/player.html"), "utf8");
  assert.doesNotMatch(player, /tidalPluginAddress|tidalPairingFile|Legacy Luna companion/);
});
