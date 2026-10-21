const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const createLibrary = require("../integrations/music-to-light/song-library.cjs");
const createAuto = require("../integrations/music-to-light/auto-rave.cjs");
const createEffects = require("../integrations/music-to-light/saved-effects.cjs");
const { createLifetime } = require("../integrations/music-to-light/song-duration.cjs");
const { settings } = require("../integrations/music-to-light/mapping-settings.cjs");
const playback = (title = "First", positionMs = 0, status = "playing") => ({
  primary: {
    provider: "tidal",
    title,
    artists: ["Artist"],
    status,
    positionMs,
    durationMs: 200000,
    observedAt: 100000,
  },
});

test("any song can be saved without playback, edited, matched exactly and restored privately", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-song-library-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, "songs.json"),
    library = createLibrary({ storePath });
  library.upsert({ title: "First", artist: "Artist" });
  const first = library.snapshot().songs[0];
  assert(createLibrary.matches(first, createLibrary.currentSong(playback(), 100000)));
  assert(
    !createLibrary.matches(first, createLibrary.currentSong(playback("First (Live)"), 100000)),
  );
  const exact = createLibrary.songInput({
    url: "https://tidal.com/track/123",
    title: "First",
    artist: "Artist",
  });
  assert(
    createLibrary.matches(
      exact,
      createLibrary.currentSong(
        { primary: { ...playback().primary, candidate: { id: "synthetic-window-key" } } },
        100000,
      ),
    ),
  );
  assert(
    !createLibrary.matches(
      exact,
      createLibrary.currentSong(
        { primary: { ...playback().primary, candidate: { providerItemId: "456" } } },
        100000,
      ),
    ),
  );
  library.upsert({
    url: "https://open.spotify.com/track/1234567890123456789012",
    title: "Another",
    artist: "Artist",
  });
  library.upsert({ ...first, title: "Edited", enabled: false, intensity: 0.4 });
  const restored = createLibrary({ storePath });
  assert.equal(restored.snapshot().songs.length, 2);
  assert.equal(restored.snapshot().songs[0].enabled, false);
  assert.equal(restored.snapshot().songs[0].intensity, 0.4);
  assert(!JSON.stringify(restored.snapshot()).includes("fixtureIds"));
  assert.throws(() => restored.upsert({ title: "Edited", artist: "Artist" }), /already_saved/);
  for (const url of [
    "https://example.com/track/123",
    "https://user:pass@tidal.com/track/123",
    "http://tidal.com/track/123",
    "https://tidal.com:9999/track/123",
    "https://open.spotify.com/playlist/1234567890123456789012",
  ])
    assert.throws(() => restored.upsert({ url }), /invalid_music_song_link/);
  assert.throws(() => restored.upsert({ title: "Ambiguous" }), /artist_required/);
  assert.throws(
    () => restored.upsert({ title: "<script>", artist: "Artist" }),
    /invalid_music_song/,
  );
  restored.remove(first.id);
  assert.equal(restored.snapshot().songs.length, 1);
});

test("viewer approval stores the proposed value, applies it once, and preserves other songs", () => {
  let now = 0;
  const library = createLibrary({ now: () => now });
  library.configure({ viewerSongs: "approval" });
  const result = library.submit("song", { title: "First", artist: "Artist" }, () =>
    assert.fail("approval bypass"),
  );
  assert(result.pending);
  assert.equal(library.snapshot().songs.length, 0);
  assert.throws(
    () => library.submit("song", { title: "Second", artist: "Artist" }, () => {}),
    /cooldown/,
  );
  const pending = library.snapshot().pending[0];
  library.upsert({ title: "Other", artist: "Artist" });
  library.review({ id: pending.id, accept: true }, (kind, value) => library.upsert(value));
  assert.equal(library.snapshot().songs.length, 2);
  assert.equal(library.snapshot().pending.length, 0);
  assert.throws(
    () => library.review({ id: pending.id, accept: true }, () => {}),
    /invalid_music_submission/,
  );
  now += 6000;
  library.configure({ viewerSongs: "disabled" });
  assert.throws(
    () => library.submit("song", { title: "Second", artist: "Artist" }, () => {}),
    /disabled/,
  );
});

