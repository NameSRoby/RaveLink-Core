const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createEffects = require("../src/domains/twitch/twitch-light-effects.service");

function setup(t, labOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-effects-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtures = [
    { id: "old-hue", name: "Old Hue", brand: "hue", twitchEnabled: true },
    { id: "desk-wiz", name: "Desk WiZ", brand: "wiz", twitchEnabled: true },
    {
      id: "shelf-govee",
      name: "Shelf Govee",
      brand: "govee",
      twitchEnabled: true,
    },
  ];
  const calls = [];
  let at = 1000,
    interval = null;
  const colors = {
    red: "#ff0000",
    green: "#00ff00",
    blue: "#0000ff",
    cyan: "#00ffff",
    purple: "#8000ff",
    "deep blue": "#001080",
  };
  const labSettings = {
    brightnessLimit: 100,
    durationSeconds: 0,
    repeatCount: 0,
    cooldownSeconds: 0,
    restorePrevious: false,
    spatialDirection: "left-right",
    spatialOriginFixtureId: "",
    chaseGapMs: 250,
    ...labOverrides,
  };
  const defaultAdapters = {
    hue: {
      sendState: async (rows, state) => calls.push({ brand: "hue", rows, state }),
      getTelemetry: () => ({
        entertainment: { reason: "entertainment_temporarily_suppressed" },
      }),
    },
    wiz: {
      sendState: async (rows, state) => calls.push({ brand: "wiz", rows, state }),
    },
    govee: {
      sendState: async (rows, state) => calls.push({ brand: "govee", rows, state }),
    },
  };
  const service = createEffects({
    storePath: path.join(root, "effects.json"),
    fixtureRegistry: { listTwitchBy: () => fixtures },
    directiveService: {
      parseTwitchColorDirective: (text) =>
        colors[text] ? { ok: true, hex: colors[text] } : { ok: false },
    },
    adapters: { ...defaultAdapters, ...(labOverrides.adapters || {}) },
    ...(labOverrides.lightingLayout ? { lightingLayout: labOverrides.lightingLayout } : {}),
    lightingLab: {
      settings: () => ({ ...labSettings }),
      isExcluded: (id) => (labOverrides.excludedFixtureIds || []).includes(id),
      latencyFor: (id) => Number(labOverrides.latencyOffsets?.[id] || 0),
      previousState: (id) => labOverrides.previousStates?.[id] || null,
      record() {},
    },
    now: () => at,
    setInterval: (fn) => {
      interval = fn;
      return { unref() {} };
    },
    clearInterval: () => {
      interval = null;
    },
    ...(labOverrides.setTimeout ? { setTimeout: labOverrides.setTimeout } : {}),
    ...(labOverrides.clearTimeout ? { clearTimeout: labOverrides.clearTimeout } : {}),
    ...(labOverrides.shutdownWaitMs ? { shutdownWaitMs: labOverrides.shutdownWaitMs } : {}),
  });
  return {
    service,
    calls,
    fixtures,
    advance(ms) {
      at += ms;
      return service.tick();
    },
    interval: () => interval,
  };
}

test("viewer library commands can save during active Rave without replacing it or granting output", async (t) => {
  const { service, calls } = setup(t);
  const submissions = [];
  let stopped = 0;
  service.setMusicHandler({
    ids: () => ["desk-wiz"],
    stop: async () => {
      stopped++;
    },
    save: async (command) => {
      submissions.push(command);
      return { ok: true, effect: command.type, targets: [], sent: 0, failed: 0 };
    },
  });
  assert(service.isRaveLibraryCommand("rave save Neon Storm"));
  assert.equal(service.parse("rave remember Artist - Any song").value, "Artist - Any song");
  assert.equal((await service.handle("rave save Neon Storm")).ok, true);
  assert.equal((await service.handle("rave remember https://tidal.com/track/123")).ok, true);
  assert.equal(submissions.length, 2);
  assert.equal(stopped, 0);
  assert.equal(calls.length, 0);
  await service.handle("rave save Preview", { preview: true });
  assert.equal(submissions.length, 2);
  assert.equal((await service.handle("rave red")).error, "music_rave_active");
});

