const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const feature = require("../features/soundcloud-integration/dist/main");
const { verifyFeaturePackageDirectory } = require("../src/capabilities/feature-platform/packages/feature-package-integrity");

test("SoundCloud Integration is a verified optional first-party package", async () => {
  const root = path.join(__dirname, "..", "features", "soundcloud-integration");
  const verified = await verifyFeaturePackageDirectory(root);
  assert.equal(verified.ok, true, JSON.stringify(verified));
});

test("SoundCloud Integration exposes only declared official adapter operations", async t => {
  const called = [];
  const providers = {};
  for (const method of ["status", "configure", "clear", "resolve", "import-playlist-start", "import-playlist-status", "import-playlist-page", "import-playlist-cancel"]) {
    providers["soundcloud.catalog.host.v1/" + method] = async () => {
      called.push(method);
      return method === "resolve" ? { ok: false, reason: "none" } : { ok: true, configured: true, available: true, credentials: {}, tokenCached: false, vault: "windows_dpapi", cacheEntries: 0, limits: {}, lastError: "" };
    };
  }
  await feature.activate({ callCapability: (capability, method, payload) => providers[capability + "/" + method](payload) });
  t.after(() => feature.deactivate());
  const request = (capability, method, payload) => feature.handleRequest({ capability, method, payload });
  assert.equal((await request("soundcloud.connection.read.v1", "status", null)).configured, true);
  await request("soundcloud.credentials.admin.v1", "configure", { clientId: "client_id", clientSecret: "client_secret_value" });
  await request("soundcloud.catalog.v1", "resolve", { query: "track" });
  assert.deepEqual(called, ["status", "configure", "resolve"]);
  await assert.rejects(() => request("soundcloud.credentials.admin.v1", "export", null), /method_unavailable/);
});
