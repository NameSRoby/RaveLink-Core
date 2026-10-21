const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const createSession = require("../session.cjs");
const createOwnership = require("../../../src/domains/fixtures/fixture-output-ownership.service");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function environment(
  t,
  {
    preview = false,
    prepare,
    stopTransport,
    readFailure = false,
    writeFailure = false,
    onFrame,
    readBarrier,
    settings,
    sceneRoles,
    sceneKind = "effect",
    initialOn = false,
    extraHue = false,
  } = {},
) {
  let at = 0,
    frame = 0,
    stops = 0,
    finish,
    fail;
  const timers = new Set(),
    deadlines = new Map(),
    writes = [],
    states = new Map([
      ["h", { on: initialOn, bri: 100, ct: 350 }],
      ["w", { on: initialOn, dimming: 30, temp: 2700 }],
    ]);
  if (extraHue) states.set("h2", { on: initialOn, bri: 100, ct: 350 });
  const initial = structuredClone(states),
    frames = [],
    frameTimes = [];
  const broker = createOwnership({
    now: () => at,
    isEligible: (id) => states.has(id),
    readState: async (id) => {
      await readBarrier;
      return readFailure && id === "h"
        ? { ok: false }
        : { ok: true, state: structuredClone(states.get(id)) };
    },
    writeState: async (id, state) => {
      if (writeFailure && id === "h") throw Error("offline");
      writes.push({ id, state, at });
      states.set(id, structuredClone(state));
      return { sent: 1, failed: 0 };
    },
    restoreState: async (id, state) => {
      states.set(id, structuredClone(state));
      return { sent: 1, failed: 0 };
    },
  });
  const events = new EventEmitter(),
    done = new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  const generation = "a".repeat(32);
  const probe = {
    events,
    done,
    snapshot: () => ({ generation }),
    stop: () => {
      stops++;
      finish({ reason: "parent_stop" });
    },
  };
  const session = createSession({
    settings,
    output: preview
      ? null
      : {
          ownership: broker,
          prepare,
          stopTransport,
          kind: sceneRoles ? sceneKind : "music",
          fixtures: [
            { id: "h", brand: "hue", role: "low", position: 0, ...sceneRoles?.h },
            { id: "w", brand: "wiz", role: "high", position: 1, ...sceneRoles?.w },
            ...(extraHue ? [{ id: "h2", brand: "hue", role: "all", position: 0.5 }] : []),
          ],
        },
    now: () => at,
    onFrame:
      onFrame ||
      ((f) => {
        frames.push(f);
        frameTimes.push(at);
      }),
    setTimeout: (fn, delay) => {
      timers.add(fn);
      deadlines.set(fn, at + delay);
      return fn;
    },
    clearTimeout: (fn) => {
      timers.delete(fn);
      deadlines.delete(fn);
    },
  });
  t.after(async () => {
    await session.stop();
    await broker.shutdown();
  });
  return {
    session,
    broker,
    states,
    initial,
    writes,
    frames,
    frameTimes,
    timers,
    probe,
    get stops() {
      return stops;
    },
    advance(ms) {
      at += ms;
      session.tick();
    },
    async scheduled(ms, stallStart = -1, stallEnd = -1) {
      for (let i = 0; i < ms; i++) {
        at++;
        if (at % 20 === 0) this.sample();
        if (at < stallStart || at >= stallEnd)
          for (const fn of [...timers]) if (deadlines.get(fn) <= at) fn();
        await flush();
      }
    },
    sample(extra = {}) {
      frame++;
      events.emit("update", {
        type: "level",
        generation,
        endFrame: frame * 960,
        discontinuities: 0,
        rms: 0.2,
        signal: "signal",
        invalidSamples: 0,
        freshness: { verified: true, maxAgeMs: 0, stale: false },
        analysis: { valid: true, bandRms: [0.1, 0.1, 0.1], onset: null },
        ...extra,
      });
    },
    async pump(ms) {
      for (let i = 0; i < ms; i += 20) {
        at += 20;
        this.sample();
        session.tick();
        await flush();
      }
    },
    fail: () => fail(Error("capture_failure")),
    close: () => finish({ reason: "parent_stop" }),
    now: () => at,
  };
}
test("faster fixture slots cannot consume a slower fixture's new attack", async (t) => {
  const e = environment(t, {
    extraHue: true,
    settings: {
      preset: "pulse",
      intensity: 1,
      outputHz: 8,
      feel: "aggressive",
      behaviors: { pulseDecayMs: 80, smoothing: 0 },
    },
  });
  e.session.start(e.probe);
  await e.pump(1000);
  const before = e.writes.filter((w) => w.id === "h").at(-1).state.bri;
  e.advance(20);
  e.sample({
    analysis: {
      valid: true,
      bandRms: [0.1, 0.1, 0.1],
      onset: { id: 1, detectedAtFrame: 51 * 960 },
    },
  });
  await e.pump(300);
  const hue = e.writes.filter((w) => w.id === "h");
  assert.ok(
    hue.at(-1).state.bri > before + 20,
    JSON.stringify({
      before,
      writes: hue.map((w) => ({ at: w.at, bri: w.state.bri })),
      status: e.session.snapshot(),
    }),
  );
  for (let i = 1; i < hue.length; i++) assert.ok(hue[i].at - hue[i - 1].at >= 250);
});
test("sixteen-Hz intent keeps independent Hue limits and restores every fixture", async (t) => {
  const e = environment(t, { extraHue: true, settings: { outputHz: 16 } });
  e.session.start(e.probe);
  for (let step = 0; step < 80; step++) {
    e.advance(12.5);
    e.sample();
    e.session.tick();
    await flush();
  }
  const wiz = e.writes.filter((w) => w.id === "w"),
    hue = e.writes.filter((w) => w.id === "h");
  assert.ok(wiz.length >= 15 && wiz.length <= 16);
  assert.ok(hue.length >= 3 && hue.length <= 4);
  for (let i = 1; i < wiz.length; i++) assert.ok(wiz[i].at - wiz[i - 1].at >= 62.5);
  for (let i = 1; i < hue.length; i++) assert.ok(hue[i].at - hue[i - 1].at >= 250);
  await e.session.stop();
  assert.deepEqual(e.states, e.initial);
  assert.equal(e.session.snapshot().failedOperations, 0);
  assert.equal(e.session.snapshot().ownedFixtures, 0);
});

