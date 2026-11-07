const test = require("node:test");
const assert = require("node:assert/strict");
const create = require("../mapper.cjs");
const cadence = require("../output-cadence.cjs");
const { settings } = require("../mapping-settings.cjs");
const looks = require("../looks.cjs");
const reference = looks.find((look) => look.id === "smooth-reference").design;
const golden = require("./fixtures/reference-pulse-v074.json");
const sample = (i) => ({
  endFrame: (i + 1) * 960,
  discontinuities: 0,
  rms: i >= 200 ? 0 : 0.014 + (i % 25 === 0 ? 0.045 : 0),
  signal: i >= 200 ? "silent" : "signal",
  invalidSamples: 0,
  analysis: {
    valid: true,
    bandRms: i >= 200 ? [0, 0, 0] : [0.012, 0.007, 0.003],
    onset: i < 200 && i % 25 === 0 ? { id: i + 1, detectedAtFrame: (i + 1) * 960 } : null,
  },
});

test("Reference Pulse preserves v0.7.4 frames when onset salience is unavailable", () => {
  const mapper = create({ ...reference, intensity: 1, maximumBrightness: 35 });
  const frames = [];
  for (let i = 0; i < 250; i++) {
    const at = (i + 1) * 20;
    mapper.update(sample(i), at);
    if (i % 12 === 0) frames.push({ at, ...mapper.render(at, { position: 0 }) });
  }
  assert.deepEqual(frames, golden.frames);
});

test("Smart random preserves the reference pulse timing and keeps every foreground visible", () => {
  const design = looks.find((look) => look.id === "rave-mix").design;
  for (let seed = 0; seed < 100; seed++) {
    let state = seed + 1;
    const mapper = create(
      { ...design, intensity: 1, maximumBrightness: 35 },
      {
        random: () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32,
      },
    );
    const plain = create({ ...reference, intensity: 1, maximumBrightness: 35 });
    for (let i = 0; i < 150; i++) {
      const at = (i + 1) * 20;
      mapper.update(sample(i), at);
      plain.update(sample(i), at);
      const target = plain.render(at).brightness - 10;
      for (const position of [0, 0.5, 1]) {
        const amount = mapper.render(at, { position }).brightness - 10;
        assert.ok(
          amount >= target * 0.4 - 1e-8,
          "a random mask must retain the reference pulse foreground",
        );
        assert.ok(amount <= target + 1e-8, "randomness must not amplify the calibrated response");
      }
    }
    const b = mapper.inspect(3000).effective.behaviors;
    assert.equal(b.smoothing, 0.3);
    assert.equal(b.pulseDecayMs, 260);
    assert.equal(b.colorBlendMs, 300);
    assert.equal(mapper.inspect(3000).recipe.feel, "normal");
  }
});

test("reference-based random palettes rotate independently of the Expressive model", () => {
  const design = looks.find((look) => look.id === "rave-mix").design;
  const history = require("../recipe-history.cjs")();
  const chosen = [];
  for (let i = 0; i < 12; i++) {
    const mapper = create(design, { history, random: () => 0 });
    const view = mapper.inspect(0);
    assert.equal(view.effective.behaviors.expressiveEnabled, false);
    assert.equal(view.effective.behaviors.pulseDecayMs, 260);
    chosen.push(view.recipe.palette);
  }
  assert.equal(new Set(chosen.slice(0, 4)).size, 4, "exhaust the palette pool before repeating");
  assert.ok(chosen.every((palette, i) => !i || palette !== chosen[i - 1]));
  const pinned = create(
    {
      ...design,
      recipeOptions: {
        ...design.recipeOptions,
        palette: { mode: "fixed", value: "electric-pulse", allowed: ["electric-pulse"] },
      },
    },
    { history, random: () => 0 },
  );
  assert.equal(
    pinned.inspect(0).recipe.palette,
    "electric-pulse",
    "pinned choices bypass rotation",
  );
});

