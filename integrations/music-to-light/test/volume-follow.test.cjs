const test = require("node:test");
const assert = require("node:assert/strict");
const { correction, validate } = require("../volume-follow.cjs");
const createMapper = require("../mapper.cjs");
const { settings } = require("../mapping-settings.cjs");
const reference = {
  key: "verified-app-and-output",
  systemPercent: 50,
  systemDb: -12,
  appGain: 0.5,
  muted: false,
};
test("gain follows the calibration in amplitude dB, independent of system slider taper", () => {
  const changed = { ...reference, appGain: 0.25, systemPercent: 20, systemDb: -30 };
  assert.equal(correction(reference, changed).db, 20 * Math.log10(0.5));
  assert.equal(correction(reference, { ...reference, systemPercent: 10, systemDb: -40 }).db, 0);
  for (const current of [
    null,
    { ...reference, key: "other-route" },
    { ...reference, appGain: null },
  ])
    assert.equal(correction(reference, current).state, "unavailable");
  assert.equal(correction(reference, { ...reference, appGain: 0 }).state, "muted");
  assert.equal(correction(reference, { ...reference, muted: true }).state, "muted");
  assert.equal(correction(reference, { ...reference, appGain: 0.0001 }).state, "out_of_range");
});
test("following preserves mapped energy for proportional gain changes without normalizing songs", () => {
  const config = {
    autoAudioFollow: true,
    calibrationVolume: reference,
    floorDb: -54,
    ceilingDb: -30,
  };
  const baseline = createMapper(config),
    quietMixer = createMapper(config),
    quieterSong = createMapper(config);
  function feed(mapper, rms, volume) {
    for (let i = 1; i <= 200; i++)
      mapper.update(
        {
          endFrame: i * 960,
          discontinuities: 0,
          rms,
          signal: "signal",
          invalidSamples: 0,
          volume,
          analysis: { valid: true, bandRms: [rms / 2, rms / 3, rms / 4], onset: null },
        },
        i * 20,
      );
    return mapper.inspect(4000);
  }
  const a = feed(baseline, 0.01, reference);
  const b = feed(quietMixer, 0.005, { ...reference, appGain: 0.25 });
  const c = feed(quieterSong, 0.005, reference);
  assert.ok(Math.abs(a.metrics.level - b.metrics.level) < 1e-10);
  assert.ok(c.metrics.level < a.metrics.level);
  assert.ok(b.bands.every((value, i) => Math.abs(value - a.bands[i]) < 1e-10));
  assert.equal(quietMixer.settings().floorDb, -54);
  assert.equal(quietMixer.settings().ceilingDb, -30);
});
test("old designs default off and volume metadata is bounded", () => {
  assert.equal(settings({}).autoAudioFollow, false);
  assert.equal(settings({}).calibrationVolume, null);
  for (const invalid of [
    { ...reference, appGain: Infinity },
    { ...reference, systemDb: NaN },
    { ...reference, key: "x".repeat(2049) },
  ])
    assert.throws(() => validate(invalid), /invalid_music_volume/);
});