test("deadline scheduling reaches near sixteen Hz without catch-up bursts after a stall", async (t) => {
  const e = environment(t, { extraHue: true, settings: { outputHz: 16 } });
  e.session.start(e.probe);
  await e.scheduled(1200);
  const wiz = e.writes.filter((w) => w.id === "w");
  assert.ok(wiz.length >= 17 && wiz.length <= 19, JSON.stringify(wiz.map((w) => w.at)));
  for (let i = 1; i < wiz.length; i++)
    assert.ok(wiz[i].at - wiz[i - 1].at >= 62.5 && wiz[i].at - wiz[i - 1].at <= 65);
  await e.scheduled(600, 1250, 1550);
  const after = e.writes.filter((w) => w.id === "w");
  for (let i = 1; i < after.length; i++)
    assert.ok(after[i].at - after[i - 1].at >= 62.5, "late timers must not burst");
  const snapshot = e.session.snapshot();
  const telemetry = snapshot.outputCadence.fixtureHz.find((f) => f.brand === "wiz").delivery;
  assert.equal(telemetry.completed, after.length);
  assert.equal(telemetry.attempted, after.length);
  assert.equal(telemetry.failed, 0);
  assert.ok(telemetry.completedHz > 0 && Number.isFinite(telemetry.completedHz));
  assert.deepEqual(telemetry.lastCommand.state, after.at(-1).state);
  await e.session.stop();
  assert.equal(e.timers.size, 0);
  assert.deepEqual(e.states, e.initial);
});

