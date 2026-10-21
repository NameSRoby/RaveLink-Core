const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const createController = require("../controller.cjs");
const createSession = require("../session.cjs");
const createBroker = require("../../../src/domains/fixtures/fixture-output-ownership.service");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const source = {
  id: "process:10:20",
  label: "Player.exe",
  kind: "application",
  scope: "process_tree",
};
function environment(t, overrides = {}) {
  let at = 0,
    queries = 0,
    captures = 0,
    stops = 0,
    frame = 0,
    probe,
    finish,
    renderer;
  const state = new Map([["bulb", { on: false, bri: 100, ct: 350 }]]),
    writes = [],
    intervals = new Set();
  if (overrides.sceneFixture) {
    state.set("scene", { on: !overrides.sceneStartsOff, dimming: 80, temp: 2700 });
    state.set("unrouted", { on: true, bri: 150, ct: 400 });
  }
  const broker = createBroker({
    now: () => at,
    isEligible: (id) => state.has(id),
    readState: async (id) => ({ ok: true, state: structuredClone(state.get(id)) }),
    writeState: async (id, value) => {
      writes.push(value);
      state.set(id, structuredClone(value));
      return { sent: 1, failed: 0 };
    },
    restoreState: async (id, value) => {
      state.set(id, structuredClone(value));
      return { sent: 1, failed: 0 };
    },
  });
  let available = [{ id: "bulb", brand: "hue", enabled: true }];
  if (overrides.sceneFixture)
    available.push(
      { id: "scene", brand: "wiz", enabled: true },
      { id: "unrouted", brand: "hue", enabled: true },
    );
  const controller = createController({
    savedEffects: overrides.savedEffects,
    now: () => at,
    wallNow: () => 100000 + at,
    readPlayback: overrides.readPlayback,
    output: {
      ownership: broker,
      resolveFixtures: () => available,
      ...(overrides.sceneFixture
        ? { isRaveAllowed: (id) => id === "bulb", isAutoAllowed: () => !overrides.sceneExcluded }
        : {}),
    },
    probeApi: {
      listSources: async (options) => {
        queries++;
        return overrides.sources ? overrides.sources(options) : [source];
      },
      capture: (id, options) => {
        captures++;
        assert.equal(id, source.id);
        assert.ok(options.seconds <= 3600);
        const done = new Promise((resolve) => {
          finish = resolve;
        });
        probe = {
          events: new EventEmitter(),
          done,
          snapshot: () => ({ generation: "a".repeat(32) }),
          stop: () => {
            stops++;
            finish({});
          },
        };
        return probe;
      },
    },
    sessionFactory: (options) => {
      renderer = createSession({
        ...options,
        setTimeout: (fn) => {
          intervals.add(fn);
          return fn;
        },
        clearTimeout: (fn) => intervals.delete(fn),
      });
      return renderer;
    },
  });
  t.after(async () => {
    await controller.operator.shutdown();
    await broker.shutdown();
  });
  return {
    ...controller,
    state,
    writes,
    endCapture: () => finish({}),
    intervals,
    broker,
    get queries() {
      return queries;
    },
    get captures() {
      return captures;
    },
    get stops() {
      return stops;
    },
    advance(ms) {
      at += ms;
    },
    async pump(ms = 500) {
      for (let i = 0; i < ms; i += 20) {
        at += 20;
        frame++;
        probe.events.emit("update", {
          type: "level",
          generation: "a".repeat(32),
          endFrame: frame * 960,
          discontinuities: 0,
          rms: 0.2,
          signal: "signal",
          invalidSamples: 0,
          freshness: { verified: true, maxAgeMs: 0, stale: false },
          analysis: { valid: true, bandRms: [0.1, 0.1, 0.1], onset: null },
        });
        for (const tick of [...intervals]) tick();
        await flush();
      }
    },
    removeFixtures: () => {
      available = [];
    },
  };
}
async function authorize(e) {
  e.operator.activate();
  await e.operator.permissions({ capture: true, output: false });
  await e.client.sources();
  await e.operator.selectSource(source.id);
}

test("manual starts accept continuous lifetimes while explicit timed requests remain bounded", async (t) => {
  const e = environment(t);
  await authorize(e);
  await e.client.call("music.session.v1", "start", { mode: "preview" });
  await e.pump();
  assert.equal(e.client.status().state, "preview");
  await e.client.stop();
  await e.client.call("music.session.v1", "start", { mode: "preview", seconds: null });
  await e.pump();
  assert.equal(e.client.status().state, "preview");
  await e.client.stop();
  assert.throws(() => e.client.start({ mode: "preview", seconds: 0 }), /invalid_music_start/);
  assert.throws(() => e.client.start({ mode: "preview", seconds: 121 }), /invalid_music_start/);
});

