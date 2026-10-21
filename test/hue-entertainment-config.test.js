const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../src/domains/fixtures/hue-entertainment-config.service");
const createAdapter = require("../src/adapters/brands/hue-bridge.adapter");
function setup() {
  let rows = [
    {
      id: "desk",
      brand: "hue",
      bridgeIp: "192.0.2.5",
      username: "private-user",
      clientKey: "a".repeat(32),
      lightId: 1,
    },
    {
      id: "back",
      brand: "hue",
      bridgeIp: "192.0.2.5",
      username: "private-user",
      clientKey: "a".repeat(32),
      lightId: 2,
    },
    {
      id: "other",
      brand: "hue",
      bridgeIp: "192.0.2.5",
      username: "private-user",
      clientKey: "a".repeat(32),
      lightId: 3,
    },
    {
      id: "different-bridge",
      brand: "hue",
      bridgeIp: "192.0.2.6",
      username: "private-user",
      clientKey: "a".repeat(32),
      lightId: 1,
    },
  ];
  const registry = {
    getFixtures: () => structuredClone(rows),
    upsertFixtures(updates) {
      for (const update of updates)
        rows = rows.map((r) => (r.id === update.id ? { ...r, ...update } : r));
      return { ok: true, fixtures: updates };
    },
  };
  let queries = 0;
  const bridge = {
    discoverEntertainmentAreas: async (row) => {
      queries++;
      assert.equal(row.username, "private-user");
      return [{ id: "4", name: "Gaming", lightIds: ["1", "2"], active: false }];
    },
  };
  return { registry, bridge, service: create({ registry, bridge }), queries: () => queries };
}
test("area discovery exposes names and membership without credentials; saved areas feed stream preparation", async () => {
  const e = setup();
  const found = await e.service.discover("desk");
  assert.equal(found.areas[0].includesFixture, true);
  assert.equal(found.clientKeyConfigured, true);
  assert(!JSON.stringify(found).includes("private-user"));
  assert(!JSON.stringify(found).includes("a".repeat(32)));
  const saved = await e.service.save("desk", { areaId: "4", applyToAreaLights: true });
  assert.deepEqual(saved.updatedFixtureIds, ["desk", "back"]);
  const rows = e.registry.getFixtures();
  assert.equal(rows.find((f) => f.id === "other").entertainmentAreaId, undefined);
  assert.equal(rows.find((f) => f.id === "different-bridge").entertainmentAreaId, undefined);
  const prepared = [];
  const transport = require("../src/adapters/brands/hue-entertainment-ownership")({
    hueEntertainment: {
      ensureSession: async (c) => {
        prepared.push(c);
        return { ok: true, session: { channels: [{ lights: ["1"] }, { lights: ["2"] }] } };
      },
      stopConfig: async () => {},
    },
    dryRun: false,
    forceHttp: () => false,
    getMode: () => "auto",
    fixtureSupportsHueEntertainment: () => true,
  });
  assert.deepEqual((await transport.prepareEntertainment(rows, "music-test")).activeIds, [
    "desk",
    "back",
  ]);
  assert(prepared.every((f) => f.entertainmentAreaId === "4" && f.clientKey === "a".repeat(32)));
  await transport.stopEntertainment("music-test");
});
test("manual group IDs and UUIDs work without discovery; keys are validated and retained privately", async () => {
  const e = setup();
  await e.service.save("desk", {
    areaId: "ABCDEF01-2345-6789-ABCD-0123456789AB",
    clientKey: "b".repeat(32),
  });
  let row = e.registry.getFixtures()[0];
  assert.equal(row.entertainmentAreaId, "abcdef01-2345-6789-abcd-0123456789ab");
  assert.equal(row.clientKey, "b".repeat(32));
  assert.equal(e.queries(), 0);
  await e.service.save("desk", { areaId: "5", clientKey: "" });
  assert.equal(e.registry.getFixtures()[0].clientKey, "b".repeat(32));
  for (const areaId of ["../../config", "https://example.com", "1?x=1", "0", "x".repeat(100)])
    await assert.rejects(e.service.save("desk", { areaId }), /invalid_hue_entertainment_area_id/);
  await assert.rejects(
    e.service.save("desk", { areaId: "5", clientKey: "secret" }),
    /invalid_hue_client_key/,
  );
  e.registry.upsertFixtures([{ id: "desk", clientKey: "" }]);
  await assert.rejects(e.service.save("desk", { areaId: "5" }), /client_key_required/);
  await e.service.save("desk", { areaId: "" });
  row = e.registry.getFixtures()[0];
  assert.equal(row.entertainmentAreaId, "");
  await assert.rejects(
    e.service.save("desk", { areaId: "4", applyToAreaLights: true }),
    /client_key_required/,
  );
});
test("area-wide application rejects absent membership and stale bridge changes", async () => {
  const e = setup();
  await assert.rejects(
    e.service.save("other", { areaId: "4", applyToAreaLights: true }),
    /membership_required/,
  );
  let release;
  e.bridge.discoverEntertainmentAreas = () =>
    new Promise((r) => {
      release = r;
    });
  const pending = e.service.save("desk", { areaId: "4", applyToAreaLights: true });
  await new Promise(setImmediate);
  e.registry.upsertFixtures([{ id: "desk", bridgeIp: "192.0.2.99" }]);
  release([{ id: "4", name: "Gaming", lightIds: ["1", "2"] }]);
  await assert.rejects(pending, /hue_fixture_changed/);
  assert.equal(
    e.registry.getFixtures().find((f) => f.id === "back").entertainmentAreaId,
    undefined,
  );
});
test("adapter distinguishes an empty inventory from bridge authentication and network failure", async () => {
  let data = {
    4: { type: "Entertainment", name: "Gaming", lights: ["1", "2"], stream: { active: true } },
    5: { type: "Room", name: "Desk", lights: ["3"] },
  };
  const adapter = createAdapter({
    dryRun: true,
    axios: {
      get: async (_url, options) => {
        assert.equal(options.maxRedirects, 0);
        return { data };
      },
    },
  });
  const input = { bridgeIp: "192.0.2.5", username: "private-user" };
  assert.deepEqual(await adapter.discoverEntertainmentAreas(input), [
    { id: "4", name: "Gaming", lightIds: ["1", "2"], active: true },
  ]);
  data = {};
  assert.deepEqual(await adapter.discoverEntertainmentAreas(input), []);
  data = [{ error: { type: 1, description: "unauthorized user" } }];
  await assert.rejects(adapter.discoverEntertainmentAreas(input), /hue_area_discovery_failed/);
  await adapter.shutdown();
});

test("saving Entertainment does not invalidate fixtures owned by an active lighting session", async () => {
  const e = setup();
  const before = e.registry.getFixtures();
  const service = create({
    registry: e.registry,
    bridge: e.bridge,
    isInUse: (id) => id === "back",
  });
  await assert.rejects(
    service.save("desk", { areaId: "4", applyToAreaLights: true }),
    /stop_lights_first/,
  );
  assert.deepEqual(e.registry.getFixtures(), before);
  await service.save("desk", { areaId: "4" });
  assert.equal(e.registry.getFixtures()[0].entertainmentAreaId, "4");
});
