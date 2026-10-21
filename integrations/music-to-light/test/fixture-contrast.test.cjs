const test = require("node:test");
const assert = require("node:assert/strict");
const createMapper = require("../mapper.cjs");
const { plan, amount } = require("../fixture-contrast.cjs");
const { validate } = require("../fixture-behavior.cjs");
function sample(i, rms = 0.1, hit = false) {
  const onset = hit ? { id: i, detectedAtFrame: i * 960, strength: 3 } : null;
  return {
    endFrame: i * 960,
    discontinuities: 0,
    rms,
    signal: rms ? "signal" : "silent",
    invalidSamples: 0,
    analysis: {
      valid: true,
      bandRms: [rms, rms / 2, rms / 4],
      onset,
      logOnset: onset,
      onsetThreshold: 1,
      logOnsetThreshold: 1,
    },
  };
}
function mapper(extra = {}) {
  const m = createMapper({
    preset: "pulse",
    intensity: 1,
    maximumBrightness: 100,
    colorMode: "onsets",
    palette: ["#ff075b", "#7024ff", "#008cff"],
    ...extra,
  });
  for (let i = 1; i <= 100; i++) m.update(sample(i), i * 20);
  return m;
}
test("zero is identical, color contrast progresses and rendering never consumes an onset", () => {
  for (const colorMode of ["onsets", "fixed", "roles", "energy", "travel"])
    for (const expressiveEnabled of [false, true]) {
      const m = mapper({ colorMode, behaviors: { expressiveEnabled } });
      m.update(sample(101, 0.1, true), 2020);
      const original = m.render(2020);
      assert.deepEqual(m.render(2020, { outOfSync: 0, contrastSlot: 0.75 }), original);
      const colors = [0, 15, 35, 60, 100].map((outOfSync) => {
        const f = m.render(2020, { outOfSync, contrastSlot: 0.75 });
        assert.equal(f.sampledAt, original.sampledAt);
        assert(f.brightness >= 10 && f.brightness <= 100);
        assert.deepEqual(m.render(2020, { outOfSync, contrastSlot: 0.75 }), f);
        return JSON.stringify(f.rgb);
      });
      assert(new Set(colors).size >= 4, colorMode);
      assert.deepEqual(m.render(2020), original);
    }
});
test("high contrast uses measured bands and attacks, with bounded opposing accents", () => {
  const options = { percent: 100, level: 0.5, bands: [0.5, 0.25, 0], attack: 1 };
  assert.equal(amount(0.5, { ...options, percent: 0, slot: 0.2 }), 0.5);
  assert.equal(amount(0.5, { ...options, percent: 35, slot: 0.2 }), 0.5);
  assert(amount(0.5, { ...options, slot: 0.2 }) > 0.5);
  assert(amount(0.5, { ...options, slot: 0.8 }) < 0.5);
  assert.equal(amount(0, { ...options, slot: 0.2 }), 0);
  assert.equal(amount(0.5, { ...options, level: 0, slot: 0.8 }), 0.5);
});
test("quiet, stale, disabled color and steady brightness retain their contracts", () => {
  const m = mapper({ behaviors: { colorEnabled: false, steadyBrightness: true } });
  assert.deepEqual(m.render(2000, { outOfSync: 100 }), m.render(2000));
  for (let i = 101; i <= 300; i++) m.update(sample(i, 0), i * 20);
  assert.deepEqual(m.render(6000, { outOfSync: 100 }), m.render(6000));
  assert.equal(m.render(6300, { outOfSync: 100 }), null);
});
test("stable active slots exclude theatre fixtures and percentages are strictly bounded", () => {
  const rows = plan([{ id: "a" }, { id: "dim", raveBehavior: "dim" }, { id: "b" }]);
  assert.equal(rows[0].contrastSlot, 1 / 3);
  assert.equal(rows[2].contrastSlot, 2 / 3);
  for (const outOfSync of [-1, 101, 0.5, "50", NaN]) assert.throws(() => validate({ outOfSync }));
});