test("dynamic effect parser supports the approved language and does not claim excluded ideas", (t) => {
  const { service } = setup(t);
  for (const command of [
    "cycle red, green, blue",
    "fade red, blue slow",
    "alternate red, blue fast",
    "breathe deep blue",
    "rainbow",
    "wave red, green, blue",
    "sweep cyan, purple",
    "ripple red, blue",
    "chase red, green, blue",
    "rave",
    "rave red, green, blue aggressive",
    "stop",
  ]) {
    const parsed = service.parse(command);
    assert.equal(parsed.matched, true, command);
    assert.equal(parsed.ok, true, command);
  }
  assert.equal(service.parse("sunrise").matched, false);
  assert.equal(service.parse("random warm colors").matched, false);
  assert.equal(service.parse("alternate red, green, blue").ok, false);
  assert.equal(service.parse("alternate red, blue").type, "cycle");
  assert.equal(service.snapshot().supportedCommands.includes("alternate"), false);
});

test("rave uses dynamic admission and rejects replacement until an explicit stop", async (t) => {
  const { service } = setup(t, { durationSeconds: 12, brightnessLimit: 35 });
  service.save({
    revision: 0,
    enabled: true,
    fixtureIds: ["old-hue", "desk-wiz"],
    prefixes: { "old-hue": "desk" },
  });
  const starts = [],
    stops = [];
  let ids = [];
  service.setMusicHandler({
    check: () => true,
    start: async (request) => {
      starts.push(request);
      ids = request.fixtureIds;
      return { ok: true, targets: ids };
    },
    stop: async (targets) => {
      stops.push(targets);
      ids = [];
    },
    ids: () => ids,
  });
  const route = service.resolve("desk rave red, blue fast");
  const result = await service.handle(route.text, { fixtureIds: route.fixtureIds });
  assert.equal(result.ok, true);
  assert.deepEqual(starts[0], {
    fixtureIds: ["old-hue"],
    palette: ["#ff0000", "#0000ff"],
    feel: "fast",
    brightnessLimit: 35,
    seconds: 12,
  });
  assert.ok(service.snapshot().activeFixtureIds.includes("old-hue"));
  const refused = await service.handle("cycle red, blue", { fixtureIds: ["old-hue"] });
  assert.equal(refused.error, "music_rave_active");
  assert.equal(refused.refundRecommended, true);
  assert.equal(stops.length, 0);
  assert.deepEqual(ids, ["old-hue"]);
  const repeated = await service.handle("rave green, blue", { fixtureIds: ["old-hue"] });
  assert.equal(repeated.error, "music_rave_active");
  assert.equal(starts.length, 1);
  await service.handle("rave stop", { fixtureIds: ["desk-wiz"] });
  assert.deepEqual(stops.at(-1), ["old-hue"]);
  await service.shutdown();
});

test("Rave admission protects asynchronous startup and rejected requests cannot supersede it", async (t) => {
  const { service } = setup(t);
  service.save({ revision: 0, enabled: true, fixtureIds: ["old-hue"], prefixes: {} });
  let admit,
    ids = [];
  service.setMusicHandler({
    check: () =>
      new Promise((resolve) => {
        admit = resolve;
      }),
    start: async () => {
      ids = ["old-hue"];
      return { ok: true, targets: ids };
    },
    stop: async () => {
      ids = [];
    },
    ids: () => ids,
  });
  const pending = service.handle("rave", { fixtureIds: ["old-hue"] });
  assert.equal(service.isRaveActive(), true);
  for (const text of ["rave", "cycle red, blue", "rainbow"]) {
    const blocked = await service.handle(text, { fixtureIds: ["old-hue"] });
    assert.equal(blocked.refundRecommended, true);
  }
  admit();
  assert.equal((await pending).ok, true);
  assert.deepEqual(ids, ["old-hue"]);
  await service.handle("stop", { fixtureIds: ["old-hue"] });
  assert.equal(service.isRaveActive(), false);
});
test("a rejected rave does not cancel an already active dynamic effect", async (t) => {
  const { service } = setup(t);
  service.save({ revision: 0, enabled: true, fixtureIds: ["old-hue"], prefixes: {} });
  await service.handle("cycle red, blue", { fixtureIds: ["old-hue"] });
  service.setMusicHandler({
    check: () => {
      throw Error("music_capture_permission_required");
    },
    start: () => assert.fail("must not capture"),
    stop: async () => {},
    ids: () => [],
  });
  const result = await service.handle("rave", { fixtureIds: ["old-hue"] });
  assert.equal(result.error, "music_capture_permission_required");
  assert.deepEqual(service.snapshot().activeFixtureIds, ["old-hue"]);
  await service.shutdown();
});

