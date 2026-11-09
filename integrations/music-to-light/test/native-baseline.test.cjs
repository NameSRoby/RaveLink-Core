const test = require("node:test");
const assert = require("node:assert/strict");
const create = require("../mapper.cjs");
const bank = require("../fixture-renderers.cjs");
const { settings } = require("../mapping-settings.cjs");
const direct = require("../direct-brightness-settings.cjs");
const catalog = require("../native-catalog.cjs");
const accepted = require("../profiles/accepted-color-led-v1.json");
test("color pace and frequency focus cannot change accepted brightness", () => {
  const mappers = ["slow", "normal", "fast", "aggressive"].map((feel) =>
    create({ ...accepted, feel }),
  );
  for (let i = 1; i <= 100; i++) {
    const at = i * 20;
    for (const m of mappers) m.update(event(i), at);
    const reference = mappers[1].render(at).brightness;
    for (const m of mappers)
      for (const role of ["all", "low", "mid", "high"])
        assert.equal(m.render(at, { role }).brightness, reference);
  }
});

test("frequency color focus never stalls valid brightness while spectral detail warms up", () => {
  const m = create({
    ...accepted,
    recipeOptions: { role: { mode: "fixed", value: "high", allowed: ["high"] } },
  });
  m.update(
    { endFrame: 960, discontinuities: 0, rms: 0.05, signal: "signal", invalidSamples: 0 },
    20,
  );
  assert(m.render(20, { role: "high" }));
});

test("Govee cadence remains valid through the public session contract", () => {
  const session = require("../session.cjs")({
    settings: accepted,
    output: {
      fixtures: [{ id: "test", brand: "govee", role: "all", position: 0 }],
      ownership: Object.fromEntries(
        ["acquire", "write", "release", "releaseOwner", "has"].map((key) => [
          key,
          () => {
            throw Error("unexpected I/O");
          },
        ]),
      ),
    },
  });
  const schema = require("../contracts/music-controller-v1.contracts.json").contracts.find(
    (c) => c.capability === "music.session.v1",
  ).methods.status.response.properties.session;
  assert(
    require("../../../src/shared/contracts/bounded-json-schema").validateValue(
      schema,
      session.snapshot(),
    ),
  );
  assert.equal(session.snapshot().outputCadence.fixtureHz[0].hz, 8);
});
function event(i) {
  const rms = i < 60 ? 0.025 : i < 130 ? 0.08 : 0.04;
  const bands =
    i % 30 < 15 ? [rms * 0.85, rms * 0.1, rms * 0.05] : [rms * 0.1, rms * 0.25, rms * 0.65];
  return {
    endFrame: i * 960,
    discontinuities: 0,
    rms,
    signal: "signal",
    invalidSamples: 0,
    analysis: {
      valid: true,
      bandRms: bands,
      onset: i % 10 === 1 ? { id: i, detectedAtFrame: i * 960, strength: 1.2 } : null,
      onsetThreshold: 1,
    },
  };
}
test("Ember has distinct warm/fire accents through real beat rendering without brightness modulation", () => {
  const look = catalog.looks.find((l) => l.id === "ember-pulse");
  const config = settings({
    ...look.design,
    behaviors: { ...look.design.behaviors, profilePaletteEnabled: false },
  });
  const ember = create(config);
  const reference = create({ ...config, palette: accepted.palette });
  const { hsv } = require("../palette-math.cjs");
  const families = new Set();
  for (let i = 1; i <= 800; i++) {
    const at = i * 20;
    ember.update(event(i), at);
    reference.update(event(i), at);
    const output = ember.render(at);
    assert.equal(output.brightness, reference.render(at).brightness);
    if (i % 5 === 0) {
      const [hue, saturation] = hsv(Object.values(output.rgb));
      assert(saturation > 0.75, "flame transitions must stay vivid");
      families.add(Math.floor(hue * 6));
    }
  }
  assert(families.has(0) && families.has(4), "warm and violet accents must reach actual frames");
});

test("every native preset keeps the accepted brightness response", () => {
  const reference = create(settings(accepted));
  const choices = catalog.looks.map((l) =>
    create(settings({ ...accepted, ...l.design }), { random: () => 0.3 }),
  );
  for (let i = 1; i <= 180; i++) {
    const at = i * 20,
      source = event(i);
    reference.update(source, at);
    for (const m of choices) {
      m.update(source, at);
      assert.equal(m.render(at).brightness, reference.render(at).brightness);
    }
  }
  assert(
    catalog.behaviors.every(
      (f) =>
        !["pulseDecayMs", "attacksEnabled", "expressiveEnabled", "steadyBrightness"].includes(f.id),
    ),
  );
});
test("all routed color jobs work independently without changing brightness or per-fixture palettes", () => {
  const config = settings(accepted),
    base = create(config);
  const routes = ["pulse", "wave", "bounce", "handoff"].map((assignedEffect, i) => ({
    id: "test-" + i,
    brand: "wiz",
    position: i / 3,
    role: ["all", "low", "mid", "high"][i],
    raveBehavior: "reactive",
    assignedEffect,
    assignedPalette: i % 2 ? ["#ff8800", "#ff0077", "#4400ff"] : ["#00ffff", "#0000ff", "#ff00ff"],
  }));
  const renderer = bank(base, routes),
    colors = routes.map(() => new Set());
  for (let i = 1; i <= 180; i++) {
    const at = i * 20;
    renderer.update(event(i), at);
    const frames = routes.map((f) => renderer.render(at, f));
    assert(frames.every((f) => f.brightness === frames[0].brightness));
    frames.forEach((f, j) => colors[j].add(JSON.stringify(f.rgb)));
  }
  assert(
    colors.every((c, i) => c.size >= (i === 0 ? 3 : 6)),
    "each audio color style must have real output variation: " +
      JSON.stringify(colors.map((c) => c.size)),
  );
  assert(require("../fixture-planner.cjs").compatible("wave", 1, config, routes.slice(0, 1)));
});
test("native migration retires pulse controls without replacing calibration or permissions", () => {
  const old = settings({
    ...accepted,
    interpretation: "musical",
    minimumBrightness: 18,
    maximumBrightness: 61,
    floorDb: -48,
    ceilingDb: -24,
    behaviors: { attacksEnabled: true, expressiveEnabled: true, steadyBrightness: true },
    parameterRanges: { pulseDecayMs: { min: 100, max: 200 }, colorBlendMs: { min: 60, max: 180 } },
    recipeOptions: { shape: { mode: "fixed", value: "wave", allowed: ["wave"] } },
  });
  const current = settings(direct(old));
  assert.equal(current.interpretation, "literal");
  assert.equal(current.behaviors.attacksEnabled, false);
  assert.equal(current.behaviors.steadyBrightness, false);
  assert.equal(current.behaviors.literalAttackMs, 35);
  assert.equal(current.behaviors.literalReleaseMs, 100);
  assert.equal(current.recipeOptions.shape.value, "unison");
  assert.deepEqual(Object.keys(current.parameterRanges), ["colorBlendMs"]);
  for (const key of [
    "minimumBrightness",
    "maximumBrightness",
    "floorDb",
    "ceilingDb",
    "autoAudioFollow",
    "calibrationVolume",
  ])
    assert.deepEqual(current[key], old[key]);
});
