const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createFeaturePackageManager = require("../src/capabilities/feature-platform/packages/feature-package-manager");
const { OFFICIAL_FEATURE_SOURCES } = require("../src/capabilities/feature-platform/packages/official-feature-sources");

const packageRoot = path.join(__dirname, "..", "features", "clip-studio");

function repositoryFetch({ tamper = "", oversized = false } = {}) {
  return async url => {
    const parsed = new URL(url);
    const marker = "/features/clip-studio/";
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) return new Response("missing", { status: 404 });
    const relative = decodeURIComponent(parsed.pathname.slice(index + marker.length));
    const file = path.join(packageRoot, ...relative.split("/"));
    if (!fs.existsSync(file)) return new Response("missing", { status: 404 });
    let body = fs.readFileSync(file);
    if (relative === tamper) body = Buffer.concat([body, Buffer.from("tampered")]);
    const length = oversized && relative === "dist/main.js" ? 20 * 1024 * 1024 : body.length;
    return new Response(body, { status: 200, headers: { "content-length": String(length) } });
  };
}

test("remote Clip Studio is advertised from GitHub metadata and installs only after download", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-remote-feature-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createFeaturePackageManager({
    installedRoot: path.join(root, "installed"),
    packageRoots: [],
    remoteSources: OFFICIAL_FEATURE_SOURCES,
    runtimeRoot: path.join(root, "runtime"),
    fetchImpl: repositoryFetch()
  });
  const available = await manager.listAvailable();
  assert.equal(available.total, 1);
  assert.equal(available.features[0].id, "clip-studio");
  assert.equal(available.features[0].source, "github");
  assert.equal(available.features[0].downloadRequired, true);
  assert.equal(fs.existsSync(path.join(root, "installed", "clip-studio")), false);
  const installed = await manager.install("clip-studio");
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(fs.existsSync(path.join(root, "installed", "clip-studio", "dist", "main.js")), true);
});

test("remote install rejects a hash mismatch and leaves no partial package", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-remote-tamper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createFeaturePackageManager({
    installedRoot: path.join(root, "installed"),
    packageRoots: [],
    remoteSources: OFFICIAL_FEATURE_SOURCES,
    runtimeRoot: path.join(root, "runtime"),
    fetchImpl: repositoryFetch({ tamper: "dist/main.js" })
  });
  const result = await manager.install("clip-studio");
  assert.equal(result.ok, false);
  assert.equal(result.error, "integrity_hash_mismatch");
  assert.equal(fs.existsSync(path.join(root, "installed", "clip-studio")), false);
});

test("remote install enforces declared response size before buffering", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-remote-size-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createFeaturePackageManager({
    installedRoot: path.join(root, "installed"),
    packageRoots: [],
    remoteSources: OFFICIAL_FEATURE_SOURCES,
    runtimeRoot: path.join(root, "runtime"),
    fetchImpl: repositoryFetch({ oversized: true })
  });
  const result = await manager.install("clip-studio");
  assert.equal(result.ok, false);
  assert.equal(result.error, "remote_feature_file_too_large");
});