test("Hue downward glide leaves rising attacks immediate", async (t) => {
  const e = environment(t, {
    settings: { preset: "pulse", outputHz: 8, behaviors: { hueGlideMs: 100 } },
  });
  e.session.start(e.probe);
  await e.pump(400);
  const previous = e.writes.filter((w) => w.id === "h").at(-1).state.bri;
  for (let i = 0; i < 30; i++) {
    e.sample({ rms: 0, signal: "silent" });
    e.advance(20);
    await flush();
  }
  const downward = e.writes.filter((w) => w.id === "h").filter((w) => w.state.bri < previous);
  assert.ok(downward.some((w) => w.state.transitiontime === 1));
  await e.pump(600);
  assert.equal(e.writes.filter((w) => w.id === "h").at(-1).state.transitiontime, 0);
});

test("preview starts no leases, uses bounded cadence and clears owned resources on Stop", async (t) => {
  const e = environment(t, { preview: true });
  assert.equal(e.timers.size, 0);
  assert.equal(e.stops, 0);
  e.session.start(e.probe);
  await e.pump(1000);
  assert.ok(e.frames.length <= 5);
  assert.ok(e.frames.length >= 4);
  assert.equal(e.writes.length, 0);
  assert.equal(e.broker.snapshot().fixtures.length, 0);
  const result = await e.session.stop();
  assert.equal(result.state, "stopped");
  assert.equal(e.timers.size, 0);
  await e.session.stop();
  assert.equal(e.stops, 1);
  assert.equal(e.probe.events.listenerCount("update"), 0);
});

test("theatre and steady fixture roles bypass audio brightness but restore together", async (t) => {
  const e = environment(t, {
    initialOn: true,
    settings: { maximumBrightness: 60, palette: ["#ff0000", "#00ff00"] },
    sceneRoles: {
      h: { raveBehavior: "dim", sceneBrightness: 10, sceneFadeMs: 1000 },
      w: { raveBehavior: "steady", sceneBrightness: 20, colorSlot: 1 },
    },
  });
  e.session.start(e.probe);
  await e.pump(1800);
  const hue = e.writes.filter((w) => w.id === "h"),
    wiz = e.writes.filter((w) => w.id === "w");
  assert.ok(hue.length > 3);
  assert.equal(hue.at(-1).state.bri, 25);
  assert.ok(hue.every((w) => !Object.hasOwn(w.state, "xy") && !Object.hasOwn(w.state, "ct")));
  assert.ok(wiz.every((w) => w.state.dimming === 20 && w.state.g === 255));
  await e.session.stop();
  assert.deepEqual(e.states, e.initial);
  assert.equal(e.session.snapshot().failedOperations, 0);
});

test("manual playback honors theatre dim and hold instead of replacing it with audio response", async (t) => {
  const e = environment(t, {
    sceneKind: "music",
    initialOn: true,
    sceneRoles: {
      h: { raveBehavior: "dim", sceneBrightness: 10, sceneFadeMs: 1000 },
      w: { raveBehavior: "off" },
    },
    settings: { behaviors: { openingStyle: 1 } },
  });
  e.session.start(e.probe);
  await e.pump(1800);
  const hue = e.writes.filter((write) => write.id === "h");
  assert.equal(hue.at(-1).state.bri, 25);
  assert(hue.every((write) => !Object.hasOwn(write.state, "xy")));
  assert(e.writes.filter((write) => write.id === "w").every((write) => write.state.on === false));
  await e.session.stop();
  assert.deepEqual(e.states, e.initial);
});

