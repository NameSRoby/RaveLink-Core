const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createFeaturePackageManager = require("../src/capabilities/feature-platform/packages/feature-package-manager");
const {
  OFFICIAL_FEATURE_SOURCES,
} = require("../src/capabilities/feature-platform/packages/official-feature-sources");

const featuresRoot = path.join(__dirname, "..", "features");

function repositoryFetch({ tamper = "", oversized = false } = {}) {
  return async (url) => {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/features\/([a-z0-9-]+)\/(.+)$/);
    if (!match) return new Response("missing", { status: 404 });
    const featureId = match[1];
    const relative = decodeURIComponent(match[2]);
    const file = path.join(featuresRoot, featureId, ...relative.split("/"));
    if (!fs.existsSync(file)) return new Response("missing", { status: 404 });
    let body = fs.readFileSync(file);
    if (relative === tamper) body = Buffer.concat([body, Buffer.from("tampered")]);
    const length = oversized && relative === "dist/main.js" ? 20 * 1024 * 1024 : body.length;
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(length) },
    });
  };
}

test("filtered feature discovery does not request unrelated remote feature manifests", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-feature-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requested = [];
  const local = repositoryFetch();
  const manager = createFeaturePackageManager({
    installedRoot: path.join(root, "installed"),
    packageRoots: [],
    remoteSources: OFFICIAL_FEATURE_SOURCES,
    runtimeRoot: path.join(root, "runtime"),
    fetchImpl: async (url) => {
      requested.push(url);
      return local(url);
    },
  });
  const result = await manager.listAvailable({
    featureIds: ["twitch-integration"],
    timeoutMs: 2500,
  });
  assert.deepEqual(
    result.features.map((row) => row.id),
    ["twitch-integration"],
  );
  assert.equal(requested.length, 1);
  assert.match(requested[0], /twitch-integration\/ravelink.feature.json$/);
});

test("every official optional feature is advertised from GitHub and installs only after download", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-remote-feature-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createFeaturePackageManager({
    installedRoot: path.join(root, "installed"),
    packageRoots: [],
    remoteSources: OFFICIAL_FEATURE_SOURCES,
    runtimeRoot: path.join(root, "runtime"),
    fetchImpl: repositoryFetch(),
  });
  const available = await manager.listAvailable();
  assert.equal(available.total, 2);
  assert.deepEqual(
    available.features.map((row) => row.id),
    ["song-request", "twitch-integration"],
  );
  assert.ok(
    available.features.every(
      (row) => row.source === "github" && row.downloadRequired === true && row.installed === false,
    ),
  );
  for (const featureId of available.features.map((row) => row.id)) {
    const installed = await manager.install(featureId);
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.equal(fs.existsSync(path.join(root, "installed", featureId, "dist", "main.js")), true);
  }
});

test("remote install rejects a hash mismatch and leaves no partial package", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-remote-tamper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createFeaturePackageManager({
    installedRoot: path.join(root, "installed"),
    packageRoots: [],
    remoteSources: OFFICIAL_FEATURE_SOURCES,
    runtimeRoot: path.join(root, "runtime"),
    fetchImpl: repositoryFetch({ tamper: "dist/main.js" }),
  });
  const result = await manager.install("twitch-integration");
  assert.equal(result.ok, false);
  assert.equal(result.error, "integrity_hash_mismatch");
  assert.equal(fs.existsSync(path.join(root, "installed", "twitch-integration")), false);
});

test("remote install enforces declared response size before buffering", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-remote-size-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createFeaturePackageManager({
    installedRoot: path.join(root, "installed"),
    packageRoots: [],
    remoteSources: OFFICIAL_FEATURE_SOURCES,
    runtimeRoot: path.join(root, "runtime"),
    fetchImpl: repositoryFetch({ oversized: true }),
  });
  const result = await manager.install("twitch-integration");
  assert.equal(result.ok, false);
  assert.equal(result.error, "remote_feature_file_too_large");
});

test("catalog retirement preserves installed package files and retained data", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-retired-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, "installed", "clip-studio");
  const retained = path.join(root, "runtime", "clip-studio");
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(retained, { recursive: true });
  fs.writeFileSync(path.join(installed, "retained.txt"), "installed package");
  fs.writeFileSync(path.join(retained, "project.json"), "retained data");
  const manager = createFeaturePackageManager({
    installedRoot: path.join(root, "installed"),
    packageRoots: [],
    remoteSources: OFFICIAL_FEATURE_SOURCES,
    runtimeRoot: path.join(root, "runtime"),
    fetchImpl: repositoryFetch(),
  });
  const result = await manager.listAvailable();
  assert.equal(
    result.features.some((row) => row.id === "clip-studio"),
    false,
  );
  assert.equal(fs.readFileSync(path.join(installed, "retained.txt"), "utf8"), "installed package");
  assert.equal(fs.readFileSync(path.join(retained, "project.json"), "utf8"), "retained data");
});
