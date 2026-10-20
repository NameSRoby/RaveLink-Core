const test = require("node:test"),
  assert = require("node:assert/strict");
const derive = require("../calibration.cjs");
const createMapper = require("../mapper.cjs");
test("one-time reference preserves its dynamic span at different listening levels", () => {
  const normal = Array.from({ length: 500 }, (_, i) => -35 + (i % 50) / 5),
    quiet = normal.map((n) => n - 20);
  const a = derive(normal),
    b = derive(quiet);
  assert.equal(a.ceilingDb - b.ceilingDb, 20);
  assert.equal(a.floorDb - b.floorDb, 20);
  assert.equal(a.ceilingDb - a.floorDb, 24);
  assert.ok(b.ceilingDb < -30, "quiet-app calibration is not clamped to the old floor");
  assert.deepEqual(derive([...normal, -1]), a, "one stray peak does not redefine the baseline");
});
test("silence, stale/invalid input and insufficient audio cannot replace a reference", () => {
  assert.throws(() => derive([]), /insufficient_audio/);
  assert.throws(() => derive(Array(500).fill(-90)), /too_quiet/);
  assert.throws(() => derive(Array(500).fill(NaN)), /insufficient_audio/);
});
test("explicit headroom reserves louder phrases without changing the fixed dynamic span", () => {
  const sample = Array(500).fill(-33),
    plain = derive(sample),
    reserved = derive(sample, 6);
  assert.equal(plain.ceilingDb, -33);
  assert.equal(reserved.ceilingDb, -27);
  assert.equal(reserved.ceilingDb - reserved.floorDb, 24);
  assert.equal(derive(Array(500).fill(-2), 6).ceilingDb, 0);
  for (const invalid of [-1, 13, NaN, Infinity])
    assert.throws(() => derive(sample, invalid), /invalid_music_calibration/);
  assert.throws(() => derive(Array(500).fill(-90), 12), /too_quiet/);
});
test("reference saturation is a bounded read-only diagnostic and clears after reference changes", () => {
  const m = createMapper({ floorDb: -54, ceilingDb: -30 });
  function feed(i, rms) {
    m.update(
      { endFrame: i * 960, discontinuities: 0, rms, signal: "signal", invalidSamples: 0 },
      i * 20,
    );
  }
  for (let i = 1; i <= 300; i++) feed(i, 0.1);
  for (let i = 301; i <= 600; i++) feed(i, 0.01);
  const metrics = m.inspect(12000).metrics;
  assert.equal(metrics.referenceSamples, 500);
  assert.equal(metrics.referenceSaturation, 0.4);
  assert.deepEqual(
    m.inspect(12000).metrics,
    metrics,
    "polling does not advance or train the reference",
  );
  assert.equal(m.settings().ceilingDb, -30);
  m.configure({ ...m.settings(), floorDb: -42, ceilingDb: -18 });
  assert.equal(m.inspect(12000).metrics.referenceSamples, 0);
  assert.equal(m.inspect(12000).metrics.referenceSaturation, 0);
});
