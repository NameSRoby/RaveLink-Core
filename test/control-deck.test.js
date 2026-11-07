const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const create = require("../src/domains/control-deck/control-deck.service");
const { validate, defaults } = require("../src/domains/control-deck/control-deck-config");
const schema = { type: "object", properties: {}, additionalProperties: false };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("manual Rave toggle stays owner-driven, restores on its next press and derives fixture LEDs", async () => {
  const view = {
      installed: true,
      captureAvailable: true,
      status: {
        state: "idle",
        sourceSelected: true,
        permissions: { capture: true, output: true },
        musicFixtureCount: 2,
      },
      design: { raveEnabled: true, palette: ["#ff0000", "#0000ff"] },
      bindings: {
        fixtures: [{ colorSlot: 0 }, { colorSlot: 1, raveBehavior: "dim", sceneBrightness: 20 }],
      },
    },
    writes = [];
  const adapter = require("../src/domains/control-deck/control-deck-music-actions")({
    music: {
      view: () => structuredClone(view),
      async manualRave(request) {
        writes.push(request);
        view.status.state = "running";
      },
      async call(request) {
        writes.push(request.method);
        view.status.state = "idle";
        return { ok: true };
      },
    },
  });
  const row = () => adapter.catalog().find((action) => action.id === "music.rave-toggle");
  assert.deepEqual(row().profileLighting, [
    { color: "#ff0000", level: 1 },
    { color: "#0000ff", level: 0.2 },
  ]);
  assert.match(row().label, /until restored/);
  await adapter.execute("music.rave-toggle");
  assert.deepEqual(writes, [{ untilStopped: true }]);
  assert.equal(row().state.tone, "active");
  view.rave = { lighting: [{ color: "#00ff00", level: 1 }] };
  assert.deepEqual(
    row().profileLighting,
    view.rave.lighting,
    "active recipe colors replace the saved preview",
  );
  view.captureAvailable = false;
  view.design.raveEnabled = false;
  assert.equal(row().available, true, "stop remains available after start permissions change");
  assert.equal(row().label, "Stop Rave & restore");
  await adapter.execute("music.rave-toggle");
  assert.deepEqual(writes, [{ untilStopped: true }, "stop"]);
  assert.equal(row().available, false);
});

test("music toggles follow owner state, serialize opposing presses and preserve explicit macro actions", async () => {
  const view = {
      installed: true,
      autoRaveEnabled: false,
      captureAvailable: true,
      status: {
        state: "idle",
        sourceSelected: true,
        permissions: { capture: true, output: true },
        musicFixtureCount: 1,
      },
      design: { raveEnabled: true },
    },
    writes = [];
  const adapter = require("../src/domains/control-deck/control-deck-music-actions")({
    music: {
      view: () => structuredClone(view),
      async songPolicy(value) {
        await flush();
        writes.push(["auto", value.enabled]);
        view.autoRaveEnabled = value.enabled;
        return { enabled: value.enabled };
      },
      async call(request) {
        await flush();
        writes.push(["session", request.method]);
        view.status.state = request.method === "start" ? "running" : "idle";
        return { ok: true };
      },
    },
  });
  const find = (id) => adapter.catalog().find((row) => row.id === id);
  assert.equal(writes.length, 0, "catalog reads must not enable capture or output");
  assert.equal(find("music.auto-toggle").label, "Enable Auto-Rave");
  view.autoRaveEnabled = true;
  assert.equal(
    find("music.auto-toggle").label,
    "Disable Auto-Rave",
    "external owner changes take effect immediately",
  );
  await Promise.all([adapter.execute("music.auto-toggle"), adapter.execute("music.auto-toggle")]);
  assert.deepEqual(writes.splice(0), [
    ["auto", false],
    ["auto", true],
  ]);
  await Promise.all([
    adapter.execute("music.auto", { enabled: false }),
    adapter.execute("music.auto-toggle"),
  ]);
  assert.deepEqual(writes.splice(0), [
    ["auto", false],
    ["auto", true],
  ]);
  await Promise.all([adapter.execute("music.toggle"), adapter.execute("music.toggle")]);
  assert.deepEqual(writes.splice(0), [
    ["session", "start"],
    ["session", "stop"],
  ]);
  view.status.state = "running";
  view.captureAvailable = false;
  view.status.permissions.output = false;
  assert.equal(
    find("music.toggle").available,
    true,
    "a running Rave can always be stopped after permissions change",
  );
  assert.equal(find("music.toggle").label, "Stop lights & restore");
  await adapter.execute("music.toggle");
  assert.deepEqual(writes.splice(0), [["session", "stop"]]);
  assert.equal(
    find("music.toggle").available,
    false,
    "starting still requires the existing owner grants",
  );
});

