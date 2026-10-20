const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../output-motion.cjs");
const { settings } = require("../mapping-settings.cjs");
const frame = (brightness) => ({ brightness, rgb: { r: 255, g: 0, b: 0 }, sampledAt: 0 });
test("fall smoothing preserves immediate attacks, palette and hard ceilings", () => {
  const m = create(),
    c = settings({ maximumBrightness: 100, behaviors: { outputReleaseMs: 160 } });
  m.render("a", frame(10), 0, c);
  assert.equal(m.render("a", frame(90), 10, c).brightness, 90);
  const f = m.render("a", frame(10), 72.5, c);
  assert.ok(f.brightness > 60 && f.brightness < 90);
  assert.deepEqual(f.rgb, frame(10).rgb);
  assert.equal(m.render("a", frame(10), 75, { ...c, maximumBrightness: 30 }).brightness, 30);
  assert.equal(m.render("b", frame(10), 75, c).brightness, 10, "fixture envelopes are independent");
});
test("fall envelope follows elapsed time rather than number of renders", () => {
  const c = settings({ maximumBrightness: 100, behaviors: { outputReleaseMs: 160 } });
  function run(step) {
    const m = create();
    m.render(0, frame(90), 0, c);
    let f;
    for (let at = step; at <= 200; at += step) f = m.render(0, frame(10), at, c);
    return f.brightness;
  }
  assert.ok(Math.abs(run(10) - run(100)) < 1e-10);
});
test("zero smoothing and native scene commands bypass the envelope", () => {
  const c = settings({ maximumBrightness: 100 }),
    m = create();
  m.render(0, frame(90), 0, c);
  assert.equal(m.render(0, frame(10), 1, c).brightness, 10);
  const native = { ...frame(0), sceneNative: { on: false } };
  assert.equal(m.render(0, native, 2, c), native);
});

test("optional color smoothing reduces target jumps without delaying brightness attacks", () => {
  const c = settings({ maximumBrightness: 100, behaviors: { outputColorMs: 200 } }),
    m = create();
  m.render("a", frame(10), 0, c);
  const target = { ...frame(90), rgb: { r: 0, g: 100, b: 255 } };
  const smoothed = m.render("a", target, 62.5, c);
  assert.equal(smoothed.brightness, 90);
  assert.notDeepEqual(smoothed.rgb, target.rgb);
  assert(Object.values(smoothed.rgb).every((v) => Number.isFinite(v) && v >= 0 && v <= 255));
  const later = m.render("a", target, 2000, c);
  assert(Math.abs(later.rgb.b - target.rgb.b) < 1);
  assert.deepEqual(m.render("b", target, 2000, c).rgb, target.rgb);
});
