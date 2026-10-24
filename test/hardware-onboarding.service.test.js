const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createCoreServer = require("../src/app/core/create-core-server");
const createFixtureRegistry = require("../src/domains/fixtures/fixture-registry");
const createHardwareOnboardingService = require("../src/domains/fixtures/hardware-onboarding.service");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("concurrent discovery is single-flight while callers receive fresh selection tokens", async () => {
  let releaseHue,
    hueCalls = 0,
    tokenSequence = 0;
  const hueResult = new Promise((resolve) => {
    releaseHue = resolve;
  });
  const service = createHardwareOnboardingService({
    core: {
      fixtureRegistry: { getFixtures: () => [] },
      hueBridge: {
        discoverBridges: () => {
          hueCalls += 1;
          return hueResult;
        },
      },
      wizBridge: { discoverDevices: async () => ({ ok: true, devices: [] }) },
    },
    randomToken: () => `token${String(++tokenSequence).padStart(19, "0")}`,
  });
  const first = service.discover("hue"),
    second = service.discover("hue");
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(hueCalls, 1);
  releaseHue({ ok: true, bridges: [{ ip: "192.168.1.20" }] });
  const [one, two] = await Promise.all([first, second]);
  const firstTargets = service.recordDiscovery("hue", one.bridges);
  const secondTargets = service.recordDiscovery("hue", two.bridges);
  assert.notEqual(firstTargets[0].selectionToken, secondTargets[0].selectionToken);
  await service.discover("hue");
  assert.equal(hueCalls, 2);
  assert.deepEqual(service.getDiagnostics().discoveryWork, {
    active: 0,
    maximumActive: 2,
    started: 2,
    joined: 1,
    completed: 2,
    failed: 0,
  });
});

test("Hue pairing retries retain selection and successful credentials after inventory failure", async () => {
  let pairs = 0;
  let inventories = 0;
  let failSave = true;
  const service = createHardwareOnboardingService({
    core: {
      fixtureRegistry: {
        getFixtures: () => [],
        upsertFixtures: (rows) =>
          failSave ? { ok: false, error: "disk_full" } : { ok: true, fixtures: rows },
      },
      wizBridge: {},
      hueBridge: {
        pairBridge: async () =>
          ++pairs === 1
            ? { ok: false, error: "link_button_timeout" }
            : {
                ok: true,
                bridge: { ip: "192.168.1.10", id: "bridge-one" },
                credentials: { username: "private-user" },
                entertainmentAreas: [],
              },
        listLights: async () =>
          ++inventories === 1
            ? { ok: false, error: "hue_lights_query_failed" }
            : {
                ok: true,
                lights: [{ lightId: 1, name: "Desk" }],
              },
      },
    },
  });
  const [target] = service.recordDiscovery("hue", [{ ip: "192.168.1.10" }]);
  const prepared = service.prepareHue({
    selectionToken: target.selectionToken,
  });
  const input = { pairingToken: prepared.pairingToken };
  assert.equal((await service.pairHue(input)).error, "link_button_timeout");
  assert.equal((await service.pairHue(input)).paired, true);
  const ready = await service.pairHue(input);
  assert.equal(ready.ok, true);
  assert.equal(pairs, 2);
  assert.equal(JSON.stringify(ready).includes("private-user"), false);
  const commit = { setupToken: ready.setupToken, mode: "all" };
  assert.equal(service.commitHue(commit).error, "disk_full");
  failSave = false;
  assert.equal(service.commitHue(commit).ok, true);
});

