const test = require("node:test");
const assert = require("node:assert/strict");
const createBroker = require("../src/capabilities/mod-platform/host/mod-capability-broker");
const bind = require("../src/capabilities/mod-platform/host/mod-app-controls");

test("declared app controls discover dynamic actions and enforce availability, schemas and cancellation", async () => {
  const broker = createBroker();
  const calls = [];
  const rows = [
    {
      id: "native.audio.volume",
      available: true,
      parameters: {
        type: "object",
        properties: { percent: { type: "integer", minimum: 0, maximum: 100 } },
        required: ["percent"],
        additionalProperties: false,
      },
    },
    { id: "obs:scene", available: false, parameters: {} },
    { id: "mod:example.loop:toggle", available: true, parameters: {} },
    { id: "view.obs", available: true, kind: "navigation" },
  ];
  bind(
    {
      registerCapabilityContract: broker.registerContract,
      registerHostCapability: broker.registerHostProvider,
    },
    {
      catalog: () => rows,
      feedback: () => ({ "native.audio.volume": { state: "ready" } }),
      execute: async (id, params, signal) => {
        calls.push({ id, params });
        assert(!signal.aborted);
        return { ok: true };
      },
    },
  );
  const caller = (consumes = ["ravelink.controls.v1"]) => ({
    id: "example.controls",
    consumes,
    provides: [],
    resources: { inFlightCalls: 1 },
  });
  const invoke = (method, payload, options) =>
    broker.callFromMod(caller(), "ravelink.controls.v1", method, payload, options);
  assert.equal(
    (await broker.callFromMod(caller([]), "ravelink.controls.v1", "catalog", null)).ok,
    false,
  );
  const catalog = await invoke("catalog", null);
  assert(catalog.ok);
  assert.deepEqual(
    catalog.value.actions.map((a) => a.id),
    ["native.audio.volume", "obs:scene"],
  );
  assert.equal(
    (await invoke("execute", { actionId: "native.audio.volume", params: { percent: 101 } })).ok,
    false,
  );
  assert.equal((await invoke("execute", { actionId: "obs:scene", params: {} })).ok, false);
  assert.equal(
    (await invoke("execute", { actionId: "mod:example.loop:toggle", params: {} })).ok,
    false,
  );
  rows.push({
    id: "new.control",
    available: true,
    parameters: { type: "object", additionalProperties: false },
  });
  assert((await invoke("catalog", {})).value.actions.some((a) => a.id === "new.control"));
  assert(
    (await invoke("execute", { actionId: "native.audio.volume", params: { percent: 37 } })).value
      .ok,
  );
  const aborted = AbortSignal.abort();
  assert.equal(
    (
      await invoke(
        "execute",
        { actionId: "native.audio.volume", params: { percent: 20 } },
        { signal: aborted },
      )
    ).ok,
    false,
  );
  assert.deepEqual(calls, [{ id: "native.audio.volume", params: { percent: 37 } }]);
});