test("source failure bypasses configured ending animation and restores immediately", async (t) => {
  const e = environment(t, {
    settings: { behaviors: { openingStyle: 1, endingStyle: 2, endingMs: 4000 } },
  });
  e.session.start(e.probe);
  await e.pump(400);
  assert.equal(e.session.snapshot().transition.phase, "opening");
  const count = e.writes.length;
  e.sample({ freshness: { verified: true, maxAgeMs: 251, stale: true } });
  const result = await e.session.done;
  assert.equal(result.reason, "music_source_stale");
  assert.equal(e.writes.length, count, "failed audio cannot produce a decorative ending");
  assert.deepEqual(e.states, e.initial);
});

test("an off scene emits only power-off intent and restores its original mode", async (t) => {
  const e = environment(t, {
    initialOn: true,
    sceneRoles: { h: { raveBehavior: "off" }, w: { raveBehavior: "off" } },
  });
  e.session.start(e.probe);
  await e.pump(600);
  assert.ok(e.writes.length > 0);
  assert.ok(e.writes.every((w) => JSON.stringify(w.state) === '{"on":false}'));
  assert.ok(e.frames.at(-1).frames.every((f) => f.brightness === 0));
  await e.session.stop();
  assert.deepEqual(e.states, e.initial);
});
test("fresh silence stays dim; missing samples restore exact native baselines", async (t) => {
  const e = environment(t);
  e.session.start(e.probe);
  await e.pump(500);
  assert.equal(e.states.get("h").on, true);
  assert.equal(e.states.get("w").on, true);
  e.advance(251);
  const result = await e.session.done;
  assert.equal(result.reason, "music_source_stale");
  assert.equal(result.state, "failed");
  assert.deepEqual(e.states, e.initial);
  assert.equal(e.broker.snapshot().fixtures.length, 0);
  assert.equal(e.timers.size, 0);
  assert.equal(e.stops, 1);
});
test("invalid input, stale clock, generation mismatch and child failure release ownership", async (t) => {
  for (const trigger of [
    (e) => e.sample({ signal: "invalid", invalidSamples: 1 }),
    (e) => e.sample({ freshness: { verified: true, maxAgeMs: 251, stale: true } }),
    (e) => e.sample({ generation: "b".repeat(32) }),
    (e) => e.fail(),
  ]) {
    const e = environment(t);
    e.session.start(e.probe);
    await e.pump(300);
    trigger(e);
    assert.equal((await e.session.done).state, "failed");
    assert.deepEqual(e.states, e.initial);
    assert.equal(e.timers.size, 0);
    assert.equal(e.broker.snapshot().fixtures.length, 0);
  }
});
test("unknown timestamps never acquire fixtures and waiting has a finite deadline", async (t) => {
  const e = environment(t);
  e.session.start(e.probe);
  e.sample({ freshness: { verified: false, maxAgeMs: null, stale: true } });
  assert.equal(e.broker.snapshot().fixtures.length, 0);
  e.advance(7501);
  assert.equal((await e.session.done).reason, "music_startup_timeout");
  assert.equal(e.writes.length, 0);
});
test("manual takeover pauses only affected fixtures and never silently reacquires them", async (t) => {
  const e = environment(t);
  e.session.start(e.probe);
  await e.pump(500);
  const manual = { on: true, bri: 77, ct: 400 };
  await e.broker.manualWrite("h", manual);
  const before = e.writes.filter((w) => w.id === "h").length;
  await e.pump(1000);
  assert.deepEqual(e.states.get("h"), manual);
  assert.equal(e.writes.filter((w) => w.id === "h").length, before);
  assert.equal(e.session.snapshot().pausedFixtures, 1);
  assert.equal(e.states.get("w").on, true);
  await e.session.stop();
  assert.deepEqual(e.states.get("h"), manual);
  assert.deepEqual(e.states.get("w"), e.initial.get("w"));
});
test("temporary effects preempt while fresh music updates and resume the current intent", async (t) => {
  const e = environment(t);
  e.session.start(e.probe);
  await e.pump(500);
  const fx = await e.broker.acquire({ fixtureId: "h", owner: "test.effect", kind: "effect" });
  await e.broker.write(fx.token, { on: true, bri: 200 });
  await e.pump(500);
  assert.deepEqual(e.states.get("h"), { on: true, bri: 200 });
  await e.broker.release(fx.token);
  assert.equal(e.states.get("h").on, true);
  assert.ok(e.states.get("h").bri < 100);
  await e.session.stop();
  assert.deepEqual(e.states, e.initial);
});
test("partial baseline admission releases every reservation without dispatching music", async (t) => {
  const e = environment(t, { readFailure: true });
  e.session.start(e.probe);
  e.sample();
  const result = await e.session.done;
  assert.equal(result.reason, "music_fixture_admission_failed");
  assert.equal(e.writes.length, 0);
  assert.deepEqual(e.states, e.initial);
  assert.equal(e.broker.snapshot().fixtures.length, 0);
});
test("one offline fixture cannot stall other targets or renew its failed lease forever", async (t) => {
  const e = environment(t, { writeFailure: true });
  e.session.start(e.probe);
  await e.pump(1000);
  assert.equal(e.states.get("w").on, true);
  assert.equal(e.states.get("h").on, false);
  assert.equal(e.session.snapshot().ownedFixtures, 1);
  await e.session.stop();
  assert.deepEqual(e.states, e.initial);
});
test("preview callback exceptions stop capture and restore; invalid edits retain the preset", async (t) => {
  const e = environment(t, {
    onFrame: () => {
      throw Error("view_failed");
    },
  });
  e.session.start(e.probe);
  assert.throws(() => e.session.configure({ preset: "unknown" }), /invalid_music_settings/);
  e.sample();
  e.session.tick();
  assert.equal((await e.session.done).reason, "music_render_failed");
  assert.deepEqual(e.states, e.initial);
  assert.equal(e.timers.size, 0);
});

