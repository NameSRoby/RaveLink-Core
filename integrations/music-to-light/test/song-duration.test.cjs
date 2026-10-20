const test = require("node:test"),
  assert = require("node:assert/strict");
const { createLifetime, MAX_SECONDS } = require("../song-duration.cjs");
const { settings } = require("../mapping-settings.cjs");
const source = { label: "TIDALPlayer", scope: "process_tree" };
const playback = (
  title = "First",
  positionMs = 20000,
  observedAt = 100000,
  status = "playing",
  durationMs = 200000,
) => ({
  primary: {
    provider: "tidal",
    title,
    artists: ["Artist"],
    positionMs,
    durationMs,
    observedAt,
    status,
  },
});
const make = (p = playback(), design = {}) =>
  createLifetime({
    design: settings(design),
    request: { seconds: 40 },
    source,
    playback: p,
    now: 0,
    wallNow: 100000,
  });
test("song clocks end on the first boundary, with no two-minute truncation", () => {
  const l = make();
  assert.equal(l.seconds, MAX_SECONDS);
  assert.equal(l.snapshot(0).phase, "current_song");
  assert.equal(l.update(playback("First", 80000, 160000), 60000, 160000), null);
  assert.equal(l.update(playback("Second", 0, 170000), 70000, 170000), "music_song_ended");
});
test("last minute includes exactly one following song, including a loop of the same recording", () => {
  const l = make(playback("First", 140000));
  assert.equal(l.snapshot(0).includesNext, true);
  assert.equal(l.update(playback("First", 199000, 159000), 59000, 159000), null);
  assert.equal(l.update(playback("First", 0, 160000), 60000, 160000), null);
  assert.equal(l.snapshot(60000).phase, "following_song");
  assert.equal(l.update(playback("Third", 0, 161000), 61000, 161000), "music_song_ended");
});
test("paused songs hold, seeks adjust remaining time, and native cap remains finite", () => {
  const l = make();
  assert.equal(l.update(playback("First", 20000, 110000, "paused"), 10000, 110000), null);
  assert.equal(l.snapshot(10000).remainingSeconds, null);
  l.update(playback("First", 100000, 120000), 20000, 120000);
  assert.ok(l.snapshot(20000).remainingSeconds <= 103);
  l.update(playback("First", 10000, 121000), 21000, 121000);
  assert.ok(l.snapshot(21000).remainingSeconds >= 190);
  assert.equal(l.update(playback(), MAX_SECONDS * 1000, 100000), "music_duration_limit");
});
test("missing, stale, wrong-app and invalid song timing use the dynamic timer", () => {
  for (const p of [
    null,
    playback("First", 0, 1),
    { primary: { ...playback().primary, provider: "spotify" } },
    playback("First", 0, 100000, "playing", 0),
  ]) {
    const l = make(p);
    assert.equal(l.seconds, 40);
    assert.equal(l.snapshot(0).mode, "dynamic");
    assert.equal(l.update(null, 39999, 139999), null);
    assert.equal(l.update(null, 40000, 140000), "music_duration_limit");
  }
});
test("metadata loss has a visible finite fallback, not an endless song wait", () => {
  const l = make();
  l.update(null, 10000, 110000);
  assert.equal(l.snapshot(10000).mode, "fallback");
  assert.equal(l.snapshot(10000).remainingSeconds, 40);
  assert.equal(l.update(null, 50000, 150000), "music_timer_ended");
});
test("separate and forced dynamic modes ignore song clocks", () => {
  const separate = make(playback(), { raveDurationMode: "separate", raveSeconds: 12 });
  assert.equal(separate.seconds, 12);
  assert.equal(separate.snapshot(0).mode, "separate");
  assert.equal(make(playback(), { raveDurationMode: "dynamic" }).seconds, 40);
});
test("natural end and stopped playback terminate the owned effect", () => {
  assert.equal(
    make().update(playback("First", 200000, 100000), 180000, 100000),
    "music_song_ended",
  );
  assert.equal(
    make().update(playback("First", 20000, 101000, "stopped"), 1000, 101000),
    "music_playback_stopped",
  );
});
test("late album/artist metadata is enrichment rather than a false song boundary", () => {
  const p = playback();
  p.primary.artists = [];
  const l = make(p);
  const richer = playback();
  richer.primary.album = "Album arrived later";
  assert.equal(l.update(richer, 1000, 100000), null);
  richer.primary.album = "Different album metadata";
  assert.equal(l.update(richer, 2000, 100000), null);
});