test("music toggles keep unknown state neutral, propagate restore failure and cancel queued writes", async () => {
  let state = "unknown",
    enabled = null,
    release;
  const writes = [],
    adapter = require("../src/domains/control-deck/control-deck-music-actions")({
      music: {
        view: () => ({ autoRaveEnabled: enabled, status: { state } }),
        songPolicy: async (value) => {
          writes.push(value);
          enabled = value.enabled;
          await new Promise((resolve) => {
            release = resolve;
          });
        },
        call: async () => ({ session: { failedOperations: 1 } }),
      },
    });
  assert.equal(adapter.catalog().find((row) => row.id === "music.toggle").state.tone, "unknown");
  assert.equal(adapter.catalog().find((row) => row.id === "music.auto-toggle").available, false);
  await assert.rejects(adapter.execute("music.toggle"), /music_session_state_unknown/);
  await assert.rejects(adapter.execute("music.auto-toggle"), /music_auto_state_unknown/);
  state = "running";
  await assert.rejects(adapter.execute("music.toggle"), /lighting_restore_failed/);
  assert.equal(
    adapter.catalog().find((row) => row.id === "music.toggle").state.tone,
    "active",
    "a failed command never flips an optimistic local flag",
  );
  enabled = false;
  const first = adapter.execute("music.auto-toggle"),
    controller = new AbortController();
  const second = adapter.execute("music.auto-toggle", {}, controller.signal);
  const rejected = assert.rejects(second, /control_deck_cancelled/);
  await flush();
  controller.abort();
  release();
  await first;
  await rejected;
  assert.deepEqual(writes, [{ enabled: true }]);
});

test("Discord button feedback separates confirmed semantic state, unknown state and availability", async () => {
  const adapter = require("../packages/bundled-mods/discord-controls/main");
  let value;
  adapter.activate({ callCapability: async () => ({ ok: true, value }) });
  for (const [method, property, tones] of [
    ["status", "muted", ["unmuted", "muted"]],
    ["deafenStatus", "deafened", ["listening", "deafened"]],
  ]) {
    for (const state of [false, true]) {
      value = { available: true, bound: true, [property]: state };
      const { feedback } = await adapter.handleRequest({ method });
      assert.equal(feedback.state, tones[Number(state)], `${method}: ${state}`);
      assert.equal(feedback.active, state);
      assert.equal(feedback.available, true);
      assert.equal(feedback.color, undefined, "appearance is chosen from semantic status");
    }
    value = { available: true, bound: true, [property]: null };
    const unknown = (await adapter.handleRequest({ method })).feedback;
    assert.equal(unknown.state, "unknown");
    assert.equal(
      unknown.available,
      true,
      "unknown state does not disable an otherwise usable action",
    );
    value = { available: false, bound: true, [property]: true };
    const unavailable = (await adapter.handleRequest({ method })).feedback;
    assert.equal(unavailable.state, "unavailable");
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.active, false);
  }
});

test("explicit playback actions expose the same confirmed owner feedback as the playback toggle", async () => {
  for (const paused of [false, true, null]) {
    const adapter = require("../src/domains/control-deck/control-deck-actions")({
      core: { lightingProfiles: { snapshot: () => ({ profiles: [] }) } },
      music: { view: () => ({ captureAvailable: false, status: { permissions: {} }, design: {} }) },
      getFeatures: () => ({
        list: () => ({ features: [{ id: "song-request", lifecycle: "active" }] }),
        request: async (_feature, capability, method) => {
          assert.equal(method, "status", "catalog refresh must never perform a playback write");
          if (capability === "song.player.preferences.v1")
            return { ok: true, value: { player: "tidal" } };
          if (capability === "song.tidal.experimental.v1")
            return { ok: true, value: { connected: true, ready: true, current: { paused } } };
          if (capability === "song.playback.read.v1")
            return { ok: true, value: { control: { paused: paused !== true } } };
          return { ok: true, value: { paused: false } };
        },
      }),
    });
    await adapter.refresh();
    const catalog = adapter.catalog(),
      actual = catalog.find((row) => row.id === "song.playback-toggle").state;
    assert.equal(actual.tone, paused === null ? "unknown" : paused ? "paused" : "active");
    for (const id of ["song.playback-pause", "song.playback-resume"])
      assert.deepEqual(catalog.find((row) => row.id === id).state, actual);
  }
});

