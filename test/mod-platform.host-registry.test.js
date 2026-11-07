// [TITLE] Test Module: test/mod-platform.host-registry.test.js
// [TITLE] Purpose: verify non-executing mod discovery and explicit bounded activation

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createModHostRegistry = require("../src/capabilities/mod-platform/host/mod-host-registry");

const HASH = "a".repeat(64);

function manifest(publisher, name) {
  const id = `${publisher}.${name}`;
  return {
    schemaVersion: 1,
    id,
    name,
    version: "1.0.0",
    publisher,
    license: "MIT",
    entry: "dist/main.js",
    engine: { ravelinkModApi: "^1.0.0", node: ">=22" },
    activationEvents: ["onEnable"],
    consumes: [],
    provides: [`${name}.service.v1`],
    permissions: {},
    resources: {
      idleCpuPercent: 0.1,
      idleRssMiB: 32,
      activeRssMiB: 64,
      timers: 1,
      minTimerMs: 1000,
      ipcFrameBytes: 32768,
      inFlightCalls: 1,
      queuedCalls: 1,
      externalInFlight: 0,
      storageBytes: 0,
      historyEntries: 10,
      shutdownGraceMs: 500,
    },
    integrity: { algorithm: "sha256", files: { "dist/main.js": HASH } },
  };
}

function installFixture(modsRoot, descriptor, source = "module.exports = {};\n") {
  const root = path.join(modsRoot, descriptor.id);
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "ravelink.mod.json"), `${JSON.stringify(descriptor)}\n`, "utf8");
  fs.writeFileSync(path.join(root, "dist", "main.js"), source, "utf8");
  return root;
}

function createFakeSupervisorFactory(created) {
  return (options) => {
    let lifecycle = "installed-disabled";
    const api = {
      getStatus: () => ({
        ok: true,
        modId: options.manifest.id,
        lifecycle,
        lastError: "",
      }),
      start: async () => {
        lifecycle = "active";
        return api.getStatus();
      },
      stop: async () => {
        lifecycle = "installed-disabled";
        return api.getStatus();
      },
      request: async (capability, method, payload) => ({
        ok: true,
        value: { capability, method, payload },
      }),
    };
    created.push({ options, api });
    return api;
  };
}

test("registry treats an absent mods directory as an empty zero-work state", () => {
  const root = path.join(os.tmpdir(), `ravelink-missing-mods-${Date.now()}`);
  const registry = createModHostRegistry({ modsRoot: root });
  const snapshot = registry.discover();
  assert.equal(snapshot.total, 0);
  assert.equal(snapshot.active, 0);
  assert.equal(fs.existsSync(root), false);
});

test("registry discovers manifests without evaluating mod entry code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-mod-registry-"));
  const marker = path.join(root, "executed.txt");
  installFixture(
    root,
    manifest("alpha", "echo"),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');\nmodule.exports = {};\n`,
  );
  const registry = createModHostRegistry({ modsRoot: root });
  const snapshot = registry.discover();
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.mods[0].lifecycle, "installed-disabled");
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("registry reports malformed and duplicate manifests deterministically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-mod-registry-errors-"));
  installFixture(root, manifest("alpha", "echo"));
  const duplicateRoot = path.join(root, "duplicate-folder");
  fs.mkdirSync(duplicateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(duplicateRoot, "ravelink.mod.json"),
    JSON.stringify(manifest("alpha", "echo")),
    "utf8",
  );
  const invalidRoot = path.join(root, "invalid-folder");
  fs.mkdirSync(invalidRoot, { recursive: true });
  fs.writeFileSync(path.join(invalidRoot, "ravelink.mod.json"), "{broken", "utf8");
  const snapshot = createModHostRegistry({ modsRoot: root }).discover();
  assert.equal(snapshot.total, 1);
  assert.equal(
    snapshot.discoveryErrors.some((error) => error.code === "duplicate_mod_id"),
    true,
  );
  assert.equal(
    snapshot.discoveryErrors.some((error) => error.code === "manifest_invalid_json"),
    true,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("registry requires explicit enable and enforces the global process limit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-mod-registry-limit-"));
  installFixture(root, manifest("alpha", "one"));
  installFixture(root, manifest("beta", "two"));
  const created = [];
  const registry = createModHostRegistry({
    modsRoot: root,
    maxActiveMods: 1,
    activationAdmission: async (row) => ({ ok: true, manifest: row.manifest }),
    supervisorFactory: createFakeSupervisorFactory(created),
  });
  let snapshot = registry.discover();
  assert.equal(snapshot.active, 0);
  assert.equal(created.length, 0);
  assert.equal((await registry.enable("alpha.one")).lifecycle, "active");
  const rejected = await registry.enable("beta.two");
  assert.equal(rejected.error, "active_mod_limit");
  assert.equal(created.length, 1);
  await registry.disable("alpha.one");
  assert.equal((await registry.enable("beta.two")).lifecycle, "active");
  snapshot = await registry.shutdown();
  assert.equal(snapshot.active, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("registry routes calls only to an explicitly activated supervisor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-mod-registry-request-"));
  installFixture(root, manifest("alpha", "echo"));
  const created = [];
  const registry = createModHostRegistry({
    modsRoot: root,
    activationAdmission: async (row) => ({ ok: true, manifest: row.manifest }),
    supervisorFactory: createFakeSupervisorFactory(created),
  });
  registry.discover();
  let result = await registry.request("alpha.echo", "echo.service.v1", "echo", {
    before: true,
  });
  assert.equal(result.error.code, "mod_unavailable");
  await registry.enable("alpha.echo");
  result = await registry.request("alpha.echo", "echo.service.v1", "echo", {
    after: true,
  });
  assert.deepEqual(result.value.payload, { after: true });
  await registry.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("registry negotiates required capabilities and exposes brokered core calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-mod-registry-broker-"));
  const descriptor = manifest("alpha", "consumer");
  descriptor.consumes = ["chat.send.v1"];
  installFixture(root, descriptor);
  const registry = createModHostRegistry({
    modsRoot: root,
    activationAdmission: async (row) => ({ ok: true, manifest: row.manifest }),
    supervisorFactory: createFakeSupervisorFactory([]),
  });
  registry.discover();
  assert.equal((await registry.enable("alpha.consumer")).error, "dependencies_unavailable");
  registry.registerCapabilityContract({
    capability: "chat.send.v1",
    methods: {
      send: {
        validateRequest: (value) => Boolean(value && typeof value.text === "string"),
        validateResponse: (value) => value?.sent === true,
      },
    },
  });
  registry.registerHostCapability({
    providerId: "ravelink.chat",
    capability: "chat.send.v1",
    invoke: async () => ({ sent: true }),
  });
  assert.equal((await registry.enable("alpha.consumer")).lifecycle, "active");
  assert.equal(
    (
      await registry.requestCapability("chat.send.v1", "send", {
        text: "hello",
      })
    ).value.sent,
    true,
  );
  await registry.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});