async function authorizeRave(e) {
  await authorize(e);
  await e.operator.permissions({ capture: true, output: true });
  await e.operator.selectFixtures([{ id: "bulb", role: "low", position: 0 }]);
  e.client.configure({
    ...e.client.exportDesign(),
    raveEnabled: true,
    scenarioWeights: { wash: 0, pulse: 1, bands: 0, wave: 0 },
  });
}
test("calibration measures a preview and saves only its fixed audio reference", async (t) => {
  const e = environment(t);
  await authorize(e);
  const pending = e.client.call("music.styles.v1", "calibrate", null);
  await e.pump(5000);
  e.endCapture();
  const design = await pending;
  assert.equal(design.ceilingDb, -14);
  assert.equal(design.floorDb, -38);
  assert.equal(e.writes.length, 0);
  assert.equal(e.client.status().permissions.output, false);
  assert.equal(e.client.status().state, "idle");
});
test("canceling calibration retains the previous design and releases capture", async (t) => {
  const e = environment(t);
  await authorize(e);
  const before = e.client.exportDesign();
  const pending = e.client.calibrate();
  const rejected = assert.rejects(pending, /music_calibration_superseded/);
  await e.pump(300);
  await e.client.stop();
  await rejected;
  assert.deepEqual(e.client.exportDesign(), before);
  assert.equal(e.intervals.size, 0);
});
test("extended calibration honors its bounded sample and explicit headroom without light writes", async (t) => {
  const e = environment(t);
  await authorize(e);
  const pending = e.client.call("music.styles.v1", "calibrate", { seconds: 30, headroomDb: 6 });
  await e.pump(30000);
  e.endCapture();
  const design = await pending;
  assert.equal(design.ceilingDb, -8);
  assert.equal(design.floorDb, -32);
  assert.equal(e.writes.length, 0);
  assert.equal(e.intervals.size, 0);
  await assert.rejects(
    e.client.call("music.styles.v1", "calibrate", { seconds: 120 }),
    /invalid_music_contract_request/,
  );
  await assert.rejects(
    e.client.call("music.styles.v1", "calibrate", { headroomDb: 30 }),
    /invalid_music_contract_request/,
  );
  assert.equal(e.captures, 1);
});
test("random recipe fixture tasks drive actual routing and restore native state", async (t) => {
  const e = environment(t);
  await authorizeRave(e);
  e.client.configure({
    ...e.client.exportDesign(),
    recipeOptions: { task: { mode: "fixed", value: "steady", allowed: ["steady"] } },
  });
  await e.operator.rave({ fixtureIds: ["bulb"], seconds: 10 });
  await e.pump(500);
  const pipeline = e.operator.pipeline();
  assert.equal(pipeline.routing[0].behavior, "steady");
  assert.equal(pipeline.sceneOnly, true);
  assert.ok(pipeline.layers.every((l) => !l.active));
  assert.equal(e.state.get("bulb").on, true);
  await e.client.stop();
  assert.equal(e.state.get("bulb").on, false);
});
test("rave borrows granted capture, replaces its own overlay and returns to current music", async (t) => {
  const e = environment(t);
  await authorizeRave(e);
  e.client.start({ mode: "live", seconds: 30 });
  await e.pump();
  assert.equal(e.captures, 1);
  await e.operator.rave({ fixtureIds: ["bulb"], palette: ["#ff0000"], seconds: 3 });
  await e.pump();
  assert.equal(e.captures, 1);
  assert.equal(e.broker.snapshot().fixtures[0].owners.length, 2);
  assert.equal(e.operator.pipeline().scenario.id, "pulse");
  await e.operator.rave({ fixtureIds: ["bulb"], palette: ["#0000ff"], seconds: 3 });
  await e.pump();
  assert.equal(e.captures, 1);
  assert.equal(e.stops, 0);
  await e.operator.stopRave(["bulb"]);
  await e.pump();
  assert.equal(e.stops, 0);
  assert.equal(e.broker.snapshot().fixtures[0].owners.length, 1);
  await e.client.stop();
  assert.equal(e.stops, 1);
  assert.equal(e.intervals.size, 0);
  assert.deepEqual(e.state.get("bulb"), { on: false, bri: 100, ct: 350 });
});
test("a queued rave is canceled by Stop before it can capture or acquire", async (t) => {
  const e = environment(t);
  await authorizeRave(e);
  const queued = e.operator.rave({ fixtureIds: ["bulb"], seconds: 2 });
  await e.operator.stopRave([]);
  await assert.rejects(queued, /music_request_superseded/);
  assert.equal(e.captures, 0);
  assert.equal(e.broker.snapshot().fixtures.length, 0);
});
test("blocking all scenarios prevents capture and blocking the active scenario restores ownership", async (t) => {
  const e = environment(t);
  await authorizeRave(e);
  await e.operator.rave({ fixtureIds: ["bulb"], seconds: 5 });
  await e.pump();
  e.client.configure({
    ...e.client.exportDesign(),
    scenarioWeights: { wash: 0, pulse: 0, bands: 0, wave: 0 },
  });
  await flush();
  await flush();
  assert.equal(e.stops, 1);
  assert.equal(e.broker.snapshot().fixtures.length, 0);
  await assert.rejects(e.operator.rave({ fixtureIds: ["bulb"] }), /music_no_scenarios_enabled/);
  assert.equal(e.captures, 1);
});
test("rave cannot grant audio, exceed lab limits on edits, or use fixtures outside the explicit music set", async (t) => {
  const e = environment(t);
  e.operator.activate();
  await assert.rejects(
    e.operator.rave({ fixtureIds: ["bulb"] }),
    /music_capture_permission_required/,
  );
  await authorizeRave(e);
  await assert.rejects(
    e.operator.rave({ fixtureIds: ["other"] }),
    /invalid_music_fixture_selection/,
  );
  await e.operator.rave({ fixtureIds: ["bulb"], brightnessLimit: 20, seconds: 5 });
  await e.pump();
  e.client.configure({ ...e.client.exportDesign(), maximumBrightness: 90 });
  await e.pump();
  assert.ok(e.writes.every((w) => w.bri <= 51));
  await e.operator.permissions({ capture: false, output: false });
  assert.equal(e.intervals.size, 0);
  assert.equal(e.broker.snapshot().fixtures.length, 0);
});
test("inactive/default-denied controller starts no helper, timer or fixture work", async (t) => {
  const e = environment(t);
  assert.equal(e.captures, 0);
  assert.equal(e.queries, 0);
  assert.equal(e.intervals.size, 0);
  assert.throws(() => e.client.start({ mode: "preview", seconds: 2 }), /music_feature_inactive/);
  await assert.rejects(e.client.sources(), /music_feature_inactive/);
  e.operator.activate();
  await assert.rejects(e.client.sources(), /music_capture_permission_required/);
  assert.throws(
    () => e.client.start({ mode: "preview", seconds: 2 }),
    /music_capture_permission_required/,
  );
  assert.equal(e.queries, 0);
  assert.equal(e.captures, 0);
});
test("client cannot grant itself permissions, change bindings or inject an owner/source at Start", async (t) => {
  const e = environment(t);
  await authorize(e);
  assert.equal(e.client.permissions, undefined);
  assert.equal(e.client.selectFixtures, undefined);
  assert.equal(e.client.selectSource, undefined);
  for (const extra of [
    { source: "default-output" },
    { fixtureIds: ["bulb"] },
    { owner: "core.effects" },
    { output: true },
    { executable: "arbitrary" },
  ])
    assert.throws(
      () => e.client.start({ mode: "preview", seconds: 2, ...extra }),
      /invalid_music_request/,
    );
  assert.equal(e.captures, 0);
});
test("source must come from the current bounded catalog; no implicit source is chosen", async (t) => {
  const e = environment(t);
  e.operator.activate();
  await e.operator.permissions({ capture: true, output: false });
  assert.throws(
    () => e.client.start({ mode: "preview", seconds: 2 }),
    /music_source_selection_required/,
  );
  await assert.rejects(
    e.operator.selectSource("default-output"),
    /music_source_not_in_current_catalog/,
  );
  await e.client.sources();
  e.advance(30001);
  await assert.rejects(e.operator.selectSource(source.id), /music_source_not_in_current_catalog/);
  assert.equal(e.captures, 0);
});
test("preview needs capture permission only and owns no fixtures even after output grant", async (t) => {
  const e = environment(t);
  await authorize(e);
  e.client.start({ mode: "preview", seconds: 2 });
  await e.pump();
  assert.equal(e.writes.length, 0);
  assert.equal(e.broker.snapshot().fixtures.length, 0);
  await e.client.stop();
  assert.equal(e.stops, 1);
  assert.equal(e.intervals.size, 0);
  assert.equal(e.client.status().state, "idle");
});

