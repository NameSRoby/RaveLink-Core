/** Real UDP peers behind the production adapter, fixture broker and feature
 * services. No physical lights, capture devices, accounts or live Core instance.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createSimulator } = require("./support/govee-lan-simulator.cjs");
const createAdapter = require("../src/adapters/brands/govee-lan.adapter");
const createOutput = require("../src/domains/fixtures/fixture-output-runtime");
const createEffects = require("../src/domains/twitch/twitch-light-effects.service");
const createProfiles = require("../src/domains/fixtures/lighting-profile.service");
const createOnboarding = require("../src/domains/fixtures/hardware-onboarding.service");
const createSession = require("../integrations/music-to-light/session.cjs");
const createHost = require("../src/domains/music-to-light/music-to-light.service");
const createColorCommand = require("../src/domains/twitch/color-command.service");
const createColorConfig = require("../src/domains/twitch/twitch-color-config.runtime");
const createPreview = require("../src/domains/colors/taught-color-preview.service");
const colors = require("../src/domains/colors/color-space");
const flush = () => new Promise((resolve) => setTimeout(resolve, 2));

async function lab(t, devices) {
  const sim = await createSimulator({ devices });
  const adapter = createAdapter({ dryRun: false, dgramRef: sim.transport, log: { warn() {} } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-govee-features-"));
  let at = 1000,
    rows = sim.fixtures().map((f) => ({
      ...f,
      name: f.id,
      zone: "room",
      enabled: true,
      engineEnabled: true,
      twitchEnabled: true,
    }));
  const listeners = new Set();
  const registry = {
    getFixtures: () => structuredClone(rows),
    listConfigured: () => rows.filter((f) => f.enabled),
    listEngineBy: (brand) =>
      rows.filter((f) => f.enabled && f.engineEnabled && (!brand || brand === f.brand)),
    listTwitchBy: (brand) =>
      rows.filter((f) => f.enabled && f.twitchEnabled && (!brand || brand === f.brand)),
    parseZoneList: () => ["all"],
    resolveZone: () => "all",
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    upsertFixtures: (fixtures) => {
      rows = fixtures;
      for (const fn of listeners) fn();
      return { ok: true, fixtures };
    },
  };
  const output = createOutput({
    fixtureRegistry: registry,
    adapters: { govee: adapter },
    now: () => at,
  });
  const directiveService = {
    parseTwitchColorDirective(text) {
      const percent = / (\d+)%$/.exec(text);
      if (percent) text = text.slice(0, percent.index);
      const hex = { red: "#ff0000", blue: "#0000ff", green: "#00ff00" }[text] || text;
      if (!/^#[a-f0-9]{6}$/i.test(hex)) return { ok: false };
      const rgb = Object.fromEntries(
        ["r", "g", "b"].map((k, i) => [k, parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)]),
      );
      return {
        ok: true,
        hex,
        wizState: colors.createWizStateFromRgb(rgb, {
          dimming: percent ? Number(percent[1]) : 100,
        }),
      };
    },
  };
  const effects = createEffects({
    storePath: path.join(root, "effects.json"),
    fixtureRegistry: registry,
    directiveService,
    adapters: output.adapters,
    outputOwnership: output.ownership,
    now: () => at,
    setInterval: () => 1,
    clearInterval() {},
    lightingLab: {
      settings: () => ({
        brightnessLimit: 80,
        durationSeconds: 0,
        repeatCount: 0,
        cooldownSeconds: 0,
        restorePrevious: true,
      }),
      isExcluded: () => false,
    },
  });
  effects.save({ ...effects.snapshot(), enabled: true, fixtureIds: rows.map((f) => f.id) });
  t.after(async () => {
    await effects.shutdown();
    await output.shutdown();
    adapter.shutdown();
    await sim.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    sim,
    adapter,
    registry,
    output,
    effects,
    root,
    directiveService,
    fixtures: rows,
    now: () => at,
    async advance(ms) {
      at += ms;
      await effects.tick();
      await flush();
    },
    change(fn) {
      rows = fn(rows);
      for (const listener of listeners) listener();
    },
  };
}

for (const onOff of [0, 1])
  for (const white of [false, true]) {
    test(`Govee native restoration round trip: ${onOff ? "on" : "off"}, ${white ? "white" : "RGB"}`, async (t) => {
      const e = await lab(t, [
        {
          id: "bulb",
          ip: "127.0.0.111",
          temperature: true,
          sku: "H6008",
          state: {
            onOff,
            brightness: 23,
            color: { r: 14, g: 73, b: 150 },
            colorTemInKelvin: white ? 3800 : 0,
          },
        },
      ]);
      const [f] = e.fixtures;
      const baseline = (await e.adapter.readState(f)).state;
      const lease = await e.output.ownership.acquire({
        fixtureId: f.id,
        owner: "test",
        kind: "effect",
      });
      await e.output.ownership.write(lease.token, { on: true, dimming: 95, r: 255, g: 0, b: 10 });
      await e.sim.waitFor(() => e.sim.snapshot(f.id).brightness === 95);
      const before = e.sim.history().length;
      assert.equal((await e.output.ownership.release(lease.token)).failed, 0);
      assert.deepEqual((await e.adapter.readState(f)).state, baseline);
      if (!onOff)
        assert(
          !e.sim
            .history()
            .slice(before)
            .some((c) => c.command === "turn" && c.data.value === 1),
          "off restoration must never flash on",
        );
    });
  }

for (const command of [
  "cycle red, blue",
  "fade red, blue",
  "rainbow",
  "wave red, blue",
  "chase red, blue",
  "sweep red, blue",
  "ripple red, blue",
  "breathe red",
]) {
  test(`Govee viewer/channel-point effect runs through real output ownership: ${command}`, async (t) => {
    const e = await lab(t);
    const baseline = await Promise.all(e.fixtures.map((f) => e.adapter.readState(f)));
    const started = await e.effects.handle(command, { fixtureIds: e.fixtures.map((f) => f.id) });
    assert.equal(started.ok, true, JSON.stringify(started));
    for (let i = 0; i < 8; i++) await e.advance(250);
    const writes = e.sim.history().filter((c) => c.command === "colorwc");
    assert(writes.length >= 2);
    assert(writes.every((c) => c.accepted));
    assert(
      e.sim
        .history()
        .filter((c) => c.command === "brightness")
        .every((c) => c.data.value <= 80),
    );
    await e.effects.handle("stop", { fixtureIds: e.fixtures.map((f) => f.id) });
    await e.sim.waitFor(() => e.fixtures.every((f) => e.sim.snapshot(f.id).brightness === 37));
    await e.effects.waitForFixtureWrites(e.fixtures.map((f) => f.id));
    for (let i = 0; i < e.fixtures.length; i++)
      assert.deepEqual((await e.adapter.readState(e.fixtures[i])).state, baseline[i].state);
  });
}

test("Govee shared and individual profiles deliver RGB, white, off and independent brightness", async (t) => {
  const e = await lab(t);
  const profiles = createProfiles({
    storePath: path.join(e.root, "profiles.json"),
    fixtureRegistry: e.registry,
    directiveService: e.directiveService,
    adapters: e.output.adapters,
    twitchLightEffects: e.effects,
  });
  const [a, b] = e.fixtures;
  assert.equal(
    profiles.save({
      id: "scene",
      strategy: "individual",
      fixtureTargets: {
        [a.id]: { mode: "temperature", temperatureKelvin: 4200, brightness: 41 },
        [b.id]: { mode: "color", color: "#123456", brightness: 67 },
      },
    }).ok,
    true,
  );
  assert.equal((await profiles.apply("scene")).failed, 0);
  await e.sim.waitFor(
    () => e.sim.snapshot(a.id).colorTemInKelvin === 4200 && e.sim.snapshot(b.id).color.b === 86,
  );
  assert.equal(e.sim.snapshot(a.id).brightness, 41);
  assert.equal(e.sim.snapshot(b.id).brightness, 67);
  profiles.save({
    id: "off",
    strategy: "shared",
    sharedTarget: { on: false },
    fixtureTargets: { [a.id]: {}, [b.id]: {} },
  });
  await profiles.apply("off");
  await e.sim.waitFor(() => e.fixtures.every((f) => e.sim.snapshot(f.id).onOff === 0));
});

test("Govee discovery commits usable fixtures and tests their status through onboarding", async (t) => {
  const e = await lab(t);
  const onboarding = createOnboarding({
    core: {
      fixtureRegistry: e.registry,
      hueBridge: {},
      wizBridge: {},
      goveeBridge: e.output.adapters.govee,
    },
  });
  const discovery = await onboarding.discover("govee", { timeoutMs: 300 });
  assert.equal(discovery.ok, true);
  const targets = onboarding.recordDiscovery("govee", discovery.devices);
  const result = onboarding.commitGovee({
    selectionTokens: targets.map((f) => f.selectionToken),
    zone: "room",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.support, "lan-whole-device");
  for (const f of e.registry.getFixtures())
    assert.equal((await e.output.adapters.govee.readState(f)).ok, true);
});

test("Govee manual override revokes a temporary lease and stale Stop cannot undo the user's color", async (t) => {
  const e = await lab(t),
    [f] = e.fixtures;
  const grant = await e.output.ownership.acquire({
    fixtureId: f.id,
    owner: "rave",
    kind: "effect",
  });
  await e.output.ownership.write(grant.token, { on: true, dimming: 88, r: 255, g: 0, b: 0 });
  await e.output.adapters.govee.sendState([f], { on: true, dimming: 45, r: 0, g: 0, b: 255 });
  await e.output.ownership.release(grant.token);
  await e.sim.waitFor(() => e.sim.snapshot(f.id).color.b === 255);
  assert.equal(e.sim.snapshot(f.id).brightness, 45);
});

test("Govee lost datagram is recovered by verified restoration; persistent loss is reported", async (t) => {
  const e = await lab(t),
    [f] = e.fixtures;
  const baseline = (await e.adapter.readState(f)).state;
  e.adapter.sendState([f], { on: true, dimming: 90, r: 200, g: 0, b: 0 });
  await e.sim.waitFor(() => e.sim.snapshot(f.id).brightness === 90);
  e.sim.faults(f.id, { dropNextCommands: 3 });
  assert.equal((await e.adapter.restoreState([f], baseline)).sent, 1);
  e.sim.faults(f.id, { dropCommands: ["colorwc"] });
  const failed = await e.adapter.restoreState([f], { on: true, dimming: 50, r: 1, g: 1, b: 1 });
  assert.equal(failed.failed, 1);
  assert.equal(failed.error, "govee_restore_unverified");
});

test("Govee offline and invalid status block temporary effects before any light command", async (t) => {
  const e = await lab(t),
    [f] = e.fixtures;
  e.sim.faults(f.id, { statusOverride: {} });
  await assert.rejects(
    e.output.ownership.acquire({ fixtureId: f.id, owner: "test", kind: "music" }),
    /fixture_baseline_unavailable/,
  );
  assert(!e.sim.history().some((c) => ["turn", "brightness", "colorwc"].includes(c.command)));
});

async function music(t, e, fixtureOptions, settings = {}) {
  let frame = 0,
    end;
  const events = new EventEmitter();
  const generation = "a".repeat(32);
  const probe = {
    events,
    done: new Promise((r) => {
      end = r;
    }),
    snapshot: () => ({ generation }),
    stop: () => end({}),
  };
  const session = createSession({
    settings,
    now: e.now,
    setTimeout: () => 1,
    clearTimeout() {},
    output: {
      ownership: e.output.ownership,
      kind: "effect",
      fixtures: e.fixtures.map((f, i) => ({
        id: f.id,
        brand: f.brand,
        role: i ? "high" : "low",
        position: i / Math.max(1, e.fixtures.length - 1),
        ...fixtureOptions?.[i],
      })),
    },
  });
  t.after(() => session.stop());
  await session.start(probe);
  async function pump(ms, rms = 0.2) {
    for (let at = 0; at < ms; at += 25) {
      await e.advance(25);
      events.emit("update", {
        type: "level",
        generation,
        endFrame: ++frame * 1200,
        discontinuities: 0,
        rms,
        signal: rms ? "signal" : "silence",
        invalidSamples: 0,
        freshness: { verified: true, maxAgeMs: 0, stale: false },
        analysis: { valid: true, bandRms: [rms * 0.9, rms * 0.5, rms * 0.3], onset: null },
      });
      session.tick();
      await flush();
    }
  }
  return { session, pump, probe };
}

for (const warmCoolColors of [false, true])
  for (const colorMode of ["fixed", "travel", "onsets", "roles", "energy"]) {
    test(`Govee music color ${colorMode}, warm/cool ${warmCoolColors}, contrast and generated palette keep bounds`, async (t) => {
      const e = await lab(t);
      const m = await music(t, e, [{ outOfSync: 0 }, { outOfSync: 100 }], {
        preset: "bands",
        colorMode,
        warmCoolColors,
        outputHz: 16,
        minimumBrightness: 4,
        maximumBrightness: 72,
        recipeOptions: { palette: { mode: "fixed", value: "generated", allowed: ["generated"] } },
      });
      await m.pump(500, 0.03);
      await m.pump(500, 0.25);
      const commands = e.sim.history().filter((c) => c.command === "colorwc");
      assert(commands.length >= 4);
      assert(commands.every((c) => c.accepted));
      assert(
        e.sim
          .history()
          .filter((c) => c.command === "brightness")
          .every((c) => c.data.value >= 4 && c.data.value <= 72),
      );
      for (const row of m.session.snapshot().outputCadence.fixtureHz) {
        assert(row.delivery.completed > 0);
        assert(row.delivery.completedHz <= 8.1);
        assert(
          row.delivery.lastCommand.state.dimming >= 4 &&
            row.delivery.lastCommand.state.dimming <= 72,
        );
      }
      await m.session.stop();
      assert(e.fixtures.every((f) => e.sim.snapshot(f.id).brightness === 37));
    });
  }

test("Govee music capture failure restores both fixtures and releases their leases", async (t) => {
  const e = await lab(t),
    m = await music(t, e);
  await m.pump(500);
  m.probe.stop();
  await m.session.done;
  await e.sim.waitFor(() => e.fixtures.every((f) => e.sim.snapshot(f.id).brightness === 37));
  assert.equal(e.output.diagnostics().ownedFixtures, 0);
});

test("Govee temporary effects suspend music and release back to its latest live intent", async (t) => {
  const e = await lab(t),
    [f] = e.fixtures;
  const grant = await e.output.ownership.acquire({
    fixtureId: f.id,
    kind: "music",
    owner: "music",
  });
  await e.output.ownership.write(
    grant.token,
    { on: true, dimming: 25, r: 5, g: 50, b: 100 },
    { sampledAt: e.now() },
  );
  await e.effects.handle("cycle red, blue", { fixtureIds: [f.id] });
  assert.equal(
    (
      await e.output.ownership.write(
        grant.token,
        { on: true, dimming: 62, r: 4, g: 80, b: 150 },
        { sampledAt: e.now() },
      )
    ).suspended,
    true,
  );
  await e.effects.handle("stop", { fixtureIds: [f.id] });
  await e.sim.waitFor(() => e.sim.snapshot(f.id).brightness === 62);
  assert.equal(e.sim.snapshot(f.id).color.b, 150);
  await e.output.ownership.release(grant.token);
  assert.equal(e.sim.snapshot(f.id).brightness, 37);
});

test("Govee static chat routing and taught-color preview use real LAN writes and restore", async (t) => {
  const e = await lab(t),
    [f] = e.fixtures;
  const config = createColorConfig({
    configPath: path.join(e.root, "colors.json"),
    configDefault: {
      defaultTarget: "govee",
      autoDefaultTarget: false,
      prefixes: { govee: "govee" },
      fixturePrefixes: {},
    },
  });
  const service = createColorCommand({
    twitchColorConfig: config,
    fixtureRegistry: e.registry,
    directiveService: e.directiveService,
    goveeBridge: e.output.adapters.govee,
  });
  assert.equal((await service.applyColorText("govee blue")).ok, true);
  await e.sim.waitFor(() => e.sim.snapshot(f.id).color.b === 255);
  const preview = createPreview({
    colorCommandService: service,
    directiveService: e.directiveService,
    fixtureRegistry: e.registry,
    outputOwnership: e.output.ownership,
    setTimeout: () => 1,
    clearTimeout() {},
  });
  t.after(() => preview.shutdown());
  assert.equal((await preview.preview("#ff0000")).ok, true);
  await e.sim.waitFor(() => e.sim.snapshot(f.id).color.r === 255);
  await preview.shutdown();
  assert.deepEqual((await e.adapter.readState(f)).state, {
    on: true,
    dimming: 100,
    r: 0,
    g: 0,
    b: 255,
  });
});

test("Govee removal invalidates the lease and prevents obsolete frames targeting a removed fixture", async (t) => {
  const e = await lab(t),
    [f] = e.fixtures;
  const grant = await e.output.ownership.acquire({ fixtureId: f.id, kind: "music", owner: "test" });
  e.change((rows) => rows.filter((row) => row.id !== f.id));
  const before = e.sim.history().length;
  await assert.rejects(
    e.output.ownership.write(grant.token, { on: false }, { sampledAt: e.now() }),
    /fixture_lease_expired_or_replaced/,
  );
  assert.equal(e.sim.history().length, before);
});

test("Govee full 64-fixture selection acquires, writes and restores with one bounded sender", async (t) => {
  const e = await lab(
    t,
    Array.from({ length: 64 }, (_, i) => ({
      id: `bulb-${i}`,
      ip: `127.0.0.${120 + i}`,
      sku: "H6008",
      temperature: true,
    })),
  );
  const leases = await Promise.all(
    e.fixtures.map((f) =>
      e.output.ownership.acquire({ fixtureId: f.id, owner: "test", kind: "music" }),
    ),
  );
  const state = { on: true, dimming: 83, r: 235, g: 17, b: 82 };
  const writes = await Promise.all(
    leases.map((l) => e.output.ownership.write(l.token, state, { sampledAt: e.now() })),
  );
  assert(writes.every((w) => w.sent === 1));
  await e.sim.waitFor(() => e.fixtures.every((f) => e.sim.snapshot(f.id).color.b === 82));
  assert.equal(e.adapter.getTelemetry().resources.persistentSockets, 1);
  const restored = await Promise.all(leases.map((l) => e.output.ownership.release(l.token)));
  assert(
    restored.every((r) => r.failed === 0),
    JSON.stringify(restored),
  );
  assert(e.fixtures.every((f) => e.sim.snapshot(f.id).brightness === 37));
  e.adapter.shutdown();
  assert.equal(e.adapter.getTelemetry().resources.persistentSockets, 0);
});

for (const preset of ["pulse", "bands", "ambient"]) {
  test(`Govee Music-to-Light ${preset} renders bounded RGB and restores after Stop`, async (t) => {
    const e = await lab(t);
    const baseline = await Promise.all(e.fixtures.map((f) => e.adapter.readState(f)));
    const m = await music(t, e, null, {
      preset,
      outputHz: 16,
      minimumBrightness: 5,
      maximumBrightness: 85,
    });
    await m.pump(1000, 0.06);
    await m.pump(1000, 0.3);
    assert(e.sim.history().filter((c) => c.command === "colorwc").length >= 4);
    assert(
      e.sim
        .history()
        .filter((c) => c.command === "brightness")
        .every((c) => c.data.value >= 5 && c.data.value <= 85),
    );
    for (const row of m.session.snapshot().outputCadence.fixtureHz)
      assert(row.hz <= 8, JSON.stringify(row));
    await m.session.stop();
    for (let i = 0; i < e.fixtures.length; i++)
      assert.deepEqual((await e.adapter.readState(e.fixtures[i])).state, baseline[i].state);
  });
}

for (const raveBehavior of ["dim", "steady", "off"]) {
  test(`Govee Rave scene role ${raveBehavior} stays independent of loud audio`, async (t) => {
    const e = await lab(t);
    const m = await music(t, e, [
      { raveBehavior, sceneBrightness: 5, sceneFadeMs: 0 },
      { raveBehavior: "reactive" },
    ]);
    await m.pump(1500, 0.3);
    const f = e.sim.snapshot(e.fixtures[0].id);
    if (raveBehavior === "off") assert.equal(f.onOff, 0);
    else assert.equal(f.brightness, 5);
    await m.session.stop();
    assert.equal(e.sim.snapshot(e.fixtures[0].id).brightness, 37);
  });
}

test("Govee is selectable through the native Music-to-Light service/controller", async (t) => {
  const e = await lab(t);
  const host = createHost({
    core: { fixtureRegistry: e.registry, fixtureOutput: e.output },
    controllerOptions: { probeApi: { available: () => true, listSources: async () => [] } },
  });
  t.after(() => host.shutdown());
  assert.equal(host.view().fixtures.length, 2);
  await host.fixtures(e.fixtures.map((f, i) => ({ id: f.id, role: "all", position: i })));
  assert.equal(host.view().status.musicFixtureCount, 2);
});

for (const scenario of ["wash", "pulse", "bands", "wave", "bounce", "handoff"]) {
  test(`Govee channel-point Rave ${scenario} includes an unrouted dim companion and restores`, async (t) => {
    const e = await lab(t),
      [reactive, dim] = e.fixtures;
    const generation = "a".repeat(32),
      source = {
        id: "process:10:20",
        label: "Simulated player",
        kind: "application",
        scope: "process_tree",
      };
    let renderer,
      finish,
      capture,
      frame = 0;
    const host = createHost({
      core: { fixtureRegistry: e.registry, fixtureOutput: e.output, twitchLightEffects: e.effects },
      controllerOptions: {
        now: e.now,
        setInterval: () => 1,
        clearInterval() {},
        readPlayback: async () => null,
        probeApi: {
          available: () => true,
          listSources: async () => [source],
          capture() {
            capture = {
              events: new EventEmitter(),
              done: new Promise((resolve) => {
                finish = resolve;
              }),
              snapshot: () => ({ generation }),
              stop: () => finish({}),
            };
            return capture;
          },
        },
        sessionFactory(options) {
          renderer = createSession({ ...options, setTimeout: () => 1, clearTimeout() {} });
          return renderer;
        },
      },
    });
    t.after(() => host.shutdown());
    await host.permissions({ capture: true, output: true });
    await host.call({ capability: "music.sources.v1", method: "list", payload: null });
    await host.source(source.id);
    await host.fixtures([
      { id: reactive.id, role: "low", position: 0 },
      {
        id: dim.id,
        role: "high",
        position: 1,
        raveBehavior: "dim",
        sceneBrightness: 5,
        sceneFadeMs: 0,
      },
    ]);
    await host.call({
      capability: "music.styles.v1",
      method: "configure",
      payload: {
        ...host.view().design,
        raveEnabled: true,
        raveScenario: scenario,
        minimumBrightness: 4,
        maximumBrightness: 80,
      },
    });
    e.effects.setMusicHandler({
      start: host.rave,
      check: host.checkRave,
      stop: host.stopRave,
      ids: host.raveIds,
      routedIds: host.raveRouteIds,
    });
    const started = await e.effects.handle("rave", { fixtureIds: [reactive.id] });
    assert.equal(started.ok, true, JSON.stringify(started));
    for (let i = 0; i < 40; i++) {
      await e.advance(25);
      capture.events.emit("update", {
        type: "level",
        generation,
        endFrame: ++frame * 1200,
        discontinuities: 0,
        rms: i < 20 ? 0.06 : 0.3,
        signal: "signal",
        invalidSamples: 0,
        freshness: { verified: true, maxAgeMs: 0, stale: false },
        analysis: { valid: true, bandRms: [0.2, 0.1, 0.05], onset: null },
      });
      renderer.tick();
      await flush();
    }
    assert.equal(e.sim.snapshot(dim.id).brightness, 5);
    assert.deepEqual(e.sim.snapshot(dim.id).color, { r: 25, g: 90, b: 160 });
    assert(e.sim.history().some((c) => c.device === reactive.id && c.command === "colorwc"));
    await e.effects.handle("stop", { fixtureIds: [reactive.id] });
    assert(e.fixtures.every((f) => e.sim.snapshot(f.id).brightness === 37));
  });
}