test("light actions and popup navigation reuse bounded existing manual owners without output on catalog reads", async () => {
  const writes = [],
    fixtures = [{ id: "desk" }, { id: "wall" }];
  const adapter = require("../src/domains/control-deck/control-deck-actions")({
    core: {
      fixtureRegistry: { listEngineBy: () => fixtures },
      lightingProfiles: { snapshot: () => ({ profiles: [] }) },
      colorCommandService: {
        applyColorText: async (text, options) => {
          writes.push({ text, options });
          return { ok: true };
        },
      },
    },
    music: { view: () => ({ captureAvailable: false, status: { permissions: {} }, design: {} }) },
  });
  const catalog = adapter.catalog();
  assert.deepEqual(catalog.find((row) => row.id === "view.rewards").navigation, {
    panel: "rewards",
  });
  assert.deepEqual(catalog.find((row) => row.id === "view.lights-controls").navigation, {
    panel: "lights",
  });
  assert.equal(writes.length, 0);
  await adapter.execute(
    "light.static",
    { scope: "fixture", fixtureId: "desk", color: "#ff0044", brightness: 45 },
    new AbortController().signal,
  );
  assert.deepEqual(writes[0], {
    text: "#ff0044 45%",
    options: { mode: "direct", target: "both", targetExplicit: true, fixtureId: "desk" },
  });
  await adapter.execute(
    "light.static",
    { scope: "all", color: "#000000", brightness: 0 },
    new AbortController().signal,
  );
  assert.equal(writes[1].options.fixtureId, undefined);
  for (const params of [
    { scope: "fixture", fixtureId: "foreign", color: "#ff0044", brightness: 45 },
    { scope: "all", color: "red;anything", brightness: 50 },
    { scope: "all", color: "#ff0044", brightness: 101 },
  ])
    await assert.rejects(
      adapter.execute("light.static", params, new AbortController().signal),
      /control_deck_light_target_invalid/,
    );
  assert.equal(writes.length, 2);
});
function environment(t, invoke = async () => ({ ok: true })) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-deck-"));
  let available = true;
  const actions = {
    catalog: () => [
      { id: "test.run", available, parameters: schema },
      { id: "test.fail", available: true, parameters: schema },
      {
        id: "test.volume",
        available: true,
        parameters: {
          type: "object",
          properties: { level: { type: "integer", minimum: 0, maximum: 100 } },
          required: ["level"],
          additionalProperties: false,
        },
        control: { type: "slider", parameter: "level", min: 0, max: 100, step: 1 },
      },
    ],
    execute: invoke,
  };
  const service = create({ runtimeDir, actions });
  t.after(async () => {
    await service.shutdown();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const config = (steps = [{ actionId: "test.run", params: {}, delayMs: 0 }], extra = {}) =>
    validate({
      version: 1,
      mode: "deck",
      columns: 5,
      pages: [
        {
          id: "main",
          name: "Main",
          buttons: [{ id: "button", title: "Test", kind: "macro", steps, ...extra }],
        },
      ],
    });
  return {
    service,
    runtimeDir,
    config,
    actions,
    unavailable: () => {
      available = false;
    },
  };
}
async function idle(service) {
  for (let i = 0; i < 100; i++) {
    if (!service.snapshot().running.length) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("macro did not drain");
}
test("deck config persists privately with optimistic revision and rejects invalid folders/media/code", async (t) => {
  const e = environment(t);
  assert.equal(defaults().pages.length, 2);
  assert.equal(defaults().pages[1].mixer.enabled, true);
  assert.equal(defaults().pages[0].id, "quick-access");
  const starterActions = defaults().pages[0].buttons.flatMap((button) =>
    button.steps.map((step) => step.actionId),
  );
  assert(starterActions.includes("music.toggle"));
  assert(starterActions.includes("music.auto-toggle"));
  assert(!starterActions.includes("music.start") && !starterActions.includes("music.stop"));
  const saved = e.service.save(e.config(), 0);
  assert.equal(saved.revision, 1);
  assert.equal(
    create({ runtimeDir: e.runtimeDir, actions: e.actions }).snapshot().config.mode,
    "deck",
  );
  assert.throws(() => e.service.save(e.config(), 0), /revision_conflict/);
  assert.throws(() => e.config([], { kind: "folder", pageId: "missing" }), /folder_invalid/);
  assert.throws(
    () => e.config(undefined, { appearance: { imageId: "C:\\private\\image.png" } }),
    /appearance_invalid/,
  );
  assert.throws(() => e.config(undefined, { code: "process.exit()" }), /button_invalid/);
  assert.throws(
    () => e.config([{ actionId: "test.run", params: {}, delayMs: 10001 }]),
    /steps_invalid/,
  );
});

test("old layouts acquire responsive defaults and bounded custom layouts round-trip", () => {
  const config = defaults();
  delete config.layout;
  assert.deepEqual(validate(config).layout, {
    phoneColumns: 2,
    tabletColumns: 4,
    gap: 14,
    radius: 28,
    labelScale: 100,
    showStatus: true,
    shape: "square",
    backlight: 100,
    display: "auto",
    fullscreenMode: "scroll",
    fullscreenSwipe: false,
    fullscreenKeyboard: false,
    previousKey: "ArrowLeft",
    nextKey: "ArrowRight",
    keyboardButtons: false,
    sliderOrientation: "vertical",
    sliderStyle: "mixer",
    sliderPlacement: "dock",
    sliderDock: "end",
    sliderSnap: false,
    sliderIncrement: 5,
  });
  config.columns = 12;
  config.layout = {
    phoneColumns: 1,
    tabletColumns: 12,
    gap: 0,
    radius: 32,
    labelScale: 150,
    showStatus: false,
    shape: "wide",
    backlight: 0,
  };
  assert.deepEqual(validate(config).layout, {
    ...config.layout,
    display: "auto",
    fullscreenMode: "scroll",
    fullscreenSwipe: false,
    fullscreenKeyboard: false,
    previousKey: "ArrowLeft",
    nextKey: "ArrowRight",
    keyboardButtons: false,
    sliderOrientation: "vertical",
    sliderStyle: "mixer",
    sliderPlacement: "dock",
    sliderDock: "end",
    sliderSnap: false,
    sliderIncrement: 5,
  });
  for (const [key, value] of [
    ["phoneColumns", 0],
    ["tabletColumns", 13],
    ["gap", 33],
    ["radius", -1],
    ["labelScale", 151],
    ["backlight", 101],
    ["shape", "unknown"],
    ["showStatus", "true"],
    ["sliderSnap", "true"],
    ["sliderIncrement", 0],
    ["sliderIncrement", 101],
    ["sliderIncrement", 2.5],
    ["display", "invalid"],
    ["display", null],
    ["injected", true],
  ])
    assert.throws(
      () => validate({ ...config, layout: { ...config.layout, [key]: value } }),
      /layout_invalid/,
    );
  assert.throws(() => validate({ ...config, columns: 13 }), /config_invalid/);
  const button = config.pages[0].buttons[0];
  delete button.appearance.backlight;
  assert.equal(validate(config).pages[0].buttons[0].appearance.backlight, 65);
  for (const value of [-1, 101, 1.5, "65"])
    assert.throws(
      () =>
        validate({
          ...config,
          pages: [
            {
              ...config.pages[0],
              buttons: [{ ...button, appearance: { ...button.appearance, backlight: value } }],
            },
          ],
        }),
      /appearance_invalid/,
    );
});
test("display modes preserve explicit older button choices and normalize missing defaults", () => {
  const config = defaults(),
    button = config.pages[0].buttons[0];
  assert.equal(button.appearance.textMode, "auto");
  button.appearance.textMode = "image-text";
  delete config.layout.display;
  let restored = validate(config);
  assert.equal(restored.layout.display, "auto");
  assert.equal(restored.pages[0].buttons[0].appearance.textMode, "image-text");
  for (const mode of ["auto", "per-button", "image-text", "image", "text", "alternate"]) {
    config.layout.display = mode;
    restored = validate(config);
    assert.equal(restored.layout.display, mode);
    assert.equal(restored.pages[0].buttons[0].appearance.textMode, "image-text");
  }
  for (const mode of ["auto", "image-text", "image", "text", "alternate"]) {
    button.appearance.textMode = mode;
    assert.equal(validate(config).pages[0].buttons[0].appearance.textMode, mode);
  }
  for (const invalid of ["per-button", "invalid", null, false, {}, []]) {
    button.appearance.textMode = invalid;
    assert.throws(() => validate(config), /appearance_invalid/);
  }
});
test("macros run in order, stop on failure and advance switches only after success", async (t) => {
  const calls = [],
    e = environment(t, async (id) => {
      calls.push(id);
      return { ok: id !== "test.fail", code: "test_failure" };
    });
  e.service.save(
    e.config([{ actionId: "test.run", params: {}, delayMs: 0 }], {
      alternateSteps: [
        { actionId: "test.fail", params: {}, delayMs: 0 },
        { actionId: "test.run", params: {}, delayMs: 0 },
      ],
    }),
    0,
  );
  e.service.execute("button");
  await idle(e.service);
  assert.equal(e.service.snapshot().states.button.toggled, true);
  e.service.execute("button");
  await idle(e.service);
  assert.deepEqual(calls, ["test.run", "test.fail"]);
  assert.equal(e.service.snapshot().states.button.toggled, true);
  assert.equal(e.service.snapshot().states.button.lastResult.code, "test_failure");
});

test("custom toggle appearance is validated and visual edits preserve the shared press state", async (t) => {
  const e = environment(t, async () => ({ ok: true }));
  const config = e.config([{ actionId: "test.run", params: {}, delayMs: 0 }], {
    alternateSteps: [{ actionId: "test.run", params: {}, delayMs: 0 }],
    toggleStates: {
      off: { label: "Quiet", symbol: "Q", color: "#112233" },
      on: { label: "Live", symbol: "L", color: "#445566" },
    },
  });
  e.service.save(config, 0);
  e.service.execute("button");
  await idle(e.service);
  const updated = e.service.snapshot();
  assert.equal(updated.states.button.toggled, true);
  updated.config.pages[0].buttons[0].toggleStates.on.label = "Broadcast";
  e.service.save(updated.config, updated.revision);
  assert.equal(e.service.snapshot().states.button.toggled, true);
  e.service.execute("button");
  await idle(e.service);
  assert.equal(e.service.snapshot().states.button.toggled, false);
  const invalid = structuredClone(config);
  invalid.pages[0].buttons[0].toggleStates.on.color = "url(file:///private)";
  assert.throws(() => validate(invalid), /control_deck_toggle_invalid/);
  invalid.pages[0].buttons[0].toggleStates = config.pages[0].buttons[0].toggleStates;
  invalid.pages[0].buttons[0].alternateSteps = [];
  assert.throws(() => validate(invalid), /control_deck_toggle_invalid/);
});

test("keyboard bindings stay opt-in and reject duplicate or navigation-conflicting keys", () => {
  const config = defaults(),
    page = config.pages[0];
  page.buttons[0].activationKey = "Ctrl+Shift+KeyQ";
  assert.equal(validate(config).layout.keyboardButtons, false);
  assert.equal(validate(config).pages[0].buttons[0].activationKey, "Ctrl+Shift+KeyQ");
  page.buttons[1].activationKey = "Ctrl+Shift+KeyQ";
  assert.throws(() => validate(config), /key_conflict/);
  page.buttons[1].activationKey = "ArrowRight";
  config.layout = { fullscreenKeyboard: true };
  assert.throws(() => validate(config), /key_conflict/);
  config.layout.fullscreenKeyboard = false;
  assert.equal(validate(config).pages[0].buttons[1].activationKey, "ArrowRight");
  page.buttons[0].activationKey = "<script>";
  assert.throws(() => validate(config), /key_invalid/);
});
test("held and cancelled macros do not repeat, overlap or execute pending actions", async (t) => {
  const calls = [],
    e = environment(t, async (id) => {
      calls.push(id);
      return { ok: true };
    });
  e.service.save(
    e.config(undefined, { holdSteps: [{ actionId: "test.run", params: {}, delayMs: 300 }] }),
    0,
  );
  const run = e.service.execute("button", "hold");
  assert.throws(() => e.service.execute("button"), /busy/);
  assert.throws(() => e.service.save(e.config(), 1), /busy/);
  await flush();
  e.service.cancel(run.runId);
  await idle(e.service);
  assert.equal(calls.length, 0);
  assert.equal(e.service.snapshot().states.button.lastResult.code, "control_deck_cancelled");
});
test("permissions and availability are rechecked after a macro delay", async (t) => {
  let calls = 0;
  const e = environment(t, async () => {
    calls++;
    return { ok: true };
  });
  e.service.save(e.config([{ actionId: "test.run", params: {}, delayMs: 20 }]), 0);
  e.service.execute("button");
  e.unavailable();
  await idle(e.service);
  assert.equal(calls, 0);
  assert.equal(
    e.service.snapshot().states.button.lastResult.code,
    "control_deck_action_unavailable",
  );
});
test("slider execution may override only its saved approved parameter within bounds", async (t) => {
  const values = [],
    e = environment(t, async (_id, params) => {
      values.push(params.level);
      return { ok: true };
    });
  e.service.save(
    e.config([{ actionId: "test.volume", params: { level: 50 }, delayMs: 0 }], { kind: "slider" }),
    0,
  );
  assert.throws(() => e.service.execute("button", "press", 101), /slider_invalid/);
  e.service.execute("button", "press", 25);
  await idle(e.service);
  assert.deepEqual(values, [25]);
  assert.equal(e.service.snapshot().config.pages[0].buttons[0].steps[0].params.level, 50);
  e.service.save(e.config(), 1);
  assert.throws(() => e.service.execute("button", "press", 25), /slider_invalid/);
});
test("mod action metadata must target provided capabilities and capability changes revoke approval", () => {
  const manifest = require("../packages/bundled-mods/discord-controls/ravelink.mod.json");
  const {
    validateManifestV1,
  } = require("../src/capabilities/mod-platform/contracts/mod-manifest-v1");
  assert.equal(validateManifestV1(manifest).ok, true);
  const wrong = structuredClone(manifest);
  wrong.contributes.actions[0].capability = "arbitrary.system.v1";
  assert.equal(validateManifestV1(wrong).ok, false);
  const {
    canonicalGrant,
    grantFingerprint,
    diffGrants,
  } = require("../src/capabilities/mod-platform/packages/mod-approval-store");
  const before = canonicalGrant(manifest),
    after = canonicalGrant({ ...manifest, consumes: [...manifest.consumes, "other.host.v1"] });
  assert.notEqual(grantFingerprint(before), grantFingerprint(after));
  assert(diffGrants(before, after).added.includes("capabilities.consumes:other.host.v1"));
});
test("raster media rejects remote/file paths and mismatched executable uploads", (t) => {
  const e = environment(t),
    media = require("../src/domains/control-deck/control-deck-media")(e.runtimeDir);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  const asset = media.store(png, "image/png");
  assert.equal(media.read(asset.id).type, "image/png");
  assert.throws(() => media.store(png, "image/gif"), /media_invalid/);
  assert.throws(
    () => media.store(Buffer.from("<svg onload='alert(1)'/>"), "image/svg+xml"),
    /media_invalid/,
  );
  assert.throws(() => media.read("../../private.json"), /media_invalid/);
  const video = fs.readFileSync(path.join(__dirname, "../public/core/wake-media/silent.mp4"));
  assert.throws(() => media.store(video, "video/mp4"), /media_invalid/);
  const screen = media.storeScreen(video, "video/mp4");
  assert.equal(media.read(screen.id).type, "video/mp4");
  assert.equal(media.storeScreen(video, "video/mp4").id, screen.id);
  assert.throws(() => media.storeScreen(video, "video/webm"), /media_invalid/);
  assert.throws(() => media.storeScreen(Buffer.alloc(16777217), "video/mp4"), /media_invalid/);
});

test("legacy decks acquire one Audio mixer page without replacing local buttons or recreating a removed page", async (t) => {
  const e = environment(t),
    original = e.service.snapshot();
  const legacy = structuredClone(original.config);
  legacy.pages = legacy.pages.filter((page) => !page.mixer?.enabled);
  legacy.layout.radius = 31;
  await e.service.shutdown();
  const filename = path.join(e.runtimeDir, "system", "control-deck.json");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify({ revision: 4, config: legacy }));
  const migrated = create({ runtimeDir: e.runtimeDir, actions: { catalog: () => [] } });
  const next = migrated.snapshot();
  assert.deepEqual(next.config.pages[0], legacy.pages[0]);
  assert.equal(next.config.layout.radius, 31);
  assert.equal(next.config.pages.filter((page) => page.mixer?.enabled).length, 1);
  next.config.pages = next.config.pages.filter((page) => !page.mixer?.enabled);
  migrated.save(next.config, next.revision);
  await migrated.shutdown();
  const reopened = create({ runtimeDir: e.runtimeDir, actions: { catalog: () => [] } });
  assert.equal(
    reopened.snapshot().config.pages.some((page) => page.mixer?.enabled),
    false,
  );
  await reopened.shutdown();
});
test("mod feedback refresh shares concurrent reads and fairly visits more than eight actions", async () => {
  const calls = [],
    actions = Array.from({ length: 12 }, (_, i) => ({
      id: "action-" + i,
      title: "Action " + i,
      stateMethod: "status",
    }));
  const registry = {
    list: () => ({
      mods: [{ id: "sample.actions", name: "Actions", lifecycle: "active", actions }],
    }),
    readActionState: async (_id, action) => {
      calls.push(action);
      return {
        ok: true,
        value: {
          feedback: { state: "unavailable", label: "Unknown", active: false, available: false },
        },
      };
    },
  };
  const adapter = require("../src/domains/control-deck/control-deck-actions")({
    core: { lightingProfiles: { snapshot: () => ({ profiles: [] }) } },
    music: { view: () => ({ captureAvailable: false, status: { permissions: {} }, design: {} }) },
    getMods: () => registry,
  });
  const original = Date.now;
  actions.push({ id: "stateless", title: "Open" });
  let at = original();
  Date.now = () => at;
  try {
    const a = adapter.refresh(),
      b = adapter.refresh();
    assert.equal(a, b);
    await a;
    assert.equal(calls.length, 8);
    at += 3000;
    await adapter.refresh();
    assert.equal(new Set(calls).size, 12, "later actions cannot starve at slow polling cadences");
    assert.equal(
      adapter.catalog().find((a) => a.id === "mod:sample.actions:action-0").available,
      false,
    );
    assert.equal(adapter.feedback()["mod:sample.actions:action-0"].text, "Unknown");
    assert.equal(
      adapter.catalog().find((row) => row.id === "mod:sample.actions:action-0").stateful,
      true,
    );
    assert.equal(
      adapter.catalog().find((row) => row.id === "mod:sample.actions:stateless").stateful,
      false,
    );
  } finally {
    Date.now = original;
  }
});

test("mod feedback preserves bounded completion receipts without inventing new completion times", async () => {
  const at = Date.now(),
    actions = Array.from({ length: 5 }, (_, index) => ({
      id: "receipt-" + index,
      title: "Receipt " + index,
      stateMethod: "status",
    })),
    receipts = [
      { completedAt: at - 1000, jobId: "clip-job-1" },
      { completedAt: at + 60000, jobId: "x".repeat(81) },
      { completedAt: -1, jobId: "bad/path" },
      { completedAt: String(at), jobId: null },
      { completedAt: 1.5, jobId: {} },
    ];
  const adapter = require("../src/domains/control-deck/control-deck-actions")({
    core: { lightingProfiles: { snapshot: () => ({ profiles: [] }) } },
    music: { view: () => ({ captureAvailable: false, status: { permissions: {} }, design: {} }) },
    getMods: () => ({
      list: () => ({ mods: [{ id: "sample.clips", name: "Clips", lifecycle: "active", actions }] }),
      readActionState: async (_id, id) => ({
        ok: true,
        value: {
          feedback: {
            state: "success",
            label: "Clip created",
            available: false,
            ...receipts[Number(id.slice(-1))],
          },
        },
      }),
    }),
  });
  await adapter.refresh();
  const feedback = adapter.feedback();
  assert.equal(feedback["mod:sample.clips:receipt-0"].completedAt, at - 1000);
  assert.equal(feedback["mod:sample.clips:receipt-0"].jobId, "clip-job-1");
  for (let index = 1; index < receipts.length; index++) {
    assert.equal(feedback[`mod:sample.clips:receipt-${index}`].completedAt, undefined);
    assert.equal(feedback[`mod:sample.clips:receipt-${index}`].jobId, undefined);
  }
  assert(
    adapter
      .catalog()
      .filter((row) => row.id.startsWith("mod:"))
      .every((row) => !row.available),
  );
});
