const test = require("node:test");
const assert = require("node:assert/strict");
const createAdapter = require("../src/adapters/brands/govee-lan.adapter");
const { createSimulator } = require("./support/govee-lan-simulator.cjs");

async function lab(t) {
  const sim = await createSimulator();
  t.after(() => sim.close());
  const adapter = createAdapter({
    dryRun: false,
    dgramRef: sim.transport,
    osRef: { networkInterfaces: () => ({}) },
    log: { warn() {} },
  });
  return { sim, adapter, fixtures: sim.fixtures() };
}

test("Govee UDP peer is discovered, deduplicated and probed without contacting a physical LAN", async (t) => {
  const { sim, adapter, fixtures } = await lab(t);
  sim.faults(fixtures[0].id, { duplicate: true });
  const result = await adapter.discoverDevices({ timeoutMs: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.devices.length, 2);
  assert.deepEqual(
    new Set(result.devices.map((row) => row.ip)),
    new Set(fixtures.map((row) => row.ip)),
  );
  for (const fixture of fixtures) {
    const read = await adapter.probeDevice(fixture, { timeoutMs: 300 });
    assert.equal(read.ok, true);
    assert.equal(read.state.brightness, 37);
    assert.deepEqual(read.state.color, { r: 25, g: 90, b: 160 });
  }
});

test("Govee UDP peer applies RGB, white, brightness limits, off and independent fixture targets", async (t) => {
  const { sim, adapter, fixtures } = await lab(t);
  const [rgbw, rgb] = fixtures;
  adapter.sendState([rgbw], { on: true, dimming: 63, r: 12, g: 34, b: 56 });
  await sim.waitFor(() => sim.snapshot(rgbw.id).color.b === 56);
  assert.equal(sim.snapshot(rgbw.id).brightness, 63);
  assert.equal(sim.snapshot(rgb.id).brightness, 37);
  adapter.sendState([rgbw], { on: true, dimming: 999, temp: 99999 });
  await sim.waitFor(() => sim.snapshot(rgbw.id).colorTemInKelvin === 9000);
  assert.equal(sim.snapshot(rgbw.id).brightness, 100);
  adapter.sendState([rgbw], { on: true, dimming: -10, temp: 1 });
  await sim.waitFor(() => sim.snapshot(rgbw.id).colorTemInKelvin === 2000);
  assert.equal(sim.snapshot(rgbw.id).brightness, 1);
  adapter.sendState([rgbw], { on: false, dimming: 90, r: 255, g: 255, b: 255 });
  await sim.waitFor(() => sim.snapshot(rgbw.id).onOff === 0);
  assert.equal(sim.snapshot(rgbw.id).brightness, 1);
  adapter.sendState(fixtures, { on: true, dimming: 48, r: -2, g: 999, b: 32.8 });
  await sim.waitFor(() => fixtures.every((row) => sim.snapshot(row.id).color.b === 33));
  for (const fixture of fixtures)
    assert.deepEqual(sim.snapshot(fixture.id).color, { r: 0, g: 255, b: 33 });
  assert(sim.history().every((row) => row.accepted));
});

test("Govee UDP peer times out on silence/malformed data and recovers after reconnect", async (t) => {
  const { sim, adapter, fixtures } = await lab(t);
  const fixture = fixtures[0];
  for (const fault of [
    { offline: true },
    { offline: false, malformed: true },
    { malformed: false, dropReplies: true },
  ]) {
    sim.faults(fixture.id, fault);
    assert.equal(
      (await adapter.probeDevice(fixture, { timeoutMs: 300 })).error,
      "govee_probe_timeout",
    );
  }
  sim.faults(fixture.id, { dropReplies: false });
  assert.equal((await adapter.probeDevice(fixture, { timeoutMs: 300 })).reachable, true);
});

test("Govee status cannot turn an empty or invalid reply into a reachable black/off fixture", async (t) => {
  const { sim, adapter, fixtures } = await lab(t);
  for (const statusOverride of [
    {},
    { onOff: 7, brightness: 50, color: { r: 1, g: 2, b: 3 } },
    { onOff: 1, brightness: "loud", color: {} },
  ]) {
    sim.faults(fixtures[0].id, { statusOverride });
    assert.equal((await adapter.probeDevice(fixtures[0], { timeoutMs: 300 })).ok, false);
  }
});

test("Govee concurrent probes share the response port without losing either device reply", async (t) => {
  const { sim, adapter, fixtures } = await lab(t);
  fixtures.forEach((row) => sim.faults(row.id, { delayMs: 15 }));
  const results = await Promise.all(
    fixtures.map((fixture) => adapter.probeDevice(fixture, { timeoutMs: 300 })),
  );
  assert(
    results.every((row) => row.ok),
    JSON.stringify(results),
  );
});

test("Govee malformed addressing never leaves the simulator or becomes a hostname lookup", async (t) => {
  const { sim, adapter } = await lab(t);
  const addresses = [
    "1..3.4",
    "127.0.0.01",
    "localhost",
    "1e2.0.0.1",
    "0x7f.0.0.1",
    "127.0.0.256",
    "127.0.0.1:4003",
    "::1",
  ];
  for (const ip of addresses) {
    assert.equal(adapter.sendState([{ ip }], { on: false }).failed, 1, ip);
    assert.equal((await adapter.probeDevice({ ip })).error, "invalid_govee_target_ip", ip);
  }
  assert.equal(sim.history().length, 0);
});

test("Govee white status, power-off state and brightness zero are preserved without invented RGB", async (t) => {
  const { sim, adapter, fixtures } = await lab(t);
  sim.faults(fixtures[0].id, {
    statusOverride: {
      onOff: 0,
      brightness: 0,
      color: { r: 0, g: 0, b: 0 },
      colorTemInKelvin: 4200,
    },
  });
  assert.deepEqual((await adapter.probeDevice(fixtures[0])).state, {
    on: false,
    brightness: 0,
    color: { r: 0, g: 0, b: 0 },
    temp: 4200,
  });
});

test("Govee status rejects wrong-source, oversized, out-of-range and coercible replies", async (t) => {
  const { sim, adapter, fixtures } = await lab(t);
  const state = sim.snapshot(fixtures[0].id);
  const cases = [
    { sourceIp: fixtures[1].ip },
    { sourceIp: null, statusOverride: { ...state, padding: "x".repeat(9000) } },
    { statusOverride: { ...state, brightness: 101 } },
    { statusOverride: { ...state, onOff: "1" } },
    { statusOverride: { ...state, color: { r: -1, g: 0, b: 0 } } },
    { statusOverride: { ...state, colorTemInKelvin: 100000 } },
  ];
  for (const fault of cases) {
    sim.faults(fixtures[0].id, fault);
    assert.equal(
      (await adapter.probeDevice(fixtures[0], { timeoutMs: 300 })).error,
      "govee_probe_timeout",
    );
  }
});

test("Govee discovery ignores a peer advertising another address or an invalid model", async (t) => {
  const { sim, adapter, fixtures } = await lab(t);
  for (const scanOverride of [
    { ip: fixtures[1].ip, device: "SIM-REDIRECT", sku: "H6008" },
    { ip: fixtures[0].ip, device: "SIM-MALFORMED", sku: "not-a-model" },
  ]) {
    sim.faults(fixtures[0].id, { scanOverride });
    const result = await adapter.discoverDevices({ timeoutMs: 300 });
    assert.deepEqual(
      result.devices.map((row) => row.ip),
      [fixtures[1].ip],
    );
  }
});

test("Govee RGB-only peer rejects unsupported white while retaining its last color", async (t) => {
  const { sim, adapter, fixtures } = await lab(t);
  const fixture = fixtures[1],
    original = sim.snapshot(fixture.id).color;
  adapter.sendState([fixture], { on: true, dimming: 55, temp: 4000 });
  await sim.waitFor(() => sim.history().some((row) => row.command === "colorwc"));
  assert.deepEqual(sim.snapshot(fixture.id).color, original);
  assert.equal(sim.history().find((row) => row.command === "colorwc").accepted, false);
  assert.deepEqual((await adapter.probeDevice(fixture)).state.color, original);
});

test("Govee shutdown cancels active and queued reads, bounds overload, and rejects later writes", async (t) => {
  const { sim, adapter, fixtures } = await lab(t);
  sim.faults(fixtures[0].id, { offline: true });
  const reads = Array.from({ length: 65 }, () =>
    adapter.probeDevice(fixtures[0], { timeoutMs: 5000 }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  adapter.shutdown();
  const results = await Promise.all(reads);
  assert.equal(results.filter((row) => row.error === "govee_receiver_busy").length, 1);
  assert.equal(results.filter((row) => row.error === "govee_adapter_stopped").length, 64);
  assert.equal(adapter.getTelemetry().resources.pendingReceivers, 0);
  assert.equal(adapter.sendState(fixtures, { on: true }).sent, 0);
  assert.equal((await adapter.discoverDevices()).error, "govee_adapter_stopped");
});

test("Govee color and brightness sweep follows 128 measured command sequences", async (t) => {
  const { sim, adapter, fixtures } = await lab(t);
  let seed = 982451653;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const bound = (value, min, max) => Math.round(Math.max(min, Math.min(max, value)));
  for (let sample = 0; sample < 128; sample++) {
    const fixture = fixtures[sample % fixtures.length];
    const state = {
      on: true,
      dimming: (next() % 160) - 30,
      r: (next() % 400) - 70,
      g: (next() % 400) - 70,
      b: (next() % 400) - 70,
    };
    const before = sim.history().length;
    adapter.sendState([fixture], state);
    await sim.waitFor(() => sim.history().length >= before + 3);
    const actual = sim.snapshot(fixture.id);
    assert.equal(actual.brightness, bound(state.dimming, 1, 100));
    assert.deepEqual(actual.color, {
      r: bound(state.r, 0, 255),
      g: bound(state.g, 0, 255),
      b: bound(state.b, 0, 255),
    });
  }
});

test("Govee dry-run reports planned writes without changing either UDP peer", async (t) => {
  const { sim, fixtures } = await lab(t);
  const adapter = createAdapter({ dryRun: true, dgramRef: sim.transport });
  assert.equal(adapter.sendState(fixtures, { on: false }).dryRun, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sim.history().length, 0);
  assert(fixtures.every((fixture) => sim.snapshot(fixture.id).onOff === 1));
});
