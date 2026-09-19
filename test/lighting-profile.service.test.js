const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const createLightingProfileService = require("../src/domains/fixtures/lighting-profile.service");
const createCoreServer = require("../src/app/core/create-core-server");

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-profiles-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtures = [
    { id: "hue-desk", brand: "hue", enabled: true, engineEnabled: true, extras: { colorTemperatureMired: { minimum: 200, maximum: 400 } } },
    { id: "wiz-wall", brand: "wiz", enabled: true, engineEnabled: true },
    { id: "govee-floor", brand: "govee", enabled: true, engineEnabled: true }
  ];
  const calls = [];
  const cancelled = [];
  const adapter = brand => ({ sendState: async (targets, state) => { calls.push({ brand, fixtureId: targets[0].id, state }); return { sent: 1, failed: 0 }; } });
  const service = createLightingProfileService({
    storePath: path.join(root, "lighting-profiles.json"),
    fixtureRegistry: { getFixtures: () => fixtures, listEngineBy: () => fixtures },
    directiveService: { parseTwitchColorDirective: () => ({ ok: true, hueState: { on: true, bri: 127, xy: [0.1, 0.2] }, wizState: { on: true, dimming: 50, r: 1, g: 2, b: 3 } }) },
    adapters: { hue: adapter("hue"), wiz: adapter("wiz"), govee: adapter("govee") },
    twitchLightEffects: { cancelFixtureIds: ids => cancelled.push(...ids) }
  });
  return { service, calls, cancelled, root };
}

test("lighting profiles persist per-fixture color and true white targets", async t => {
  const { service, calls, cancelled, root } = harness(t);
  const saved = service.save({
    id: "streaming", name: "Streaming", isDefault: true, strategy: "individual",
    fixtureTargets: {
      "hue-desk": { mode: "temperature", temperatureKelvin: 2000, brightness: 70 },
      "wiz-wall": { mode: "temperature", temperatureKelvin: 7000, brightness: 60 },
      "govee-floor": { mode: "color", color: "#123456", brightness: 50 }
    }
  });
  assert.equal(saved.ok, true);
  assert.equal(fs.existsSync(path.join(root, "lighting-profiles.json")), true);

  const applied = await service.applyDefault();
  assert.deepEqual({ sent: applied.sent, failed: applied.failed, skipped: applied.skipped }, { sent: 3, failed: 0, skipped: 0 });
  assert.deepEqual(cancelled.sort(), ["govee-floor", "hue-desk", "wiz-wall"]);
  assert.deepEqual(calls.find(row => row.fixtureId === "hue-desk").state, { on: true, bri: 178, ct: 400 });
  assert.deepEqual(calls.find(row => row.fixtureId === "wiz-wall").state, { on: true, dimming: 60, temp: 6500 });
  assert.deepEqual(calls.find(row => row.fixtureId === "govee-floor").state, { on: true, dimming: 50, r: 1, g: 2, b: 3 });
});

test("shared profile applies one target to every routed brand", async t => {
  const { service, calls } = harness(t);
  service.save({
    id: "warm", name: "Warm", strategy: "shared",
    sharedTarget: { mode: "temperature", temperatureKelvin: 3000, brightness: 40 },
    fixtureTargets: { "hue-desk": {}, "wiz-wall": {} }
  });
  const result = await service.apply("warm");
  assert.equal(result.sent, 2);
  assert.equal(calls.every(row => row.state.ct || row.state.temp), true);
});

test("lighting profile HTTP routes save and apply the selected default", async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-profile-http-"));
  const created = createCoreServer({ runtimeDir, dryRun: true });
  created.services.lightingCore.fixtureRegistry.upsertFixture({ id: "wiz-http", brand: "wiz", ip: "127.0.0.2", engineEnabled: true });
  const server = await new Promise(resolve => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(async () => {
    await created.services.lifecycle.stopAll();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = await fetch(`${base}/lighting-profiles`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "default-room", name: "Default room", isDefault: true, fixtureTargets: { "wiz-http": { mode: "temperature", temperatureKelvin: 3200 } } })
  });
  assert.equal(saved.status, 200);
  const applied = await fetch(`${base}/lighting-profiles/default/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).profileId, "default-room");
});