test("reaffirming the remembered source after discovery expires preserves running capture", async (t) => {
  const e = environment(t);
  await authorize(e);
  e.client.start({ mode: "preview" });
  await e.pump();
  const queries = e.queries;
  e.advance(30001);
  await e.operator.selectSource(source.id);
  assert.equal(e.queries, queries);
  assert.equal(e.stops, 0);
  assert.equal(e.captures, 1);
  assert.equal(e.client.status().state, "preview");
  await assert.rejects(
    e.operator.selectSource("default-output"),
    /music_source_not_in_current_catalog/,
  );
  await e.client.stop();
});
test("live requires a separate output grant and an explicit independently selected fixture set", async (t) => {
  const e = environment(t);
  await authorize(e);
  assert.throws(
    () => e.client.start({ mode: "live", seconds: 2 }),
    /music_output_permission_required/,
  );
  await e.operator.permissions({ capture: true, output: true });
  assert.throws(
    () => e.client.start({ mode: "live", seconds: 2 }),
    /music_fixture_selection_required/,
  );
  await e.operator.selectFixtures([{ id: "bulb", role: "low", position: 0 }]);
  assert.equal(e.captures, 0);
  e.client.start({ mode: "live", seconds: 2 });
  await e.pump();
  assert.equal(e.state.get("bulb").on, true);
  await e.operator.permissions({ capture: true, output: false });
  assert.deepEqual(e.state.get("bulb"), { on: false, bri: 100, ct: 350 });
  assert.equal(e.intervals.size, 0);
  assert.equal(e.broker.snapshot().fixtures.length, 0);
  assert.throws(
    () => e.client.start({ mode: "live", seconds: 2 }),
    /music_output_permission_required/,
  );
});
test("revoking capture aborts enumeration and fences late catalog results", async (t) => {
  let aborted = false;
  const e = environment(t, {
    sources: ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(Error("cancelled"));
          },
          { once: true },
        );
      }),
  });
  e.operator.activate();
  await e.operator.permissions({ capture: true, output: false });
  const pending = e.client.sources();
  const rejected = assert.rejects(pending, /cancelled/);
  await flush();
  await e.operator.permissions({ capture: false, output: false });
  await rejected;
  assert.equal(aborted, true);
  assert.equal(e.client.status().sourceSelected, false);
  assert.equal(e.captures, 0);
});
test("fixture selection is revalidated before capture and never accepts transport credentials", async (t) => {
  const e = environment(t);
  await authorize(e);
  await e.operator.permissions({ capture: true, output: true });
  await assert.rejects(
    e.operator.selectFixtures([{ id: "bulb", role: "low", position: 0, ip: "192.0.2.1" }]),
    /invalid_music_request/,
  );
  await e.operator.selectFixtures([{ id: "bulb", role: "low", position: 0 }]);
  e.removeFixtures();
  assert.throws(() => e.client.start({ mode: "live", seconds: 2 }), /music_fixture_not_available/);
  assert.equal(e.captures, 0);
});