test("measured silence remains a fresh dim steady palette intent until operator Stop", async (t) => {
  const e = environment(t);
  e.session.start(e.probe);
  for (let i = 0; i < 80; i++) {
    e.advance(20);
    e.sample({
      rms: 0,
      signal: "silent",
      analysis: { valid: true, bandRms: [0, 0, 0], onset: null },
    });
    e.session.tick();
    await flush();
  }
  assert.equal(e.session.snapshot().state, "running");
  assert.equal(e.states.get("w").dimming, 10);
  assert.equal(e.states.get("h").bri, 26, "Hue's quantized command stays within the minimum bound");
  await e.session.stop();
  assert.deepEqual(e.states, e.initial);
});

test("Stop while native reads are pending cannot leave a late reservation behind", async (t) => {
  let release;
  const readBarrier = new Promise((resolve) => {
    release = resolve;
  });
  const e = environment(t, { readBarrier });
  e.session.start(e.probe);
  e.sample();
  await flush();
  const stopping = e.session.stop();
  release();
  await stopping;
  assert.equal(e.writes.length, 0);
  assert.equal(e.broker.snapshot().fixtures.length, 0);
  assert.deepEqual(e.states, e.initial);
  assert.equal(e.stops, 1);
});

test("feel profiles never change the four-Hz output cap or hardware brightness bounds", async (t) => {
  for (const feel of ["slow", "normal", "fast", "aggressive"]) {
    const e = environment(t, {
      settings: { feel, intensity: 1, minimumBrightness: 10, maximumBrightness: 22 },
    });
    e.session.start(e.probe);
    await e.pump(1000);
    assert.ok(e.writes.filter((w) => w.id === "h").length <= 4);
    assert.ok(e.writes.filter((w) => w.id === "w").length <= 4);
    assert.ok(
      e.frameTimes.slice(1).every((at, i) => at - e.frameTimes[i] >= 250),
      "late ticks must not be followed by a short catch-up interval",
    );
    for (const write of e.writes) {
      const percent = write.id === "h" ? (write.state.bri * 100) / 254 : write.state.dimming;
      assert.ok(percent >= 10 && percent <= 22);
    }
    await e.session.stop();
  }
});