function autoEnvironment() {
  let p = playback(),
    starts = 0,
    stops = 0,
    running = false,
    reads = 0;
  const library = createLibrary();
  library.upsert({ title: "First", artist: "Artist" });
  library.upsert({ title: "Second", artist: "Artist" });
  const timers = new Set();
  const auto = createAuto({
    library,
    now: () => 100000,
    readPlayback: async () => {
      reads++;
      return p;
    },
    start: async () => {
      starts++;
      running = true;
    },
    stop: async () => {
      stops++;
      running = false;
    },
    active: () => running,
    ready: () => null,
    setTimer: (fn) => {
      timers.add(fn);
      return fn;
    },
    clearTimer: (fn) => timers.delete(fn),
  });
  return {
    auto,
    library,
    timers,
    set: (v) => {
      p = v;
    },
    manual: () => {
      running = true;
    },
    manualStop: () => {
      running = false;
    },
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    get reads() {
      return reads;
    },
  };
}

test("Auto-Rave is inert while off, triggers once per playback and Stop suppresses that playback", async () => {
  const e = autoEnvironment();
  await e.auto.tick();
  assert.equal(e.reads, 0);
  assert.equal(e.timers.size, 0);
  e.library.configure({ enabled: true });
  await e.auto.changed();
  await e.auto.tick();
  assert.equal(e.starts, 1);
  e.set(playback("First", 10000, "paused"));
  await e.auto.tick();
  e.set(playback("First", 10000));
  await e.auto.tick();
  assert.equal(e.starts, 1);
  e.auto.suppress();
  e.manualStop();
  await e.auto.tick();
  assert.equal(e.starts, 1);
  e.set(playback("Second"));
  await e.auto.tick();
  assert.equal(e.starts, 2);
  e.library.configure({ enabled: false });
  await e.auto.changed();
  assert.equal(e.stops, 1);
  assert.equal(e.timers.size, 0);
  await e.auto.shutdown();
});

test("automation respects manual priority, skips stale metadata and stops a disabled active song", async () => {
  const e = autoEnvironment();
  e.library.configure({ enabled: true });
  e.manual();
  await e.auto.tick();
  assert.equal(e.starts, 0);
  assert.equal(e.auto.snapshot().reason, "manual_priority");
  await e.auto.shutdown();
  const next = autoEnvironment();
  next.library.configure({ enabled: true });
  next.set({ primary: { ...playback().primary, observedAt: 0 } });
  await next.auto.tick();
  assert.equal(next.starts, 0);
  next.set(playback());
  await next.auto.tick();
  assert.equal(next.starts, 1);
  const song = next.library.snapshot().songs[0];
  next.library.upsert({ ...song, enabled: false });
  await next.auto.tick();
  assert.equal(next.stops, 1);
  assert.equal(next.auto.snapshot().reason, "song_disabled");
  await next.auto.shutdown();
  assert.equal(next.timers.size, 0);
});

test("disabling automation while metadata is pending cannot start capture later", async () => {
  let finish,
    starts = 0;
  const library = createLibrary();
  library.upsert({ title: "First", artist: "Artist" });
  library.configure({ enabled: true });
  const auto = createAuto({
    library,
    readPlayback: () =>
      new Promise((r) => {
        finish = r;
      }),
    now: () => 100000,
    start: async () => {
      starts++;
    },
    stop: async () => {},
    active: () => false,
    ready: () => null,
  });
  const pending = auto.tick();
  library.configure({ enabled: false });
  await auto.changed();
  finish(playback());
  await pending;
  assert.equal(starts, 0);
  await auto.shutdown();
});