test("clearing the music fixture selection drains output and restores its baseline", async (t) => {
  const e = environment(t);
  await authorize(e);
  await e.operator.permissions({ capture: true, output: true });
  await e.operator.selectFixtures([{ id: "bulb", role: "all", position: 0 }]);
  e.client.start({ mode: "live", seconds: 2 });
  await e.pump();
  await e.operator.selectFixtures([]);
  assert.equal(e.client.status().musicFixtureCount, 0);
  assert.equal(e.intervals.size, 0);
  assert.deepEqual(e.state.get("bulb"), { on: false, bri: 100, ct: 350 });
  assert.throws(
    () => e.client.start({ mode: "live", seconds: 2 }),
    /music_fixture_selection_required/,
  );
});
test("worker lifetime shutdown restores, invalidates its client and cannot be reactivated", async (t) => {
  const e = environment(t);
  await authorize(e);
  await e.operator.permissions({ capture: true, output: true });
  await e.operator.selectFixtures([{ id: "bulb", role: "all", position: 0 }]);
  e.client.start({ mode: "live", seconds: 2 });
  await e.pump();
  await e.operator.shutdown();
  assert.equal(e.stops, 1);
  assert.equal(e.intervals.size, 0);
  assert.deepEqual(e.state.get("bulb"), { on: false, bri: 100, ct: 350 });
  assert.throws(() => e.client.start({ mode: "preview", seconds: 2 }), /music_feature_inactive/);
  assert.throws(() => e.operator.activate(), /music_feature_closed/);
  await e.operator.shutdown();
  assert.equal(e.stops, 1);
});
test("portable exports and status exclude source bindings, fixture IDs and owner tokens", async (t) => {
  const e = environment(t);
  await authorize(e);
  await e.operator.selectFixtures([{ id: "bulb", role: "all", position: 0 }]);
  const design = e.client.exportDesign(),
    serialized = JSON.stringify({ design, status: e.client.status() });
  assert.ok(!serialized.includes(source.id));
  assert.ok(!serialized.includes('"bulb"'));
  assert.equal(design.source, undefined);
  assert.equal(design.fixtures, undefined);
  assert.throws(
    () => e.client.configure({ ...design, source: source.id }),
    /invalid_music_settings/,
  );
});
test("bounded subscriptions isolate throwing and async consumers without stopping capture", async (t) => {
  const e = environment(t);
  await authorize(e);
  let count = 0;
  e.client.subscribe(() => {
    throw Error("bad_view");
  });
  e.client.subscribe(async () => {
    throw Error("async_view");
  });
  e.client.subscribe(() => {
    count++;
  });
  e.client.start({ mode: "preview", seconds: 2 });
  await e.pump();
  assert.ok(count > 0);
  assert.equal(e.client.status().state, "preview");
  await e.client.stop();
});

