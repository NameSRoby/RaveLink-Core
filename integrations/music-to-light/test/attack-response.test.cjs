const test = require("node:test"),
  assert = require("node:assert/strict");
const createMapper = require("../mapper.cjs");
const createResponse = require("../attack-response.cjs");
const createCadence = require("../output-cadence.cjs");
const { settings } = require("../mapping-settings.cjs");

test("extra impact requires pronounced measured novelty and weak events cannot renew its tail", () => {
  const response = createResponse();
  response.accept({ strength: 1.02 }, 1, true, 0, 160);
  assert.equal(response.impact(0, 160), 0);
  response.accept({ strength: 3 }, 1, true, 100, 160);
  assert.equal(response.impact(100, 160), 1);
  response.accept({ strength: 1.02 }, 1, true, 150, 160);
  assert.equal(response.latestImpact(), 0);
  assert(Math.abs(response.impact(200, 160) - Math.exp(-100 / 160)) < 1e-12);
  assert.equal(
    response.impact(150, 160, 90),
    1,
    "one new strong event survives until its output slot",
  );
  response.reset();
  response.accept({}, undefined, true, 200, 160);
  assert.equal(response.impact(200, 160), 0, "missing measurements cannot invent a strong attack");
});
function sample(i, strength = null, rms = 0.2) {
  const onset = strength === null ? null : { id: i, detectedAtFrame: i * 960, strength };
  return {
    endFrame: i * 960,
    discontinuities: 0,
    rms,
    signal: "signal",
    invalidSamples: 0,
    analysis: {
      valid: true,
      bandRms: [rms * 0.8, rms * 0.4, rms * 0.1],
      onset,
      logOnset: onset,
      onsetThreshold: 1,
      logOnsetThreshold: 1,
    },
  };
}
function mapper(expressiveEnabled = true) {
  const m = createMapper({
    preset: "pulse",
    intensity: 1,
    maximumBrightness: 100,
    colorMode: "onsets",
    palette: ["#ff0000", "#0000ff"],
    behaviors: { expressiveEnabled, colorBlendMs: 0 },
  });
  for (let i = 1; i <= 100; i++) m.update(sample(i), i * 20);
  return m;
}
test("threshold-edge musical attacks remain visible; strong attacks retain full headroom", () => {
  const weak = mapper(),
    strong = mapper();
  weak.update(sample(101, 1.02), 2020);
  strong.update(sample(101, 3), 2020);
  const accent = weak.render(2020, { onsetSince: 2000 }).brightness;
  assert(accent > 45 && accent < 60);
  assert(strong.render(2020, { onsetSince: 2000 }).brightness > 99);
  assert.equal(weak.settings().floorDb, strong.settings().floorDb);
  assert.equal(weak.settings().ceilingDb, strong.settings().ceilingDb);
  assert.equal(weak.settings().maximumBrightness, 100);
  assert.deepEqual(weak.inspect(2020).recipe, strong.inspect(2020).recipe);
});
test("qualified attacks advance color even near the detector threshold; reference remains available", () => {
  const m = mapper();
  const before = m.render(2020).rgb;
  m.update(sample(101, 1.02), 2020);
  assert.notDeepEqual(m.render(2020).rgb, before);
  m.update(sample(102, 3), 2040);
  assert.deepEqual(m.render(2040).rgb, before);
  const reference = mapper(false);
  reference.update(sample(101, 1.02), 2020);
  assert(reference.render(2020).brightness > 99);
});
test("a weak event cannot erase a strong tail, amplify it or restart it at full power", () => {
  const response = createResponse();
  response.accept({ strength: 3 }, 1, true, 0, 260);
  const before = response.level(100, 260);
  response.accept({ strength: 1.02 }, 1, true, 100, 260);
  assert(Math.abs(response.level(100, 260) - before) < 1e-12);
  assert(response.latest() >= 0.35 && response.latest() < 0.38);
  assert(response.level(200, 260) < before);
  response.reset();
  assert.equal(response.level(300, 260), 0);
});
test("adaptive maximum speed needs strong evidence; detail and amplified artistic rises cannot hold it", () => {
  const cadence = createCadence(),
    config = settings({ outputHz: 16, outputRateMode: "adaptive" });
  const weak = {
    fresh: true,
    metrics: { level: 0.7, rise: 0.6, energyRise: 0.02, attack: true, attackStrength: 0.1 },
  };
  for (let at = 0; at < 2000; at += 20) assert.equal(cadence.rate(config, weak, at), 6);
  assert.equal(
    cadence.rate(config, { fresh: true, metrics: { ...weak.metrics, attackStrength: 0.9 } }, 2000),
    16,
  );
  for (let at = 2020; at <= 2780; at += 20) assert.equal(cadence.rate(config, weak, at), 16);
  assert.equal(
    cadence.rate(config, weak, 2820),
    6,
    "weak details must not renew the strong event's hold",
  );
  assert.equal(
    createCadence().rate(
      config,
      { fresh: true, metrics: { ...weak.metrics, level: 0.05, attackStrength: 1 } },
      0,
    ),
    2,
    "tiny sound must not demand maximum speed",
  );
  assert.equal(cadence.rate({ ...config, outputRateMode: "fixed" }, weak, 3000), 16);
});
