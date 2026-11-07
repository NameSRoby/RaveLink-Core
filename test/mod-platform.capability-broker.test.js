// [TITLE] Test Module: test/mod-platform.capability-broker.test.js
// [TITLE] Purpose: verify authorized schema-checked lifecycle-aware capability dispatch

const test = require("node:test");
const assert = require("node:assert/strict");
const createBroker = require("../src/capabilities/mod-platform/host/mod-capability-broker");

const CAPABILITY = "chat.send.v1";
const requestValid = (value) =>
  Boolean(value && typeof value.text === "string" && value.text.length <= 100);
const responseValid = (value) => Boolean(value && value.sent === true);

function manifest(id = "example.consumer", consumes = [CAPABILITY]) {
  return { id, consumes, provides: [], resources: { inFlightCalls: 1 } };
}

function configuredBroker(provider = {}) {
  const broker = createBroker();
  broker.registerContract({
    capability: CAPABILITY,
    methods: {
      send: { validateRequest: requestValid, validateResponse: responseValid },
    },
  });
  broker.registerHostProvider({
    providerId: "ravelink.chat",
    capability: CAPABILITY,
    invoke: provider.invoke || (async () => ({ sent: true })),
    getStatus: provider.getStatus,
  });
  return broker;
}

test("caller cancellation aborts an in-flight host provider and blocks pre-cancelled dispatch", async () => {
  let calls = 0,
    observed;
  const broker = configuredBroker({
    invoke: async (_capability, _method, _payload, options) => {
      calls++;
      observed = options.signal;
      await new Promise((resolve) =>
        options.signal.addEventListener("abort", resolve, { once: true }),
      );
      return { sent: true };
    },
  });
  const controller = new AbortController();
  const pending = broker.callFromCore(
    CAPABILITY,
    "send",
    { text: "hello" },
    { signal: controller.signal },
  );
  controller.abort();
  assert.equal((await pending).error.code, "request_cancelled");
  assert.equal(observed.aborted, true);
  assert.equal(
    (
      await broker.callFromCore(
        CAPABILITY,
        "send",
        { text: "hello" },
        { signal: controller.signal },
      )
    ).error.code,
    "request_cancelled",
  );
  assert.equal(calls, 1);
});

test("broker authorizes declared consumption and validates both payload directions", async () => {
  const broker = configuredBroker();
  assert.equal(
    (
      await broker.callFromMod(manifest(), CAPABILITY, "send", {
        text: "hello",
      })
    ).value.sent,
    true,
  );
  assert.equal(
    (
      await broker.callFromMod(manifest("example.denied", []), CAPABILITY, "send", {
        text: "hello",
      })
    ).error.code,
    "capability_not_declared",
  );
  assert.equal(
    (await broker.callFromMod(manifest(), CAPABILITY, "send", { wrong: true })).error.code,
    "request_schema_invalid",
  );

  const invalidResponse = configuredBroker({
    invoke: async () => ({ sent: false }),
  });
  assert.equal(
    (await invalidResponse.callFromCore(CAPABILITY, "send", { text: "hello" })).error.code,
    "response_schema_invalid",
  );
});

test("broker reports provider lifecycle and requires selection when ambiguous", async () => {
  const broker = configuredBroker();
  broker.replaceModProviders([
    {
      manifest: { ...manifest("example.chat"), provides: [CAPABILITY] },
      getStatus: () => ({ lifecycle: "active", ok: true }),
      request: async () => ({ ok: true, value: { sent: true } }),
    },
  ]);
  assert.equal(
    (await broker.callFromCore(CAPABILITY, "send", { text: "hello" })).error.code,
    "provider_ambiguous",
  );
  const selected = await broker.callFromCore(
    CAPABILITY,
    "send",
    { text: "hello" },
    { providerId: "example.chat" },
  );
  assert.equal(selected.ok, true);

  const disabled = configuredBroker({
    getStatus: () => ({ enabled: false, healthy: false }),
  });
  assert.equal(
    (await disabled.callFromCore(CAPABILITY, "send", { text: "hello" })).error.code,
    "provider_disabled",
  );
});

test("broker enforces requester concurrency and deadlines without retaining payloads", async () => {
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const broker = configuredBroker({
    invoke: async () => {
      await blocker;
      return { sent: true };
    },
  });
  const first = broker.callFromMod(
    manifest(),
    CAPABILITY,
    "send",
    { text: "secret-message" },
    { timeoutMs: 1000 },
  );
  const busy = await broker.callFromMod(manifest(), CAPABILITY, "send", {
    text: "second",
  });
  assert.equal(busy.error.code, "broker_busy");
  release();
  assert.equal((await first).ok, true);
  assert.equal(JSON.stringify(broker.getStatus()).includes("secret-message"), false);

  const hanging = configuredBroker({
    invoke: async () => await new Promise(() => {}),
  });
  assert.equal(
    (await hanging.callFromCore(CAPABILITY, "send", { text: "hello" }, { timeoutMs: 10 })).error
      .code,
    "broker_timeout",
  );
});

test("broker rejects unknown contracts and invalid provider responses safely", () => {
  const broker = createBroker();
  assert.throws(
    () => broker.registerContract({ capability: "bad", methods: {} }),
    /invalid_capability_contract/,
  );
  assert.throws(
    () =>
      broker.registerHostProvider({
        providerId: "ravelink.chat",
        capability: CAPABILITY,
        invoke() {},
      }),
    /invalid_host_provider/,
  );
});

test("broker validates and rate-limits lifecycle-aware event fanout", async () => {
  const broker = createBroker({ now: () => 1000 });
  broker.registerContract({
    capability: "song.queue.v1",
    methods: {},
    events: {
      changed: { validatePayload: (value) => Number.isInteger(value?.size) },
    },
  });
  const received = [];
  broker.replaceModProviders([
    {
      manifest: {
        ...manifest("example.listener", ["song.queue.v1?"]),
        provides: [],
      },
      getStatus: () => ({ lifecycle: "active", ok: true }),
      request: async () => ({ ok: false }),
      event: (capability, name, payload) => {
        received.push({ capability, name, payload });
        return true;
      },
    },
  ]);
  assert.equal(
    (await broker.publishFromCore("song.queue.v1", "changed", { wrong: true })).error.code,
    "event_schema_invalid",
  );
  assert.equal(
    (await broker.publishFromCore("song.queue.v1", "changed", { size: 2 })).delivered,
    1,
  );
  assert.equal(received.length, 1);
  for (let index = 0; index < 29; index += 1)
    await broker.publishFromCore("song.queue.v1", "changed", { size: index });
  assert.equal(
    (await broker.publishFromCore("song.queue.v1", "changed", { size: 31 })).error.code,
    "event_rate_exceeded",
  );
  assert.equal(JSON.stringify(broker.getStatus()).includes('"size"'), false);
});