test("versioned contracts compile and validate commands, snapshots and preview events", async (t) => {
  const {
    compileFeatureContracts,
  } = require("../../../src/capabilities/feature-platform/contracts/data-contract-compiler");
  const path = require("node:path");
  const compiled = await compileFeatureContracts(path.resolve(__dirname, ".."), {
    contracts: ["contracts/music-controller-v1.contracts.json"],
    provides: ["music.sources.v1", "music.session.v1", "music.styles.v1"],
  });
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  const endpoint = {
    id: "default-output",
    label: "Selected output",
    kind: "output",
    scope: "entire_endpoint",
  };
  const e = environment(t, { sources: () => [source, endpoint] });
  e.operator.activate();
  await e.operator.permissions({ capture: true, output: false });
  assert.deepEqual(await e.client.call("music.sources.v1", "list"), [source, endpoint]);
  assert.equal(e.client.status().sourceSelected, false);
  await e.operator.selectSource(source.id);
  const validatePreview = compiled.contracts.get("music.session.v1").events.get("preview");
  const frames = [];
  e.client.subscribe((frame) => frames.push(frame));
  const started = await e.client.call("music.session.v1", "start", { mode: "preview", seconds: 2 });
  assert.equal(started.state, "waiting");
  await e.pump();
  assert.ok(frames.length > 0);
  assert.ok(frames.every(validatePreview));
  await e.client.call("music.session.v1", "status");
  await e.client.call("music.styles.v1", "configure", { preset: "bands" });
  assert.equal((await e.client.call("music.styles.v1", "export")).preset, "bands");
  await e.client.call("music.session.v1", "stop");
  assert.equal((await e.client.call("music.session.v1", "status")).state, "idle");
});

test("continuous session status, preview events and Stop remain valid beyond 512 rendered frames", async (t) => {
  const e = environment(t);
  await authorize(e);
  await e.client.call("music.styles.v1", "configure", { outputHz: 16 });
  await e.client.call("music.session.v1", "start", { mode: "preview" });
  await e.pump(50000);
  const status = await e.client.call("music.session.v1", "status");
  assert(status.session.frames > 512);
  assert(status.session.lastPreview.sequence > 512);
  const {
    compileFeatureContracts,
  } = require("../../../src/capabilities/feature-platform/contracts/data-contract-compiler");
  const compiled = await compileFeatureContracts(require("node:path").resolve(__dirname, ".."), {
    contracts: ["contracts/music-controller-v1.contracts.json"],
    provides: ["music.sources.v1", "music.session.v1", "music.styles.v1"],
  });
  assert.equal(compiled.ok, true);
  const validate = compiled.contracts.get("music.session.v1").events.get("preview");
  assert.equal(validate(status.session.lastPreview), true);
  const stopped = await e.client.call("music.session.v1", "stop");
  assert.equal(stopped.state, "idle");
  assert(stopped.session.frames > 512);
});

