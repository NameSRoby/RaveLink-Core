const test = require("node:test"),
  assert = require("node:assert/strict");
const { opening, choose } = require("../lifecycle-motion.cjs");
const { settings } = require("../mapping-settings.cjs");
const recipe = require("../recipe.cjs");
const { simulate } = require("../simulation.cjs");
const frame = { brightness: 75, rgb: { r: 255, g: 15, b: 80 }, sampledAt: 1 };

test("Random chooses each transition once per activation and rendering never redraws", () => {
  const config = settings({ behaviors: { openingStyle: 4, endingStyle: 3 } });
  let calls = 0;
  const plan = choose(config.behaviors, () => {
    calls++;
    return 0.75;
  });
  assert.equal(plan.openingStyle, 3);
  assert.equal(plan.endingStyle, 4);
  assert.equal(calls, 2);
  for (let at = 0; at < 5000; at += 10)
    opening(frame, { position: 0.5 }, config, at, undefined, plan);
  assert.equal(calls, 2);
  assert.equal(Object.isFrozen(plan), true);
  assert.deepEqual(
    choose(settings().behaviors, () => assert.fail("fixed settings do not draw")),
    { openingStyle: 0, endingStyle: 0, openingMs: 2400, endingMs: 1500 },
  );
});
test("openings stay deterministic, bounded and converge continuously to the measured target", () => {
  for (const style of [1, 2, 3]) {
    const config = settings({
      maximumBrightness: 90,
      behaviors: { openingStyle: style, openingMs: 2400 },
    });
    for (const position of [0, 1 / 3, 2 / 3, 1]) {
      const fixture = { brand: "wiz", position, raveBehavior: "reactive" };
      for (let at = 0; at <= 2400; at += 10) {
        const result = opening(frame, fixture, config, at, { on: true, dimming: 30 });
        assert(result.brightness >= 0 && result.brightness <= 90);
        assert(Object.values(result.rgb).every((v) => Number.isFinite(v) && v >= 0 && v <= 255));
        assert.deepEqual(result, opening(frame, fixture, config, at, { on: true, dimming: 30 }));
      }
      assert.equal(opening(frame, fixture, config, 2400), frame);
      const before = opening(frame, fixture, config, 2399.99);
      assert(Math.abs(before.brightness - frame.brightness) < 0.001);
    }
  }
});
test("opening never overrides dim, steady or off routes and explicit scene roles beat random tasks", () => {
  const config = settings({
    behaviors: { openingStyle: 1 },
    recipeOptions: { task: { mode: "random", value: "reactive", allowed: ["off"] } },
  });
  for (const raveBehavior of ["dim", "steady", "off"]) {
    const fixture = { id: "test", brand: "wiz", role: "all", position: 1, raveBehavior };
    assert.equal(opening(frame, fixture, config, 1000), frame);
    assert.equal(recipe.fixtures([fixture], config, true)[0].raveBehavior, raveBehavior);
    assert.equal(recipe.fixtures([fixture], config, false)[0].raveBehavior, raveBehavior);
  }
  assert.throws(() => settings({ behaviors: { openingStyle: 1.5 } }), /invalid_music_behaviors/);
});
test("quiet introductions cannot invent a bright sweep and each reveal uses its own direction", () => {
  const quiet = { ...frame, brightness: 15 };
  const config = settings({ minimumBrightness: 10, maximumBrightness: 100 });
  const first = { brand: "wiz", position: 0 },
    last = { brand: "wiz", position: 1 };
  for (const style of [1, 2, 3]) {
    const plan = { openingStyle: style, openingMs: 1200 };
    for (let t = 0; t < 1200; t += 20) {
      const result = opening(quiet, first, config, t, { on: true, dimming: 10 }, plan);
      assert(result.brightness >= 10 && result.brightness <= 15);
      assert.deepEqual(result.rgb, quiet.rgb);
      assert.equal(result.entranceTargetBrightness, 15);
    }
  }
  const plan = { openingStyle: 1, openingMs: 1200 };
  assert(
    opening(quiet, first, config, 500, null, plan).entranceMix >
      opening(quiet, last, config, 500, null, plan).entranceMix,
  );
  plan.openingStyle = 3;
  assert(
    opening(quiet, first, config, 500, null, plan).entranceMix <
      opening(quiet, last, config, 500, null, plan).entranceMix,
  );
});

test("simulation does not raise a dim scene to the reactive brightness floor", () => {
  const features = Array.from({ length: 100 }, (_, i) => ({
    endFrame: (i + 1) * 960,
    discontinuities: 0,
    rms: 0.1,
    signal: "signal",
    invalidSamples: 0,
    analysis: { valid: true, bandRms: [0.05, 0.05, 0.05], onset: null },
  }));
  const result = simulate({
    features,
    fixtures: [
      {
        id: "test",
        brand: "wiz",
        role: "all",
        position: 0,
        raveBehavior: "dim",
        sceneBrightness: 10,
        sceneFadeMs: 100,
      },
    ],
    design: { minimumBrightness: 30, maximumBrightness: 90, behaviors: { openingStyle: 1 } },
  });
  assert(result.length > 0);
  assert.equal(result.at(-1).lights[0].brightness, 10);
});