test("percussive presets do not add a second native fade after their audio envelope", async (t) => {
  for (const preset of ["ambient", "pulse", "bands"]) {
    const e = environment(t, { settings: { preset, interpretation: "musical" } });
    e.session.start(e.probe);
    await e.pump(600);
    const writes = e.writes.filter((w) => w.id === "h");
    assert.ok(writes.length > 0);
    assert.ok(writes.every((w) => w.state.transitiontime === (preset === "ambient" ? 1 : 0)));
    await e.session.stop();
    assert.deepEqual(e.states, e.initial);
  }
});

test("invalid device limits fail before capture and live edits cannot bypass them", async (t) => {
  assert.throws(
    () =>
      createSession({
        settings: { minimumBrightness: 1 },
        output: {
          ownership: Object.fromEntries(
            ["acquire", "write", "release", "releaseOwner", "has"].map((method) => [
              method,
              () => {},
            ]),
          ),
          fixtures: [{ id: "w", brand: "wiz", role: "all", position: 0 }],
        },
      }),
    /music_brightness_limits_unrepresentable/,
  );
  const e = environment(t);
  e.session.start(e.probe);
  await e.pump(300);
  assert.throws(
    () => e.session.configure({ minimumBrightness: 1 }),
    /music_brightness_limits_unrepresentable/,
  );
  await e.pump(300);
  assert.equal(e.session.snapshot().state, "running");
});

test("an asynchronous view callback cannot accumulate unbounded preview work", async (t) => {
  const e = environment(t, { preview: true, onFrame: async () => {} });
  e.session.start(e.probe);
  e.sample();
  e.session.tick();
  assert.equal((await e.session.done).reason, "music_preview_callback_must_be_sync");
  assert.equal(e.timers.size, 0);
});

test("source loss releases music without cancelling a separately owned temporary effect", async (t) => {
  const e = environment(t);
  e.session.start(e.probe);
  await e.pump(500);
  const effect = await e.broker.acquire({ fixtureId: "h", owner: "test.effect", kind: "effect" });
  await e.broker.write(effect.token, { on: true, bri: 150 });
  e.advance(251);
  await e.session.done;
  assert.deepEqual(e.states.get("h"), { on: true, bri: 150 });
  assert.deepEqual(e.states.get("w"), e.initial.get("w"));
  assert.equal(e.broker.has(effect.token), true);
  await e.broker.release(effect.token);
  assert.deepEqual(e.states, e.initial);
});

test("Stop waits for confirmed helper exit and reports an unconfirmed exit honestly", async (t) => {
  const e = environment(t, { preview: true });
  e.probe.stop = () => {};
  e.session.start(e.probe);
  e.sample();
  e.session.tick();
  const result = await e.session.stop();
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "music_capture_stop_unconfirmed");
  assert.equal(e.timers.size, 0);
  assert.equal(e.probe.events.listenerCount("update"), 0);
  e.close();
});

test("Entertainment preheat gates all frames and enables independent sixteen-Hz Hue slots", async (t) => {
  let finish,
    stopped = 0;
  const barrier = new Promise((r) => {
    finish = r;
  });
  const e = environment(t, {
    settings: { outputHz: 16 },
    extraHue: true,
    prepare: () => barrier,
    stopTransport: () => {
      stopped++;
    },
  });
  e.session.start(e.probe);
  await e.pump(400);
  assert.equal(e.session.snapshot().state, "preheating");
  const schema = require("../contracts/music-controller-v1.contracts.json").contracts.find(
    (c) => c.capability === "music.session.v1",
  ).methods.status.response.properties.session;
  assert(
    require("../../../src/shared/contracts/bounded-json-schema").validateValue(
      schema,
      e.session.snapshot(),
    ),
    "preheating is a public lifecycle state, including before the first command",
  );
  assert.equal(e.writes.length, 0);
  assert.equal(e.frames.length, 0);
  finish({ ok: true, activeIds: ["h", "h2"] });
  await flush();
  await e.pump(1000);
  assert.equal(e.session.snapshot().state, "running");
  const hue = e.session.snapshot().outputCadence.fixtureHz.filter((f) => f.brand === "hue");
  assert.ok(hue.every((f) => f.hz === 16 && f.delivery.completed >= 12));
  assert.ok(
    e.writes.filter((f) => f.id.startsWith("h")).every((f) => f.state.__entertainment === true),
  );
  await e.session.stop();
  assert.equal(stopped, 1);
  assert.deepEqual(e.states, e.initial);
});