test("contract dispatcher denies extra authority and unknown methods before capture", async (t) => {
  const e = environment(t);
  await authorize(e);
  for (const [capability, method, payload] of [
    ["music.session.v1", "start", { mode: "preview", seconds: 2, source: "default-output" }],
    ["music.session.v1", "permissions", { capture: true, output: true }],
    ["music.session.v1", "constructor", {}],
    ["__proto__", "toString", null],
    ["music.styles.v1", "configure", { palette: ["#ffffff"], fixtureIds: ["bulb"] }],
  ])
    await assert.rejects(
      e.client.call(capability, method, payload),
      /invalid_music_contract_request/,
    );
  assert.equal(e.captures, 0);
});

test("a song boundary stops the Rave renderer and restores its native fixture baseline", async (t) => {
  let title = "First";
  const e = environment(t, {
    sources: () => [{ ...source, label: "TIDALPlayer" }],
    readPlayback: async () => ({
      primary: {
        provider: "tidal",
        title,
        artists: ["Artist"],
        positionMs: 20000,
        durationMs: 200000,
        observedAt: 100000,
        status: "playing",
      },
    }),
  });
  await authorize(e);
  await e.operator.permissions({ capture: true, output: true });
  await e.operator.selectFixtures([{ id: "bulb", role: "all", position: 0 }]);
  e.client.configure({ raveEnabled: true, raveScenario: "wave", raveDurationMode: "song" });
  const result = await e.operator.rave({ fixtureIds: ["bulb"], seconds: 2 });
  assert.equal(result.seconds, 1800);
  assert.equal(e.client.status().duration.mode, "song");
  await e.pump();
  assert.ok(e.writes.length > 0);
  title = "Second";
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(e.client.status().state, "idle");
  assert.equal(e.stops, 1);
  assert.equal(e.intervals.size, 0);
  assert.deepEqual(e.state.get("bulb"), { on: false, bri: 100, ct: 350 });
});

test("off and dim scene routes remain valid through versioned status and stop responses", async (t) => {
  const e = environment(t);
  await authorize(e);
  await e.operator.permissions({ capture: true, output: true });
  await e.operator.selectFixtures([
    {
      id: "bulb",
      role: "all",
      position: 0,
      raveBehavior: "off",
      sceneBrightness: 10,
      sceneFadeMs: 1000,
      colorSlot: 0,
    },
  ]);
  e.client.configure({ raveEnabled: true, raveDurationMode: "separate", raveSeconds: 3600 });
  await e.operator.rave({ fixtureIds: ["bulb"], seconds: 5 });
  await e.pump();
  const status = await e.client.call("music.session.v1", "status");
  assert.equal(status.session.lastPreview.frames[0].brightness, 0);
  assert.equal(e.operator.pipeline().routing[0].behavior, "off");
  await e.client.call("music.session.v1", "stop");
  assert.equal(e.stops, 1);
});
test("Rave stages artistic edits for the next activation and a selected layer block restores music", async (t) => {
  const e = environment(t);
  await authorize(e);
  await e.operator.permissions({ capture: true, output: true });
  await e.operator.selectFixtures([{ id: "bulb", role: "all", position: 0 }]);
  e.client.configure({
    raveEnabled: true,
    raveScenario: "pulse",
    raveLayerMode: "fixed",
    raveDurationMode: "separate",
    palette: ["#ff0000", "#0000ff"],
  });
  e.client.start({ mode: "live", seconds: 120 });
  await e.pump();
  await e.operator.rave({ fixtureIds: ["bulb"], seconds: 20 });
  await e.pump();
  const recipe = e.operator.pipeline();
  e.client.configure({
    ...e.client.exportDesign(),
    raveScenario: "wave",
    raveColorPlan: "energy",
    raveLayerMode: "random",
    palette: ["#00ff00"],
    behaviors: { smoothing: 1 },
  });
  await e.pump();
  const after = e.operator.pipeline();
  assert.equal(after.recipeId, recipe.recipeId);
  assert.equal(after.scenario.id, "pulse");
  assert.deepEqual(after.effective.palette, recipe.effective.palette);
  assert.equal(after.effective.colorMode, recipe.effective.colorMode);
  await e.operator.stopRave();
  await e.operator.rave({ fixtureIds: ["bulb"], seconds: 20 });
  await e.pump();
  const next = e.operator.pipeline();
  assert.equal(next.scenario.id, "wave");
  assert.notEqual(next.recipeId, recipe.recipeId);
  assert.deepEqual(next.effective.palette, ["#00ff00", "#ff00ff"]);
  e.client.configure({
    ...e.client.exportDesign(),
    behaviors: { ...e.client.exportDesign().behaviors, attacksEnabled: false },
  });
  await flush();
  await flush();
  assert.equal(e.operator.raveIds().length, 0);
  assert.equal(e.client.status().state, "running");
  assert.equal(e.captures, 1);
});

