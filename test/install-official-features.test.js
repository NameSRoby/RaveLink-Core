const test = require("node:test");
const assert = require("node:assert/strict");
const { installSelectedFeatures, selectedFeatureIds } = require("../scripts/install-official-features");

test("installer feature selection accepts only unique official package IDs", () => {
  assert.deepEqual(selectedFeatureIds(["automation", "automation", "song-request"]), ["automation", "song-request"]);
  assert.throws(() => selectedFeatureIds([]), /invalid_feature_selection/);
  assert.throws(() => selectedFeatureIds(["../local-package"]), /invalid_feature_selection/);
});

test("installer downloads missing selections, updates older ones, and keeps current packages", async () => {
  const calls = [];
  const manager = {
    listAvailable: async () => ({ ok: true, features: [
      { id: "automation", version: "0.14.0", installed: false, installedVersion: "", updateAvailable: false },
      { id: "song-request", version: "0.13.10", installed: true, installedVersion: "0.13.9", updateAvailable: true },
      { id: "twitch-integration", version: "0.10.3", installed: true, installedVersion: "0.10.3", updateAvailable: false }
    ] }),
    install: async id => { calls.push(["install", id]); return { ok: true, featureId: id, version: "0.14.0" }; },
    update: async id => { calls.push(["update", id]); return { ok: true, featureId: id, version: "0.13.10" }; }
  };
  const results = await installSelectedFeatures({ featureIds: ["automation", "song-request", "twitch-integration"], manager });
  assert.deepEqual(calls, [["install", "automation"], ["update", "song-request"]]);
  assert.deepEqual(results.map(row => row.operation), ["installed", "updated", "already_current"]);
});

test("installer fails clearly instead of accepting an unavailable official selection", async () => {
  const manager = { listAvailable: async () => ({ ok: true, features: [] }) };
  await assert.rejects(installSelectedFeatures({ featureIds: ["automation"], manager }), /feature_package_not_available:automation/);
});