test("per-song effect selection preserves global playback policy and brightness limits", () => {
  const effects = createEffects();
  const mapper = require("../integrations/music-to-light/mapper.cjs")({
    ...require("../integrations/music-to-light/looks.cjs").find((l) => l.id === "expressive-mix")
      .design,
  });
  const profile = effects.save({ name: "Original" }, { ...mapper.inspect(0), assignments: [] });
  effects.rename({ id: profile.id, name: "Renamed" });
  const chosen = effects.choose(settings({ maximumBrightness: 20, intensity: 0.3 }), [], {
    mode: "single",
    ids: [profile.id],
  });
  assert.equal(chosen.profile.name, "Renamed");
  assert.equal(chosen.design.maximumBrightness, 20);
  assert.equal(chosen.design.intensity, 0.3);
  assert.equal(effects.snapshot().policy.mode, "full-random");
  assert.throws(
    () => effects.choose(settings(), [], { mode: "single", ids: ["missing"] }),
    /invalid_music_effect_policy/,
  );
});

test("automatic song timing never extends into the following song even in the last minute", () => {
  const lifetime = createLifetime({
    design: settings({ raveDurationMode: "song" }),
    request: { songOnly: true },
    source: { label: "TIDAL", scope: "process_tree" },
    playback: playback("First", 150000),
    now: 0,
    wallNow: 100000,
  });
  assert.equal(lifetime.snapshot(0).includesNext, false);
  assert.equal(lifetime.update(playback("Second"), 1000, 100000), "music_song_ended");
});

test("Rave keeps the saved main app regardless of missing or paused song metadata", async (t) => {
  const { EventEmitter } = require("node:events");
  const createController = require("../integrations/music-to-light/controller.cjs");
  const music = { id: "process:10:20", label: "TIDAL", kind: "application", scope: "process_tree" };
  const game = {
    id: "fullscreen-app",
    label: "Active fullscreen / borderless app",
    kind: "application",
    scope: "process_tree",
  };
  let playing = false;
  const captured = [];
  const ownership = require("../src/domains/fixtures/fixture-output-ownership.service")({
    isEligible: () => true,
    readState: async () => ({ ok: true, state: { on: true, bri: 50 } }),
    writeState: async () => ({ sent: 1, failed: 0 }),
    restoreState: async () => ({ sent: 1, failed: 0 }),
  });
  const controller = createController({
    initialSettings: settings({ raveEnabled: true, behaviors: { steadyBrightness: true } }),
    wallNow: () => 100000,
    readPlayback: async () => (playing ? playback() : null),
    output: { ownership, resolveFixtures: () => [{ id: "lamp", brand: "hue", enabled: true }] },
    probeApi: {
      listSources: async () => [music, game],
      ensureAvailable: async () => true,
      capture(id) {
        captured.push(id);
        let finish;
        return {
          events: new EventEmitter(),
          snapshot: () => ({ generation: "a".repeat(32) }),
          done: new Promise((r) => {
            finish = r;
          }),
          stop: () => finish({ reason: "parent_stop" }),
        };
      },
    },
  });
  t.after(async () => {
    await controller.operator.shutdown();
    await ownership.shutdown();
  });
  controller.operator.activate();
  await controller.operator.permissions({ capture: true, output: true });
  await controller.client.sources();
  await controller.operator.selectSources([music.id, null, game.id]);
  await controller.operator.selectFixtures([{ id: "lamp", role: "all", position: 0.5 }]);
  const pending = controller.operator.rave({
    fixtureIds: ["lamp"],
    origin: "viewer",
    brightnessLimit: 20,
  });
  assert.equal(
    controller.operator.raveInfo().pending,
    true,
    "pending manual/viewer work must be visible to automatic admission",
  );
  await pending;
  assert.equal(captured[0], music.id, "an open silent main app must beat fullscreen");
  await controller.operator.stopRave();
  playing = true;
  await controller.operator.rave({ fixtureIds: ["lamp"], origin: "viewer" });
  assert.equal(captured[1], music.id);
  await controller.operator.stopRave();
  playing = false;
  await controller.operator.rave({ fixtureIds: ["lamp"], origin: "auto" });
  assert.equal(captured[2], music.id, "the trusted automatic path never selects the game fallback");
  await controller.operator.shutdown();
});