test("saved-only policy controls manual and channel-points starts and preserves current choices during edits", async (t) => {
  const library = require("../saved-effects.cjs")();
  const mapped = require("../mapper.cjs")({
    preset: "pulse",
    colorMode: "travel",
    feel: "fast",
    recipeOptions: { shape: { mode: "fixed", value: "wave", allowed: ["wave"] } },
  });
  const p = library.save({ name: "Pinned wave" }, mapped.inspect(0));
  library.policy({ mode: "single", ids: [p.id] });
  const e = environment(t, { savedEffects: library });
  await authorize(e);
  e.client.configure({
    ...e.client.exportDesign(),
    scenarioMode: "random",
    scenarioWeights: Object.fromEntries(
      Object.keys(e.client.exportDesign().scenarioWeights).map((id) => [id, 0]),
    ),
  });
  e.client.start({ mode: "preview", seconds: 2 });
  await e.pump();
  assert.equal(e.operator.pipeline().recipe.shape, "wave");
  assert.equal(e.operator.pipeline().savedEffect.id, p.id);
  e.client.configure({
    ...e.client.exportDesign(),
    feel: "slow",
    recipeOptions: { shape: { mode: "fixed", value: "bounce", allowed: ["bounce"] } },
  });
  assert.equal(e.operator.pipeline().recipe.shape, "wave");
  assert.equal(e.operator.pipeline().effective.feel, "fast");
  await e.client.stop();
  await e.operator.permissions({ capture: true, output: true });
  await e.operator.selectFixtures([{ id: "bulb", role: "all", position: 0 }]);
  e.client.configure({
    ...e.client.exportDesign(),
    raveEnabled: true,
    scenarioWeights: Object.fromEntries(
      Object.keys(e.client.exportDesign().scenarioWeights).map((id) => [id, 0]),
    ),
  });
  await e.operator.rave({
    fixtureIds: ["bulb"],
    palette: ["#ff0000", "#00ff00"],
    feel: "aggressive",
    seconds: 2,
  });
  await e.pump();
  assert.equal(e.operator.pipeline().savedEffect.id, p.id);
  assert.equal(e.operator.pipeline().recipe.shape, "wave");
  assert.equal(e.operator.pipeline().effective.feel, "fast");
});

test("contrast validates atomically, persists bindings and edits live or preview without restarting", async (t) => {
  const e = environment(t);
  await authorizeRave(e);
  e.operator.contrast({ percent: 40, fixtures: null });
  assert.equal(e.operator.bindings().fixtures[0].outOfSync, 40);
  await e.client.start({ mode: "preview" });
  await e.pump();
  assert(e.operator.pipeline().assignments.every((f) => f.outOfSync === 40));
  e.operator.contrast({ percent: 75, fixtures: ["bulb"] });
  assert(e.operator.pipeline().assignments.every((f) => f.outOfSync === 75));
  assert.equal(e.captures, 1);
  assert.equal(e.stops, 0);
  for (const value of [
    { percent: 101, fixtures: null },
    { percent: 50, fixtures: [] },
    { percent: 50, fixtures: ["missing"] },
    { percent: 50, fixtures: ["bulb", "bulb"] },
    { percent: 50, fixtures: null, delay: 500 },
  ])
    assert.throws(() => e.operator.contrast(value));
  assert.equal(e.operator.bindings().fixtures[0].outOfSync, 75);
  await e.client.stop();
  await e.client.start({ mode: "live" });
  await e.pump();
  e.operator.contrast({ percent: 90, fixtures: ["bulb"] });
  assert.equal(e.operator.pipeline().assignments[0].outOfSync, 90);
  assert.equal(e.captures, 2);
  assert.equal(e.stops, 1);
  await e.client.stop();
  assert.equal(e.state.get("bulb").ct, 350);
});

