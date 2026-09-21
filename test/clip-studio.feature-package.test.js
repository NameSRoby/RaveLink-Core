const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { verifyFeaturePackageDirectory } = require("../src/capabilities/feature-platform/packages/feature-package-integrity");
const { compileFeatureContracts } = require("../src/capabilities/feature-platform/contracts/data-contract-compiler");
const { createFeatureRuntimeHarness } = require("./support/feature-runtime-harness");

const root = path.join(__dirname, "..", "features", "clip-studio");

test("Clip Studio infrastructure is a verified optional first-party package", async () => {
  const verified = await verifyFeaturePackageDirectory(root);
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.manifest.id, "clip-studio");
  assert.equal(verified.manifest.version, "0.1.0");
  assert.deepEqual(verified.manifest.permissions, { network: [], storage: false, secrets: [], process: false, hardware: [] });
  assert.deepEqual(verified.manifest.provides, ["video.projects.read.v1"]);
  assert.equal(fs.existsSync(path.join(root, "THIRD_PARTY_NOTICES.md")), true);
  const contracts = await compileFeatureContracts(root, verified.manifest);
  assert.equal(contracts.ok, true, JSON.stringify(contracts));
});

test("Clip Studio infrastructure starts without processing or external providers", async t => {
  const feature = require("../features/clip-studio/dist/main");
  const harness = createFeatureRuntimeHarness(feature, { featureId: "clip-studio", providers: {} });
  await harness.start();
  t.after(() => harness.stop());
  const status = await harness.request("video.projects.read.v1", "status", null);
  assert.deepEqual(status, {
    ok: true,
    phase: "infrastructure",
    active: true,
    projects: 0,
    message: "Clip Studio infrastructure is installed. Video analysis engines are planned for later package updates."
  });
});

test("Clip Studio page explains the inactive processing stage", () => {
  const html = fs.readFileSync(path.join(root, "ui", "projects.html"), "utf8");
  assert.match(html, /No video scanning, model loading, media worker, or background processing/);
  assert.match(html, /video\.projects\.read\.v1/);
  assert.doesNotMatch(html, /https?:\/\//i);
});
