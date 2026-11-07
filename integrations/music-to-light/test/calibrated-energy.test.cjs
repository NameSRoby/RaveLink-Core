const test = require("node:test");
const assert = require("node:assert/strict");
const energy = require("../calibrated-energy.cjs");
const create = require("../mapper.cjs");
const accepted = require("../profiles/accepted-color-led-v1.json");

test("fixed power calibration preserves contrast below the loud reference", () => {
  assert.equal(energy(0, -44, -20), 0);
  assert(energy(0.05, -44, -20) < 0.25);
  assert(energy(0.025, -44, -20) < 0.063);
  assert.equal(energy(0.1, -44, -20), 1);
  assert.equal(energy(1, -44, -20), 1);
  assert.equal(energy(0.001, -44, -20), 0);
  const quiet = energy(0.05, -44, -20);
  assert(Math.abs(quiet - energy(0.025, -50.020599913279625, -26.020599913279625)) < 1e-10);
});

test("a sustained restrained build stays below loud drums while genuine peaks can reach the limit", () => {
  const m = create({
    ...accepted,
    floorDb: -44,
    ceilingDb: -20,
    minimumBrightness: 10,
    maximumBrightness: 100,
  });
  let frame = 0;
  function feed(rms, count) {
    for (let i = 0; i < count; i++) {
      frame++;
      m.update(
        { endFrame: frame * 960, discontinuities: 0, rms, signal: "signal", invalidSamples: 0 },
        frame * 20,
      );
    }
    return m.render(frame * 20).brightness;
  }
  const build = feed(0.06, 200),
    drums = feed(0.095, 200),
    peak = feed(0.15, 200);
  assert(build < 45, "a build below the loud reference must not sit near full brightness");
  assert(drums > build + 40, "louder drums need visible contrast");
  assert(peak > 99.9);
  const sustained = feed(0.06, 200);
  assert(Math.abs(sustained - build) < 0.001, "the response must not learn away sustained sound");
});