test("Hue HTTP onboarding discovers, pairs, inventories, and atomically installs selected lights", async (t) => {
  const runtimeDir = tempDir("ravelink-hue-onboarding-");
  const calls = [];
  const axios = {
    async get(url) {
      calls.push(["GET", url]);
      if (url === "https://discovery.meethue.com/")
        return {
          data: [{ id: "ECB5FAFFFEE923D75", internalipaddress: "192.168.1.131" }],
        };
      if (url.endsWith("/groups")) return { data: { 4: { type: "Entertainment", name: "Desk" } } };
      if (url.endsWith("/config"))
        return {
          data: {
            modelid: "BSB002",
            swversion: "1967054020",
            apiversion: "1.68.0",
          },
        };
      if (url.endsWith("/lights"))
        return {
          data: {
            1: {
              name: "Desk left",
              modelid: "LCT015",
              productname: "Hue color lamp",
              uniqueid: "00:11:22:33-01",
            },
            2: {
              name: "Desk right",
              modelid: "LCT015",
              productname: "Hue color lamp",
              uniqueid: "00:11:22:33-02",
            },
          },
        };
      throw new Error(`unexpected_get:${url}`);
    },
    async post(url, body) {
      calls.push(["POST", url, body]);
      assert.equal(url, "http://192.168.1.131/api");
      assert.equal(body.generateclientkey, true);
      return {
        data: [
          {
            success: {
              username: "private-hue-user",
              clientkey: "A".repeat(32),
            },
          },
        ],
      };
    },
  };
  const { app } = createCoreServer({ runtimeDir, dryRun: true, axios });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(
    (
      await fetch(`${base}/hue/discover`, {
        headers: { origin: "https://untrusted.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(calls.length, 0);
  const discoveredResponse = await fetch(`${base}/hue/discover`);
  const discovered = await discoveredResponse.json();
  assert.equal(discovered.targets.length, 1);
  assert.equal(JSON.stringify(discovered).includes("192.168.1.131"), false);

  const pairResponse = await fetch(`${base}/hue/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      selectionToken: discovered.targets[0].selectionToken,
    }),
  });
  const paired = await pairResponse.json();
  assert.equal(pairResponse.status, 200);
  assert.equal(pairResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    paired.lights.map((row) => row.name),
    ["Desk left", "Desk right"],
  );
  assert.equal(JSON.stringify(paired).includes("private-hue-user"), false);
  assert.equal(JSON.stringify(paired).includes("A".repeat(32)), false);

  const commitResponse = await fetch(`${base}/hue/onboarding/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      setupToken: paired.setupToken,
      mode: "selected",
      lightIds: [2],
      zone: "desk",
    }),
  });
  const committed = await commitResponse.json();
  assert.equal(committed.ok, true);
  assert.equal(committed.installed.length, 1);
  assert.equal(committed.installed[0].lightId, 2);

  const fixtures = await fetch(`${base}/fixtures`).then((response) => response.json());
  assert.equal(fixtures.fixtures.length, 1);
  assert.equal(fixtures.fixtures[0].name, "Desk right");
  assert.equal(fixtures.fixtures[0].credentialsConfigured, true);
  assert.equal(JSON.stringify(fixtures).includes("private-hue-user"), false);
  const tested = await fetch(
    `${base}/fixtures/${encodeURIComponent(committed.installed[0].id)}/test`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  ).then((response) => response.json());
  assert.equal(tested.reachable, true);
  assert.equal(tested.hardware.name, "Desk right");
  assert.equal(
    calls.some(([method, url]) => method === "GET" && url.endsWith("/lights")),
    true,
  );
});

test("WiZ onboarding consumes discovered devices and persists one bounded batch", () => {
  const runtimeDir = tempDir("ravelink-wiz-onboarding-");
  const storePath = path.join(runtimeDir, "fixtures.json");
  const fixtureRegistry = createFixtureRegistry({
    storePath,
    seedConfig: { fixtures: [], intentRoutes: {} },
  });
  let sequence = 0;
  const service = createHardwareOnboardingService({
    core: { fixtureRegistry, hueBridge: {}, wizBridge: {} },
    randomToken: () => `token${String(++sequence).padStart(19, "0")}`,
  });
  const targets = service.recordDiscovery("wiz", [
    { ip: "192.168.1.90", roomName: "Desk", moduleName: "ESP25_SHRGB_01" },
    { ip: "192.168.1.91", roomName: "Wall", moduleName: "ESP25_SHRGB_01" },
  ]);
  assert.equal(targets.length, 2);
  const before = fixtureRegistry.getRuntimeVersion();
  const result = service.commitWiz({
    selectionTokens: targets.map((row) => row.selectionToken),
  });
  assert.equal(result.ok, true);
  assert.equal(result.installed.length, 2);
  assert.equal(fixtureRegistry.getRuntimeVersion(), before + 1);
  assert.deepEqual(
    fixtureRegistry.getFixtures().map((row) => row.ip),
    ["192.168.1.90", "192.168.1.91"],
  );
  assert.equal(fs.existsSync(`${storePath}.bak`), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${storePath}.bak`, "utf8")).fixtures, []);
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

test("Govee LAN onboarding connects discovered LAN lights as routable fixtures", async () => {
  const runtimeDir = tempDir("ravelink-govee-onboarding-");
  const fixtureRegistry = createFixtureRegistry({
    storePath: path.join(runtimeDir, "fixtures.json"),
    seedConfig: { fixtures: [], intentRoutes: {} },
  });
  let sequence = 0;
  const service = createHardwareOnboardingService({
    core: {
      fixtureRegistry,
      hueBridge: {},
      wizBridge: {},
      goveeBridge: {
        probeDevice: async () => ({ ok: true, reachable: true, support: "lan-whole-device" }),
      },
    },
    randomToken: () => `token${String(++sequence).padStart(19, "0")}`,
  });
  const [target] = service.recordDiscovery("govee", [
    {
      ip: "192.168.1.92",
      device: "AA:BB:CC:DD",
      sku: "H6008",
      name: "Govee H6008",
    },
  ]);
  const result = service.commitGovee({
    selectionToken: target.selectionToken,
    zone: "desk",
  });
  assert.equal(result.ok, true);
  assert.equal(result.support, "lan-whole-device");
  const [fixture] = fixtureRegistry.getFixtures();
  assert.deepEqual(
    {
      brand: fixture.brand,
      zone: fixture.zone,
      ip: fixture.ip,
      support: fixture.extras.support,
    },
    { brand: "govee", zone: "desk", ip: "192.168.1.92", support: "lan-whole-device" },
  );
  assert.equal((await service.testFixture(fixture.id)).reachable, true);
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});