test("failed Entertainment preheat emits no frames, acquires no lights and stops capture", async (t) => {
  const e = environment(t, {
    prepare: async () => ({ ok: false, error: "hue_entertainment_start_timeout" }),
  });
  e.session.start(e.probe);
  await e.pump(100);
  const result = await e.session.done;
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "hue_entertainment_start_timeout");
  assert.equal(e.frames.length, 0);
  assert.equal(e.writes.length, 0);
  assert.equal(e.broker.snapshot().fixtures.length, 0);
});

test("Entertainment transport markers stay private and status remains valid after Stop", async (t) => {
  const e = environment(t, {
    prepare: async () => ({ ok: true, activeIds: ["h"] }),
    settings: { preset: "pulse", outputHz: 16, maximumBrightness: 100 },
  });
  const schema = require("../contracts/music-controller-v1.contracts.json").contracts.find(
    (c) => c.capability === "music.session.v1",
  ).methods.status.response.properties.session;
  const { validateValue } = require("../../../src/shared/contracts/bounded-json-schema");
  e.session.start(e.probe);
  await e.pump(1000);
  assert(
    e.writes.some((w) => w.id === "h" && w.state.__entertainment === true),
    "the adapter still receives the stream authorization marker",
  );
  const running = e.session.snapshot();
  assert.deepEqual(
    e.writes.filter((w) => w.id === "h").at(-1).state.__rgb,
    running.lastPreview.frames[0].rgb,
    "Hue streaming preserves the same mapped color as the preview",
  );
  assert.equal(
    Object.hasOwn(running.outputCadence.fixtureHz[0].delivery.lastCommand.state, "__rgb"),
    false,
  );
  assert.equal(running.outputCadence.fixtureHz[0].hz, 16);
  assert.equal(
    Object.hasOwn(running.outputCadence.fixtureHz[0].delivery.lastCommand.state, "__entertainment"),
    false,
  );
  assert(validateValue(schema, running));
  const stopped = await e.session.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.ownedFixtures, 0);
  assert(validateValue(schema, stopped), "stopped snapshots must remain contract-valid");
  assert.deepEqual(e.states, e.initial);
});

test("live fixture contrast edits retain capture and leases, exclude theatre lights and restore", async (t) => {
  const e = environment(t, { extraHue: true, sceneRoles: { w: { raveBehavior: "dim" } } });
  e.session.start(e.probe);
  await e.pump(800);
  const before = e.session.snapshot();
  e.session.setContrast(["h"], 55);
  let rows = e.session.inspect().assignments;
  assert.equal(rows.find((f) => f.id === "h").outOfSync, 55);
  assert.equal(rows.find((f) => f.id === "h2").outOfSync, 0);
  e.session.setContrast(null, 85);
  rows = e.session.inspect().assignments;
  assert.equal(rows.find((f) => f.id === "h2").outOfSync, 85);
  assert.equal(rows.find((f) => f.id === "w").outOfSync, 0);
  await e.pump(500);
  assert.equal(e.stops, 0);
  assert.equal(e.session.snapshot().ownedFixtures, before.ownedFixtures);
  assert.throws(() => e.session.setContrast(null, 101));
  await e.session.stop();
  assert.deepEqual(e.states, e.initial);
});