async function sceneRave(e, start = true) {
  await authorizeRave(e);
  e.client.configure({ ...e.client.exportDesign(), maximumBrightness: 100 });
  await e.operator.selectFixtures([
    { id: "bulb", role: "all", position: 0 },
    {
      id: "scene",
      role: "low",
      position: 1,
      raveBehavior: "dim",
      sceneBrightness: 50,
      sceneFadeMs: 200,
    },
    { id: "unrouted", role: "all", position: 0.5 },
  ]);
  return start ? e.operator.rave({ fixtureIds: ["bulb"], origin: "viewer" }) : null;
}

test("viewer Rave applies configured dim companions without admitting extra reactive targets and restores both", async (t) => {
  const e = environment(t, { sceneFixture: true });
  const result = await sceneRave(e);
  assert.deepEqual(result.targets, ["bulb", "scene"]);
  await e.pump(800);
  assert.equal(e.state.get("scene").dimming, 50);
  assert.equal(e.state.get("scene").on, true);
  assert.equal(e.state.get("unrouted").bri, 150);
  assert.deepEqual(e.operator.raveRouteIds(), ["bulb"]);
  assert.deepEqual(e.operator.raveIds(), ["bulb", "scene"]);
  assert.equal(e.client.status().session.ownedFixtures, 2);
  await e.operator.stopRave(["bulb"]);
  assert.deepEqual(e.state.get("scene"), { on: true, dimming: 80, temp: 2700 });
  assert.equal(e.state.get("bulb").on, false);
});

test("dim companions respect lab exclusions and an off baseline, and need a real admitted route", async (t) => {
  for (const options of [{ sceneExcluded: true }, { sceneStartsOff: true }]) {
    const e = environment(t, { sceneFixture: true, ...options });
    await sceneRave(e);
    await e.pump(800);
    assert.equal(e.state.get("scene").on, !options.sceneStartsOff);
    if (options.sceneExcluded) assert.equal(e.state.get("scene").dimming, 80);
    await e.operator.stopRave();
    await assert.rejects(
      e.operator.rave({ fixtureIds: ["not-selected"] }),
      /invalid_music_fixture_selection/,
    );
    await assert.rejects(
      e.operator.rave({ fixtureIds: ["unrouted"] }),
      /invalid_music_fixture_selection/,
    );
  }
});

test("saved looks cannot promote an unrouted dim companion to a reactive fixture", async (t) => {
  const e = environment(t, {
    sceneFixture: true,
    savedEffects: {
      choose: (design, fixtures) => ({
        design,
        fixtures: fixtures.map((f) =>
          f.id === "scene" ? { ...f, raveBehavior: "reactive", sceneBrightness: 100 } : f,
        ),
        profile: { id: "look", name: "Saved look" },
      }),
    },
  });
  await sceneRave(e);
  await e.pump(800);
  assert.equal(e.operator.pipeline().routing.find((f) => f.id === "scene").behavior, "dim");
  assert.equal(e.state.get("scene").dimming, 50);
});

test("channel-points Rave dims its operator scene companion and an unchanged route save does not stop it", async (t) => {
  const fs = require("node:fs"),
    os = require("node:os"),
    path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-scene-reward-"));
  const e = environment(t, { sceneFixture: true });
  await sceneRave(e, false);
  const effects = require("../../../src/domains/twitch/twitch-light-effects.service")({
    storePath: path.join(dir, "effects.json"),
    fixtureRegistry: { listTwitchBy: () => [{ id: "bulb", brand: "hue", twitchEnabled: true }] },
    directiveService: { parseTwitchColorDirective: () => ({ ok: false }) },
  });
  t.after(async () => {
    await effects.shutdown();
    const relative = path.relative(os.tmpdir(), dir);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(
    effects.save({ revision: 0, enabled: true, fixtureIds: ["bulb"], prefixes: {} }).ok,
    true,
  );
  effects.setMusicHandler({
    check: e.operator.checkRave,
    start: e.operator.rave,
    stop: e.operator.stopRave,
    ids: e.operator.raveIds,
    routedIds: e.operator.raveRouteIds,
  });
  const result = await effects.handle("rave", { fixtureIds: ["bulb"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, ["bulb", "scene"]);
  await e.pump(800);
  assert.equal(e.state.get("scene").dimming, 50);
  assert.equal(e.state.get("unrouted").bri, 150);
  assert.equal(
    effects.save({ revision: 1, enabled: true, fixtureIds: ["bulb"], prefixes: {} }).ok,
    true,
  );
  await flush();
  assert.equal(e.operator.raveIds().length, 2);
  await effects.handle("rave stop", { fixtureIds: ["bulb"] });
  assert.deepEqual(e.state.get("scene"), { on: true, dimming: 80, temp: 2700 });
});
