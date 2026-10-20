const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createOutput = require("../src/domains/fixtures/fixture-output-runtime");
const createEffects = require("../src/domains/twitch/twitch-light-effects.service");
const createProfiles = require("../src/domains/fixtures/lighting-profile.service");
const createPreview = require("../src/domains/colors/taught-color-preview.service");
const createHue = require("../src/adapters/brands/hue-bridge.adapter");
const flush = () => new Promise((resolve) => setImmediate(resolve));
test("already-correct off Hue state is verified without an unnecessary restore write", async (t) => {
  const baseline = { on: false, bri: 120, ct: 350, transitiontime: 0 };
  let state = { ...baseline },
    restores = 0;
  const output = createOutput({
    fixtureRegistry: {
      listConfigured: () => [{ id: "h", brand: "hue", enabled: true }],
      subscribe: () => () => {},
    },
    adapters: {
      hue: {
        readState: async () => ({ ok: true, state: { ...state } }),
        sendState: async () => ({ sent: 1, failed: 0 }),
        restoreState: async (rows, value) => {
          restores++;
          state = { ...value };
          return { sent: 1, failed: 0 };
        },
      },
    },
  });
  t.after(() => output.shutdown());
  let lease = await output.ownership.acquire({ fixtureId: "h", kind: "effect", owner: "scene" });
  await output.ownership.write(lease.token, { on: false });
  assert.equal((await output.ownership.release(lease.token)).failed, 0);
  assert.equal(restores, 0);
  lease = await output.ownership.acquire({ fixtureId: "h", kind: "effect", owner: "scene" });
  state = { ...baseline, bri: 60 };
  await output.ownership.release(lease.token);
  assert.equal(restores, 1, "a real mismatch must still be restored");
  assert.deepEqual(state, baseline);
});
function gate() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-output-"));
  let at = 1000;
  let rows = [
    { id: "hue", brand: "hue", enabled: true, engineEnabled: true, twitchEnabled: true },
    { id: "effects-only", brand: "wiz", enabled: true, engineEnabled: false, twitchEnabled: true },
    { id: "govee", brand: "govee", enabled: true, engineEnabled: true, twitchEnabled: true },
  ];
  const states = new Map([
    ["hue", { on: false, bri: 180, ct: 350, effect: "none" }],
    ["effects-only", { on: true, dimming: 35, sceneId: 4, speed: 20 }],
    ["govee", { on: true, dimming: 50, r: 1, g: 2, b: 3 }],
  ]);
  const calls = [],
    listeners = new Set(),
    intervals = new Set();
  const registry = {
    getFixtures: () => structuredClone(rows),
    listConfigured: () => rows.filter((row) => row.enabled),
    listEngineBy: () => rows.filter((row) => row.enabled && row.engineEnabled),
    listTwitchBy: () => rows.filter((row) => row.enabled && row.twitchEnabled),
    listCustomBy: () => [],
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const adapters = Object.fromEntries(
    ["hue", "wiz", "govee"].map((brand) => [
      brand,
      {
        ...(brand !== "govee"
          ? {
              readState: async (fixture) => {
                calls.push({ kind: "read", id: fixture.id });
                return overrides.read
                  ? overrides.read(fixture, structuredClone(states.get(fixture.id)))
                  : { ok: true, state: structuredClone(states.get(fixture.id)) };
              },
            }
          : {}),
        sendState: async ([fixture], state) => {
          calls.push({
            kind: "write",
            id: fixture.id,
            state: structuredClone(state),
            fixture: structuredClone(fixture),
          });
          await overrides.write?.(fixture, state);
          states.set(fixture.id, structuredClone(state));
          return { sent: 1, failed: 0 };
        },
        restoreState: async ([fixture], state) => {
          calls.push({ kind: "restore", id: fixture.id, state: structuredClone(state) });
          states.set(fixture.id, structuredClone(state));
          return { sent: 1, failed: 0 };
        },
      },
    ]),
  );
  const output = createOutput({ fixtureRegistry: registry, adapters, now: () => at });
  const directiveService = {
    parseTwitchColorDirective: () => ({
      ok: true,
      hex: "#ff0000",
      hueState: { on: true, bri: 127, xy: [0.1, 0.2] },
      wizState: { on: true, dimming: 50, r: 255, g: 0, b: 0 },
    }),
  };
  const effects = createEffects({
    storePath: path.join(root, "effects.json"),
    fixtureRegistry: registry,
    directiveService,
    adapters: output.adapters,
    outputOwnership: output.ownership,
    now: () => at,
    lightingLab: {
      settings: () => ({
        brightnessLimit: 80,
        durationSeconds: 0,
        repeatCount: 0,
        cooldownSeconds: 0,
        restorePrevious: true,
      }),
      isExcluded: (id) => overrides.excluded?.has(id),
    },
    setInterval: (fn) => {
      intervals.add(fn);
      return fn;
    },
    clearInterval: (fn) => intervals.delete(fn),
  });
  effects.save({ ...effects.snapshot(), enabled: true, fixtureIds: rows.map((row) => row.id) });
  t.after(async () => {
    await effects.shutdown();
    await output.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    registry,
    output,
    effects,
    states,
    calls,
    intervals,
    directiveService,
    advance(ms) {
      at += ms;
      return effects.tick();
    },
    now: () => at,
    change(fn) {
      rows = fn(rows);
      for (const listener of listeners) listener();
    },
  };
}

test("Core effect frames, static writes and profile application share one actual fixture lane", async (t) => {
  const hold = gate(),
    started = gate();
  let block = true;
  const e = harness(t, {
    write: async (fixture) => {
      if (fixture.id === "hue" && block) {
        block = false;
        started.resolve();
        await hold.promise;
      }
    },
  });
  const start = e.effects.handle("cycle red, blue", { fixtureIds: ["hue", "effects-only"] });
  await started.promise;
  const profile = createProfiles({
    storePath: path.join(e.root, "profiles.json"),
    fixtureRegistry: e.registry,
    directiveService: e.directiveService,
    adapters: e.output.adapters,
    twitchLightEffects: e.effects,
  });
  assert.equal(
    profile.save({
      id: "white",
      name: "White",
      strategy: "individual",
      fixtureTargets: { hue: { mode: "temperature", temperatureKelvin: 3000, brightness: 55 } },
    }).ok,
    true,
  );
  const apply = profile.apply("white");
  await flush();
  assert.equal(e.calls.filter((row) => row.kind === "write" && row.id === "hue").length, 1);
  hold.resolve();
  await start;
  assert.equal((await apply).sent, 1);
  await flush();
  assert.deepEqual(e.states.get("effects-only"), { on: true, dimming: 35, sceneId: 4, speed: 20 });
  assert.equal(e.states.get("hue").ct, 333);
  await e.advance(5000);
  await flush();
  assert.equal(e.states.get("hue").ct, 333, "old effect cannot reclaim the profile target");
  assert.equal(e.output.ownership.snapshot().fixtures.length, 0);
});

test("explicit music selection can own a configured fixture with every other program route off", async (t) => {
  const e = harness(t);
  e.change((rows) =>
    rows.map((row) => ({
      ...row,
      engineEnabled: false,
      twitchEnabled: false,
      customEnabled: false,
    })),
  );
  const baseline = structuredClone(e.states.get("hue"));
  const lease = await e.output.ownership.acquire({
    fixtureId: "hue",
    owner: "music.only",
    kind: "music",
  });
  await e.output.ownership.write(lease.token, { on: true, bri: 50 }, { sampledAt: e.now() });
  assert.equal(e.states.get("hue").on, true);
  await e.output.ownership.releaseOwner("music.only");
  assert.deepEqual(e.states.get("hue"), baseline);
  assert.equal(
    e.calls.some((call) => call.id === "effects-only"),
    false,
  );
});

test("temporary effects resume the latest music intent and Stop restores native off/white state", async (t) => {
  const e = harness(t),
    baseline = structuredClone(e.states.get("hue"));
  const music = await e.output.ownership.acquire({
    fixtureId: "hue",
    owner: "music.test",
    kind: "music",
  });
  await e.output.ownership.write(music.token, { on: true, bri: 40 }, { sampledAt: e.now() });
  assert.equal((await e.effects.handle("cycle red, blue", { fixtureIds: ["hue"] })).sent, 1);
  assert.equal(
    (await e.output.ownership.write(music.token, { on: true, bri: 90 }, { sampledAt: e.now() }))
      .suspended,
    true,
  );
  await e.effects.handle("stop", { fixtureIds: ["hue"] });
  await flush();
  assert.deepEqual(e.states.get("hue"), { on: true, bri: 90 });
  await e.output.ownership.release(music.token);
  assert.deepEqual(e.states.get("hue"), baseline);
});

test("rapid replacement during native capture preserves the original baseline and fences the first owner", async (t) => {
  let reads = 0;
  const read = gate(),
    e = harness(t, {
      read: (fixture, state) => (++reads === 1 ? read.promise : { ok: true, state }),
    });
  const first = e.effects.handle("cycle red, blue", { fixtureIds: ["hue"] });
  await flush();
  const second = e.effects.handle("cycle green, blue", { fixtureIds: ["hue"] });
  read.resolve({ ok: true, state: { on: false, bri: 180, ct: 350, effect: "none" } });
  assert.equal((await first).ok, false);
  assert.equal((await second).sent, 1);
  assert.equal(
    e.effects.snapshot().diagnostics.faultCount,
    0,
    "expected reservation replacement is not a device fault",
  );
  assert.equal(e.calls.filter((row) => row.kind === "read").length, 1);
  await e.effects.shutdown();
  assert.deepEqual(e.states.get("hue"), { on: false, bri: 180, ct: 350, effect: "none" });
  assert.equal(e.intervals.size, 0);
});

test("unavailable native reads block effects, while manual alpha-Govee commands stay available", async (t) => {
  const e = harness(t, { read: async () => ({ ok: false }) });
  const result = await e.effects.handle("cycle red, blue", { fixtureIds: ["hue", "govee"] });
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.equal(
    e.calls.some((row) => row.kind === "write"),
    false,
  );
  assert.equal(
    e.effects.snapshot().diagnostics.faultCount,
    2,
    "real admission failures are counted once per current fixture",
  );
  assert.equal((await e.output.adapters.govee.sendState([{ id: "govee" }], { on: false })).sent, 1);
  assert.equal(e.output.ownership.snapshot().fixtures.length, 0);
});

test("facades use current registry targets; route/transport changes invalidate outstanding leases", async (t) => {
  const e = harness(t);
  const music = await e.output.ownership.acquire({
    fixtureId: "hue",
    owner: "music.test",
    kind: "music",
  });
  e.change((rows) => rows.map((row) => (row.id === "hue" ? { ...row, ip: "192.0.2.42" } : row)));
  assert.equal(e.output.ownership.has(music.token), false);
  await e.output.adapters.hue.sendState([{ id: "hue", ip: "192.0.2.99", username: "not-used" }], {
    on: false,
  });
  const sent = e.calls.find((row) => row.kind === "write");
  assert.equal(sent.fixture.ip, "192.0.2.42");
  assert.equal(sent.fixture.username, undefined);
  assert.equal((await e.output.adapters.wiz.sendState([{ id: "hue" }], { on: true })).failed, 1);
  e.change((rows) => rows.map((row) => ({ ...row, enabled: false })));
  assert.equal((await e.output.adapters.hue.sendState([{ id: "hue" }], { on: true })).failed, 1);
});

test("taught previews restore physical state and a late preview timer cannot undo a manual command", async (t) => {
  const e = harness(t),
    callbacks = [];
  const preview = createPreview({
    colorCommandService: { applyColorText: async () => ({ ok: true, targets: ["hue"] }) },
    directiveService: e.directiveService,
    fixtureRegistry: e.registry,
    outputOwnership: e.output.ownership,
    setTimeout: (fn) => {
      callbacks.push(fn);
      return { unref() {} };
    },
    clearTimeout: () => {},
  });
  t.after(() => preview.shutdown());
  assert.equal((await preview.preview("#ff0000")).scheduled, true);
  callbacks.shift()();
  await flush();
  assert.deepEqual(e.states.get("hue"), { on: false, bri: 180, ct: 350, effect: "none" });
  await preview.preview("#ff0000");
  await e.output.adapters.hue.sendState([{ id: "hue" }], { on: true, bri: 77, ct: 400 });
  callbacks.shift()();
  await flush();
  assert.deepEqual(e.states.get("hue"), { on: true, bri: 77, ct: 400 });
});

test("failed initial effect delivery is reported and releases its lease", async (t) => {
  const e = harness(t, {
    write: async () => {
      throw new Error("offline");
    },
  });
  const result = await e.effects.handle("cycle red, blue", { fixtureIds: ["hue"] });
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  await flush();
  assert.deepEqual(e.effects.snapshot().activeFixtureIds, []);
  assert.equal(e.output.ownership.snapshot().fixtures.length, 0);
});

test("duplicate registry aliases cannot open independent lanes for one physical bulb", async (t) => {
  const e = harness(t);
  e.change((rows) =>
    rows.map((row) => (row.id === "hue" ? { ...row, bridgeIp: "192.0.2.1", lightId: 1 } : row)),
  );
  const grant = await e.output.ownership.acquire({
    fixtureId: "hue",
    owner: "music.test",
    kind: "music",
  });
  e.change((rows) => [...rows, { ...rows[0], id: "duplicate" }]);
  assert.equal(e.output.ownership.has(grant.token), false);
  assert.equal(
    (await e.output.adapters.hue.sendState([{ id: "hue" }, { id: "duplicate" }], { on: true }))
      .failed,
    2,
  );
  assert.equal(e.output.diagnostics().ambiguousFixtures, 2);
  assert.equal(
    e.calls.some((row) => row.kind === "write"),
    false,
  );
});

test("unprepared fixture-scoped Hue stays on REST until Entertainment preheat", async () => {
  let streams = 0;
  const adapter = createHue({
    dryRun: false,
    fixtureScoped: true,
    axios: {
      put: async (_url, state) => ({
        data: Object.entries(state).map(([key, value]) => ({
          success: { [`/lights/1/state/${key}`]: value },
        })),
      }),
    },
    log: { info() {}, warn() {} },
    createHueEntertainmentRuntime: () => ({
      sendFrame: async () => {
        streams++;
        return { ok: true };
      },
      stopAll: async () => {},
      getStatus: () => ({ available: true }),
      reconcileConfigs: async () => {},
    }),
  });
  adapter.setTransportMode("entertainment");
  const rows = [
    {
      id: "hue",
      brand: "hue",
      bridgeIp: "192.0.2.1",
      username: "a".repeat(40),
      clientKey: "b".repeat(32),
      lightId: 1,
      entertainmentAreaId: "area",
      bridgeId: "bridge",
      extras: { hueBridgeCapabilities: { supportsEntertainment: true } },
    },
  ];
  assert.equal(
    adapter.syncTransportForFixtures(rows).entertainment.reason,
    "entertainment_preheat_required",
  );
  assert.equal((await adapter.sendState(rows, { on: false, bri: 80, ct: 350 })).sent, 1);
  assert.equal(streams, 0);
  assert.equal(adapter.getTelemetry().transportActive, "rest");
  await adapter.shutdown();
});

test("governed Hue rejects HTTP-200 errors and incomplete field acknowledgements", async () => {
  const fixture = {
    id: "hue",
    brand: "hue",
    bridgeIp: "192.0.2.1",
    username: "a".repeat(40),
    lightId: 1,
    extras: { hueBridgeCapabilities: { supportsEntertainment: false, forceHttp: true } },
  };
  for (const data of [
    undefined,
    [{ error: { type: 201 } }],
    [{ success: { "/lights/1/state/on": true } }],
  ]) {
    let requests = 0;
    const adapter = createHue({
      dryRun: false,
      fixtureScoped: true,
      log: { info() {}, warn() {} },
      axios: {
        put: async () => {
          requests++;
          return { status: 200, data };
        },
      },
    });
    const result = await adapter.sendState([fixture], { on: true, bri: 120 });
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 1);
    assert.equal(requests, 1, "a rejected/partial request is not retried as a network failure");
    await adapter.shutdown();
  }
});