test("dynamic routes use all fixtures by default and shared prefixes select subsets", (t) => {
  const { service } = setup(t);
  const saved = service.save({
    revision: 0,
    enabled: true,
    fixtureIds: ["old-hue", "desk-wiz", "shelf-govee"],
    prefixes: { "old-hue": "desk", "desk-wiz": "desk" },
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(service.resolve("cycle red, blue").fixtureIds, [
    "old-hue",
    "desk-wiz",
    "shelf-govee",
  ]);
  assert.deepEqual(service.resolve("desk fade red, blue").fixtureIds, ["old-hue", "desk-wiz"]);
  assert.deepEqual(service.resolve("all fade red, blue").fixtureIds, [
    "old-hue",
    "desk-wiz",
    "shelf-govee",
  ]);
  assert.deepEqual(service.resolve("all stop").fixtureIds, ["old-hue", "desk-wiz", "shelf-govee"]);
  assert.equal(service.resolve("desk ordinary red").matched, false);
});

test("a static override ends its whole effect session and restores only untargeted siblings", async (t) => {
  const { service, calls } = setup(t, {
    previousStates: {
      "old-hue": { brand: "hue", value: { on: true, bri: 21 } },
      "desk-wiz": {
        brand: "wiz",
        value: { on: true, r: 9, g: 8, b: 7, dimming: 44 },
      },
    },
  });
  service.save({
    revision: 0,
    enabled: true,
    fixtureIds: ["old-hue", "desk-wiz"],
  });
  await service.handle("cycle red, blue", {
    fixtureIds: ["old-hue", "desk-wiz"],
  });
  calls.length = 0;
  const result = service.cancelForStaticTargets(["old-hue"]);
  assert.equal(result.stopped, 2);
  assert.deepEqual(result.restoredFixtureIds, ["desk-wiz"]);
  assert.deepEqual(service.snapshot().activeFixtureIds, []);
  assert.equal(
    calls.some((row) => row.brand === "hue"),
    false,
  );
  assert.deepEqual(calls.find((row) => row.brand === "wiz").state, {
    on: true,
    r: 9,
    g: 8,
    b: 7,
    dimming: 44,
  });
});

test("optional animated return performs a settle pulse before restoring the exact prior state", async (t) => {
  const immediate = (handler) => {
    handler();
    return { unref() {} };
  };
  const { service, calls } = setup(t, {
    setTimeout: immediate,
    previousStates: {
      "desk-wiz": {
        brand: "wiz",
        value: { on: true, r: 3, g: 4, b: 5, dimming: 55 },
      },
    },
  });
  service.save({
    revision: 0,
    enabled: true,
    returnEffect: true,
    fixtureIds: ["desk-wiz"],
  });
  await service.handle("cycle red, blue", { fixtureIds: ["desk-wiz"] });
  calls.length = 0;
  await service.handle("stop", { fixtureIds: ["desk-wiz"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].state.dimming, 18);
  assert.deepEqual(calls.at(-1).state, {
    on: true,
    r: 3,
    g: 4,
    b: 5,
    dimming: 55,
  });
});

test("effects require opt-in, intersect the allowlist, and start from one shared clock", async (t) => {
  const { service, calls, interval, advance } = setup(t);
  assert.equal(
    (await service.handle("cycle red, blue", { fixtureIds: ["old-hue"] })).error,
    "dynamic_light_effects_disabled",
  );
  const saved = service.save({
    revision: 0,
    enabled: true,
    fixtureIds: ["old-hue", "desk-wiz"],
  });
  assert.equal(saved.ok, true);
  const result = await service.handle("fade red, blue", {
    fixtureIds: ["old-hue", "shelf-govee"],
  });
  assert.deepEqual(result.targets, ["old-hue"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].brand, "hue");
  assert.equal(calls[0].state.transitiontime, 0);
  assert.equal(calls[0].state.__forceRest, undefined);
  assert.equal(result.synchronized, false);
  assert.equal(result.startsAt, 1000);
  await advance(250);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].state.transitiontime, 0);
  assert.equal(typeof interval(), "function");
  const stopped = await service.handle("stop", { fixtureIds: ["old-hue"] });
  assert.equal(stopped.stopped, 1);
  assert.equal(interval(), null);
});

test("starting another effect replaces fixture ownership and static cancellation is scoped", async (t) => {
  const { service } = setup(t);
  service.save({
    revision: 0,
    enabled: true,
    fixtureIds: ["old-hue", "desk-wiz"],
  });
  await service.handle("cycle red, blue", {
    fixtureIds: ["old-hue", "desk-wiz"],
  });
  await service.handle("breathe green", { fixtureIds: ["desk-wiz"] });
  assert.deepEqual(service.snapshot().activeFixtureIds, ["desk-wiz", "old-hue"]);
  assert.equal(service.cancelFixtureIds(["old-hue"]), 1);
  assert.deepEqual(service.snapshot().activeFixtureIds, ["desk-wiz"]);
  service.shutdown();
  assert.deepEqual(service.snapshot().activeFixtureIds, []);
});

test("mixed-brand cycle fixtures use the same phase boundaries", async (t) => {
  const { service, calls, advance } = setup(t);
  service.save({
    revision: 0,
    enabled: true,
    fixtureIds: ["old-hue", "desk-wiz", "shelf-govee"],
  });
  const result = await service.handle("cycle red, blue", {
    fixtureIds: ["shelf-govee", "old-hue", "desk-wiz"],
  });
  assert.equal(result.synchronized, false);
  assert.equal(
    new Set(
      calls
        .filter((row) => row.brand !== "hue")
        .map((row) => `${row.state.r},${row.state.g},${row.state.b}`),
    ).size,
    1,
  );
  assert.equal(
    calls.some((row) => row.brand === "hue"),
    true,
  );
  calls.length = 0;
  await advance(2400);
  assert.deepEqual(new Set(calls.map((row) => row.brand)), new Set(["hue", "wiz", "govee"]));
  assert.equal(
    new Set(
      calls
        .filter((row) => row.brand !== "hue")
        .map((row) => `${row.state.r},${row.state.g},${row.state.b}`),
    ).size,
    1,
  );
  assert.equal(calls.find((row) => row.brand === "hue").state.transitiontime, 0);
  service.shutdown();
});

test("mixed-brand hard steps use absolute boundaries without relative cadence beat drift", async (t) => {
  const { service, calls, advance } = setup(t);
  service.save({
    revision: 0,
    enabled: true,
    fixtureIds: ["old-hue", "desk-wiz", "shelf-govee"],
  });
  await service.handle("cycle red, blue", {
    fixtureIds: ["old-hue", "desk-wiz", "shelf-govee"],
  });
  calls.length = 0;
  await advance(2399);
  assert.equal(calls.length, 0);
  await advance(1);
  assert.deepEqual(new Set(calls.map((row) => row.brand)), new Set(["hue", "wiz", "govee"]));
  calls.length = 0;
  await advance(2400);
  assert.deepEqual(new Set(calls.map((row) => row.brand)), new Set(["hue", "wiz", "govee"]));
});

test("smooth WiZ sampling catches up to absolute slots instead of drifting from late ticks", async (t) => {
  const { service, calls, advance } = setup(t);
  service.save({ revision: 0, enabled: true, fixtureIds: ["desk-wiz"] });
  await service.handle("fade red, blue", { fixtureIds: ["desk-wiz"] });
  calls.length = 0;
  await advance(760);
  assert.equal(calls.length, 1);
  await advance(239);
  assert.equal(calls.length, 1);
  await advance(1);
  assert.equal(calls.length, 2);
});

test("lab limits cap brightness, stop duration, restore prior state, and enforce cooldown", async (t) => {
  const { service, calls, advance } = setup(t, {
    brightnessLimit: 45,
    durationSeconds: 1,
    cooldownSeconds: 2,
    restorePrevious: true,
    previousStates: {
      "old-hue": { brand: "hue", value: { on: true, bri: 12 } },
    },
  });
  service.save({ revision: 0, enabled: true, fixtureIds: ["old-hue"] });
  const started = await service.handle("cycle red, blue", {
    fixtureIds: ["old-hue"],
  });
  assert.equal(started.ok, true);
  assert.equal(calls[0].state.bri <= 115, true);
  await advance(1600);
  assert.deepEqual(service.snapshot().activeFixtureIds, []);
  assert.equal(
    calls.some((row) => row.state.bri === 12),
    true,
  );
  assert.equal(
    (await service.handle("cycle red, blue", { fixtureIds: ["old-hue"] })).error,
    "no_effect_enabled_fixtures_matched",
  );
});

test("expiration contains return-animation failures instead of rejecting the engine tick", async (t) => {
  let layoutCalls = 0;
  const { service, advance } = setup(t, {
    durationSeconds: 0.001,
    previousStates: {
      "desk-wiz": {
        brand: "wiz",
        value: { on: true, r: 3, g: 4, b: 5, dimming: 55 },
      },
    },
    lightingLayout: {
      spatialOffset() {
        layoutCalls += 1;
        if (layoutCalls > 1)
          throw Object.assign(new Error("layout unavailable"), {
            code: "LAYOUT_DOWN",
          });
        return 0;
      },
    },
  });
  service.save({
    revision: 0,
    enabled: true,
    returnEffect: true,
    fixtureIds: ["desk-wiz"],
  });
  await service.handle("cycle red, blue", { fixtureIds: ["desk-wiz"] });
  await assert.doesNotReject(() => advance(501));
  await new Promise((resolve) => setImmediate(resolve));
  const state = service.snapshot();
  assert.deepEqual(state.activeFixtureIds, []);
  assert.equal(state.diagnostics.faultCount, 1);
  assert.equal(state.diagnostics.lastFault.stage, "restore");
  assert.equal(state.diagnostics.lastFault.code, "LAYOUT_DOWN");
  await service.shutdown();
});

test("effect lifecycle remains available through repeated adapter failures and expirations", async (t) => {
  const rejectedAdapter = {
    sendState: async () => {
      throw Object.assign(new Error("device offline"), {
        code: "DEVICE_OFFLINE",
      });
    },
  };
  const { service, advance } = setup(t, {
    durationSeconds: 0.001,
    restorePrevious: true,
    previousStates: {
      "desk-wiz": {
        brand: "wiz",
        value: { on: true, r: 1, g: 2, b: 3, dimming: 40 },
      },
    },
    adapters: { wiz: rejectedAdapter },
  });
  service.save({ revision: 0, enabled: true, fixtureIds: ["desk-wiz"] });
  for (let index = 0; index < 250; index += 1) {
    const started = await service.handle(
      index % 2 ? "fade red, blue fast" : "cycle red, blue fast",
      { fixtureIds: ["desk-wiz"] },
    );
    assert.equal(started.ok, true);
    await advance(501);
  }
  await new Promise((resolve) => setImmediate(resolve));
  const state = service.snapshot();
  assert.deepEqual(state.activeFixtureIds, []);
  assert.equal(state.diagnostics.faultCount >= 500, true);
  assert.equal(state.diagnostics.lastFault.code, "DEVICE_OFFLINE");
  await service.shutdown();
});

test("shutdown has a bounded wait when an offline adapter never settles a restore", async (t) => {
  const never = new Promise(() => {});
  const { service, advance } = setup(t, {
    durationSeconds: 0.001,
    restorePrevious: true,
    shutdownWaitMs: 5,
    previousStates: {
      "desk-wiz": {
        brand: "wiz",
        value: { on: true, r: 1, g: 2, b: 3, dimming: 40 },
      },
    },
    adapters: { wiz: { sendState: () => never } },
  });
  service.save({ revision: 0, enabled: true, fixtureIds: ["desk-wiz"] });
  await service.handle("cycle red, blue", { fixtureIds: ["desk-wiz"] });
  await advance(501);
  await assert.doesNotReject(() => service.shutdown());
  assert.deepEqual(service.snapshot().activeFixtureIds, []);
});

test("legacy timing offsets do not delay a fixture or predict another brand's colors", async (t) => {
  const { service, calls, advance } = setup(t, {
    latencyOffsets: { "desk-wiz": -100 },
  });
  service.save({
    revision: 0,
    enabled: true,
    fixtureIds: ["old-hue", "desk-wiz"],
  });
  await service.handle("cycle red, blue", {
    fixtureIds: ["old-hue", "desk-wiz"],
  });
  calls.length = 0;
  await advance(2400);
  assert.deepEqual(new Set(calls.map((row) => row.brand)), new Set(["hue", "wiz"]));
  const wiz = calls.find((row) => row.brand === "wiz");
  assert.deepEqual([wiz.state.r, wiz.state.g, wiz.state.b], [0, 0, 255]);
});

test("chase keeps one master clock while applying a deterministic fixture gap", async (t) => {
  const { service, calls, advance } = setup(t, { chaseGapMs: 250 });
  service.save({
    revision: 0,
    enabled: true,
    fixtureIds: ["old-hue", "desk-wiz", "shelf-govee"],
  });
  await service.handle("chase red, blue fast", {
    fixtureIds: ["old-hue", "desk-wiz", "shelf-govee"],
  });
  calls.length = 0;
  await advance(1200);
  const wiz = calls.find((row) => row.brand === "wiz"),
    govee = calls.find((row) => row.brand === "govee");
  assert.deepEqual([wiz.state.r, wiz.state.g, wiz.state.b], [0, 0, 255]);
  assert.deepEqual([govee.state.r, govee.state.g, govee.state.b], [255, 0, 0]);
});

test("spatial sweep is a brightness pulse while wave remains a full-brightness gradient", async (t) => {
  const spatialOffsets = {
    "desk-wiz": 0.1,
    "old-hue": 0.35,
    "shelf-govee": 0.7,
  };
  const first = setup(t);
  // Inject the small public geometry boundary used by the renderer.
  first.service.shutdown();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-effects-spatial-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtures = first.fixtures,
    calls = [];
  let at = 1000;
  const create = () =>
    createEffects({
      storePath: path.join(root, `effects-${Math.random()}.json`),
      fixtureRegistry: { listTwitchBy: () => fixtures },
      directiveService: {
        parseTwitchColorDirective: (text) => ({
          ok: true,
          hex: text === "red" ? "#ff0000" : "#0000ff",
        }),
      },
      adapters: {
        hue: {
          sendState: async () => {},
          getTelemetry: () => ({ entertainment: {} }),
        },
        wiz: {
          sendState: async (rows, state) => calls.push({ id: rows[0].id, state }),
        },
        govee: {
          sendState: async (rows, state) => calls.push({ id: rows[0].id, state }),
        },
      },
      lightingLayout: { spatialOffset: (id) => spatialOffsets[id] },
      lightingLab: {
        settings: () => ({
          brightnessLimit: 100,
          durationSeconds: 0,
          repeatCount: 0,
          cooldownSeconds: 0,
          restorePrevious: false,
          chaseGapMs: 250,
        }),
        isExcluded: () => false,
        latencyFor: () => 0,
        previousState: () => null,
        record() {},
      },
      now: () => at,
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
    });
  const sweep = create();
  sweep.save({
    revision: 0,
    enabled: true,
    fixtureIds: fixtures.map((row) => row.id),
  });
  await sweep.handle("sweep red, blue", {
    fixtureIds: fixtures.map((row) => row.id),
  });
  const sweepBrightness = calls.filter((row) => row.state.dimming).map((row) => row.state.dimming);
  assert.equal(new Set(sweepBrightness).size > 1, true);
  calls.length = 0;
  const wave = create();
  wave.save({
    revision: 0,
    enabled: true,
    fixtureIds: fixtures.map((row) => row.id),
  });
  await wave.handle("wave red, blue", {
    fixtureIds: fixtures.map((row) => row.id),
  });
  assert.equal(
    calls.filter((row) => row.state.dimming).every((row) => row.state.dimming === 100),
    true,
  );
});

test("an effects-only bulb captures real state and restores after an in-flight frame", async (t) => {
  const baseline = { on: false, dimming: 33, temp: 2700 },
    writes = [];
  let release,
    reads = 0;
  const { service } = setup(t, {
    restorePrevious: true,
    adapters: {
      wiz: {
        readState: async () => {
          reads++;
          return { ok: true, state: baseline };
        },
        sendState: async (_rows, state) => {
          writes.push(state);
          if (writes.length === 1)
            await new Promise((resolve) => {
              release = resolve;
            });
          return { sent: 1, failed: 0 };
        },
      },
    },
  });
  service.save({ revision: 0, enabled: true, fixtureIds: ["desk-wiz"] });
  assert.equal((await service.handle("fade red, blue", { fixtureIds: ["desk-wiz"] })).ok, true);
  await service.handle("stop", { fixtureIds: ["desk-wiz"] });
  assert.equal(writes.length, 1, "restore must wait for the outstanding frame");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.deepEqual(
    writes.at(-1),
    baseline,
    "restore off and white mode without an active-route color cache",
  );
  await service.shutdown();
});

test("a replacement during animated return retains the original baseline", async (t) => {
  const baseline = { on: true, bri: 42, ct: 320 },
    callbacks = [],
    writes = [];
  let reads = 0;
  const { service } = setup(t, {
    restorePrevious: true,
    setTimeout: (fn) => {
      callbacks.push(fn);
      return { unref() {} };
    },
    adapters: {
      hue: {
        readState: async () => {
          reads++;
          return { ok: true, state: baseline };
        },
        sendState: async (_rows, state) => {
          writes.push(state);
          return { sent: 1 };
        },
      },
    },
  });
  service.save({ revision: 0, enabled: true, returnEffect: true, fixtureIds: ["old-hue"] });
  await service.handle("cycle red, blue", { fixtureIds: ["old-hue"] });
  await service.handle("stop", { fixtureIds: ["old-hue"] });
  await service.handle("cycle blue, red", { fixtureIds: ["old-hue"] });
  assert.equal(reads, 1, "pending return must not become the next effect's baseline");
  await service.handle("stop", { fixtureIds: ["old-hue"] });
  while (callbacks.length) {
    callbacks.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(writes.at(-1), baseline);
  await service.shutdown();
});

test("a static command cancels an animated return after the effect has already stopped", async (t) => {
  const callbacks = [];
  const { service, calls } = setup(t, {
    setTimeout: (fn) => {
      callbacks.push(fn);
      return { unref() {} };
    },
    previousStates: { "desk-wiz": { brand: "wiz", value: { on: false } } },
  });
  service.save({ revision: 0, enabled: true, returnEffect: true, fixtureIds: ["desk-wiz"] });
  await service.handle("cycle red, blue", { fixtureIds: ["desk-wiz"] });
  await service.handle("stop", { fixtureIds: ["desk-wiz"] });
  service.cancelForStaticTargets(["desk-wiz"]);
  calls.length = 0;
  while (callbacks.length) {
    callbacks.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(calls.length, 0, "a pending return must not overwrite a newer static color");
  await service.shutdown();
});

test("an unavailable physical baseline prevents a return-enabled effect from changing that bulb", async (t) => {
  const { service, calls } = setup(t, {
    restorePrevious: true,
    adapters: {
      wiz: {
        readState: async () => ({ ok: false }),
        sendState: async () => calls.push("unexpected"),
      },
    },
  });
  service.save({ revision: 0, enabled: true, fixtureIds: ["desk-wiz"] });
  assert.equal((await service.handle("fade red, blue", { fixtureIds: ["desk-wiz"] })).ok, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(service.snapshot().activeFixtureIds, []);
  await service.shutdown();
});

test("rapid effect replacements discard obsolete frames and never overlap writes to one fixture", async (t) => {
  const calls = [],
    release = [];
  let simultaneous = 0,
    maxSimultaneous = 0;
  const { service } = setup(t, {
    adapters: {
      wiz: {
        sendState: async (rows, state) => {
          simultaneous++;
          maxSimultaneous = Math.max(maxSimultaneous, simultaneous);
          calls.push(state);
          await new Promise((resolve) => release.push(resolve));
          simultaneous--;
        },
      },
    },
  });
  service.save({ revision: 0, enabled: true, fixtureIds: ["desk-wiz"] });
  await service.handle("cycle red, blue", { fixtureIds: ["desk-wiz"] });
  await service.handle("breathe green", { fixtureIds: ["desk-wiz"] });
  await service.handle("fade blue, red", { fixtureIds: ["desk-wiz"] });
  assert.equal(calls.length, 1, "a new reward does not race a previous in-flight write");
  release.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(maxSimultaneous, 1);
  assert.deepEqual(
    [calls[1].r, calls[1].g, calls[1].b],
    [0, 0, 255],
    "only the newest effect is dispatched after the old write finishes",
  );
  release.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  await service.shutdown();
});

test("dynamic effects wait for Entertainment preheat and sample smooth Hue frames at twenty Hz", async (t) => {
  let ready,
    stopped = 0;
  const barrier = new Promise((resolve) => {
    ready = resolve;
  });
  const sends = [];
  const { service, calls, advance } = setup(t, {
    adapters: {
      hue: {
        prepareEntertainment: () => barrier,
        stopEntertainment: async () => {
          stopped++;
        },
        sendState: async (_fixtures, state) => {
          sends.push(state);
          return { sent: 1, failed: 0 };
        },
      },
    },
  });
  service.save({ revision: 0, enabled: true, fixtureIds: ["old-hue", "desk-wiz"] });
  const starting = service.handle("fade red, blue", { fixtureIds: ["old-hue", "desk-wiz"] });
  await new Promise((resolve) => setImmediate(resolve));
  await advance(500);
  assert.equal(sends.length, 0);
  assert.equal(calls.length, 0);
  ready({ ok: true, activeIds: ["old-hue"] });
  assert.equal((await starting).ok, true);
  for (let i = 0; i < 10; i++) {
    await advance(50);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(sends.length, 11);
  assert.ok(sends.every((state) => state.__entertainment === true));
  service.cancelFixtureIds(["old-hue", "desk-wiz"]);
  await service.shutdown();
  assert.equal(stopped, 1);
});

test("dynamic effects stop before their first frame when Entertainment preheat fails", async (t) => {
  const { service, calls } = setup(t, {
    adapters: {
      hue: {
        prepareEntertainment: async () => ({ ok: false, error: "hue_entertainment_start_timeout" }),
        stopEntertainment: async () => {},
        sendState: async () => {
          throw Error("unexpected_frame");
        },
      },
    },
  });
  service.save({ revision: 0, enabled: true, fixtureIds: ["old-hue", "desk-wiz"] });
  const result = await service.handle("fade red, blue", { fixtureIds: ["old-hue", "desk-wiz"] });
  assert.equal(result.ok, false);
  assert.equal(result.error, "hue_entertainment_start_timeout");
  assert.equal(calls.length, 0);
  assert.deepEqual(service.snapshot().activeFixtureIds, []);
  await service.shutdown();
});

test("saving viewer routes compares admitted Rave targets and leaves background scene fixtures alone", async (t) => {
  const { service } = setup(t);
  service.save({ revision: 0, enabled: true, fixtureIds: ["old-hue"], prefixes: {} });
  const stops = [];
  service.setMusicHandler({
    ids: () => ["old-hue", "background-scene"],
    routedIds: () => ["old-hue"],
    stop: async (ids) => {
      stops.push(ids);
    },
  });
  const result = service.save({
    revision: 1,
    enabled: true,
    fixtureIds: ["old-hue"],
    prefixes: {},
  });
  assert.equal(result.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stops, []);
  service.save({ revision: 2, enabled: false, fixtureIds: ["old-hue"], prefixes: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stops, [["old-hue"]]);
});
