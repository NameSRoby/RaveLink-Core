// [TITLE] Test Module: test/mod-platform.builtin-services.test.js
// [TITLE] Purpose: verify permission services compose only through broker contracts

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createBroker = require("../src/capabilities/mod-platform/host/mod-capability-broker");
const createServices = require("../src/capabilities/mod-platform/host/mod-builtin-services");

test("built-in storage, network, and secrets stay behind declared broker capabilities", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-mod-services-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const manifest = {
    id: "example.services",
    consumes: ["ravelink.storage.v1", "ravelink.network.v1", "ravelink.secrets.v1"],
    provides: [],
    permissions: {
      storage: true,
      network: ["api.example.com:443"],
      secrets: ["provider.signing"],
    },
    resources: { inFlightCalls: 2, storageBytes: 1024, externalInFlight: 1 },
  };
  const broker = createBroker();
  const services = createServices({
    broker,
    dataRoot: root,
    getManifest: (id) => (id === manifest.id ? manifest : null),
    networkTransport: async () => ({
      status: 200,
      data: { public: true },
      bytes: 15,
    }),
  });
  services.registerSecretHandle({
    handle: "provider.signing",
    operations: {
      sign: {
        perform: async () => ({ signed: true }),
        validateResult: (value) => value?.signed === true,
      },
    },
  });
  let response = await broker.callFromMod(manifest, "ravelink.storage.v1", "set", {
    key: "prefs",
    value: { enabled: true },
  });
  assert.equal(response.value.ok, true);
  response = await broker.callFromMod(manifest, "ravelink.network.v1", "request", {
    host: "api.example.com:443",
    path: "/status",
  });
  assert.equal(response.value.data.public, true);
  response = await broker.callFromMod(manifest, "ravelink.secrets.v1", "invoke", {
    handle: "provider.signing",
    operation: "sign",
    payload: {},
  });
  assert.equal(response.value.result.signed, true);
});