test("measured energy changes keep Pulse moving through missing onsets without inventing beats", () => {
  const design = {
    ...reference,
    intensity: 1,
    maximumBrightness: 100,
    floorDb: -44,
    ceilingDb: -20,
  };
  const responsive = create(design);
  const noSwells = create({ ...design, behaviors: { ...design.behaviors, swellsEnabled: false } });
  let lifted = 0;
  for (let i = 0; i < 150; i++) {
    const event = sample(i);
    event.rms = i < 100 ? 0.02 : i < 120 ? 0.07 : 0;
    event.signal = event.rms ? "signal" : "silent";
    event.analysis.onset = null;
    for (const mapper of [responsive, noSwells]) mapper.update(event, (i + 1) * 20);
    const context = { onsetSince: i * 20 };
    const current = responsive.render((i + 1) * 20, context);
    const plain = noSwells.render((i + 1) * 20, context);
    if (i >= 100 && i < 120) lifted = Math.max(lifted, current.brightness - plain.brightness);
    assert.equal(responsive.inspect((i + 1) * 20).metrics.attackAt, null);
    assert(current.brightness >= 10 && current.brightness <= 100);
  }
  assert(lifted > 5, "a real energy rise must remain visible without a spectral onset");
  for (let i = 150; i < 220; i++) {
    const event = {
      ...sample(i),
      rms: 0,
      signal: "silent",
      analysis: { valid: true, bandRms: [0, 0, 0], onset: null },
    };
    responsive.update(event, (i + 1) * 20);
  }
  assert.equal(
    responsive.render(4400, { onsetSince: 4380 }).brightness,
    10,
    "silence stays at the floor",
  );
});

test("adaptive reference output stays fast through a decaying pulse and settles afterward", () => {
  const design = settings({
    ...reference,
    outputHz: 12,
    outputRateMode: "adaptive",
    colorMode: "fixed",
  });
  const mapper = create(design),
    rate = cadence();
  let tailRate;
  for (let i = 0; i < 200; i++) {
    const event = sample(i);
    event.rms = 0.03;
    event.signal = "signal";
    event.analysis.onset = i === 25 ? { id: 26, detectedAtFrame: 26 * 960 } : null;
    mapper.update(event, (i + 1) * 20);
    const hz = rate.rate(design, mapper.inspect((i + 1) * 20), (i + 1) * 20);
    if (i === 60) tailRate = hz;
  }
  assert.equal(
    tailRate,
    12,
    "interpolation quality must survive the short onset detector activity",
  );
  assert.ok(rate.rate(design, mapper.inspect(4000), 4000) < 12);
  assert.equal(rate.rate(design, { fresh: false }, 4020), 2);
  assert.equal(rate.fixtureRate({ brand: "hue" }, 12), 8);
  assert.equal(cadence([{ brand: "hue" }, { brand: "hue" }]).fixtureRate({ brand: "hue" }, 12), 4);
});

test("reference color blending and mixed fixture movement contribute to adaptive demand", () => {
  const design = settings({
    ...reference,
    outputHz: 12,
    outputRateMode: "adaptive",
    behaviors: {
      ...reference.behaviors,
      attacksEnabled: false,
    },
  });
  const mapper = create(design);
  for (let i = 0; i <= 28; i++) mapper.update(sample(i), (i + 1) * 20);
  assert.equal(mapper.inspect(580).metrics.colorMotion, true);
  assert.equal(cadence().rate(design, mapper.inspect(580), 580), 12);
  const groupDesign = settings({
    ...reference,
    colorMode: "fixed",
    outputHz: 12,
    outputRateMode: "adaptive",
  });
  const group = require("../fixture-renderers.cjs")(
    create(groupDesign),
    [0, 1].map((position) => ({
      position,
      role: "all",
      raveBehavior: "reactive",
      assignedEffect: "bounce",
    })),
  );
  for (let i = 0; i < 100; i++) {
    const event = sample(i);
    event.analysis.onset = null;
    group.update(event, (i + 1) * 20);
  }
  assert.equal(group.inspect(2000).metrics.spatialMotion, true);
  assert.equal(cadence().rate(groupDesign, group.inspect(2000), 2000), 12);
});
