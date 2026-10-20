const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../src/adapters/brands/hue-entertainment-ownership");
function setup() {
  const stopped = [],
    started = [];
  const scope = create({
    hueEntertainment: {
      ensureSession: async (f) => {
        started.push(f.id);
        return { ok: true, session: { channels: [{ lights: [String(f.lightId)] }] } };
      },
      stopConfig: async (f) => {
        stopped.push(f.id);
      },
    },
    dryRun: false,
    forceHttp: () => false,
    getMode: () => "auto",
    fixtureSupportsHueEntertainment: () => true,
  });
  const fixture = (id, bridgeIp = "192.0.2.1") => ({
    id,
    brand: "hue",
    bridgeIp,
    lightId: 7,
    clientKey: "ab".repeat(16),
    entertainmentAreaId: "3",
  });
  return { scope, fixture, stopped, started };
}
test("Entertainment owners isolate bridges and refuse overlapping bridge claims", async () => {
  const { scope, fixture, stopped, started } = setup();
  assert.deepEqual((await scope.prepareEntertainment([fixture("a")], "first")).activeIds, ["a"]);
  assert.equal(
    (await scope.prepareEntertainment([fixture("b")], "second")).error,
    "hue_entertainment_bridge_busy",
  );
  assert.deepEqual(stopped, []);
  assert.equal((await scope.prepareEntertainment([fixture("c", "192.0.2.2")], "third")).ok, true);
  await scope.stopEntertainment("third");
  assert.deepEqual(stopped, ["c"]);
  assert.deepEqual(started, ["a", "c"]);
  await scope.stopEntertainment("first");
  assert.deepEqual(stopped, ["c", "a"]);
});
test("reusing an owner drains its previous stream before a replacement selection", async () => {
  const { scope, fixture, stopped } = setup();
  await scope.prepareEntertainment([fixture("a")], "owner");
  await scope.prepareEntertainment([fixture("b", "192.0.2.2")], "owner");
  assert.deepEqual(stopped, ["a"]);
  await scope.stopEntertainment("owner");
  assert.deepEqual(stopped, ["a", "b"]);
});
