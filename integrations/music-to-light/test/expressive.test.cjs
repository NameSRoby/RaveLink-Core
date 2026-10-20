const test = require("node:test"),
  assert = require("node:assert/strict");
const palette = require("../palette-math.cjs");
const { compose, focus, reactivePositions } = require("../composition.cjs");
const createHistory = require("../recipe-history.cjs");
const createMapper = require("../mapper.cjs");
const { settings, FEELS } = require("../mapping-settings.cjs");
const scenarios = require("../scenarios.cjs");
const looks = require("../looks.cjs");
const spectral = require("../analysis-protocol.cjs");
const random =
  (seed = 42) =>
  () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
function sample(i, raw = null, logged = null) {
  return {
    endFrame: i * 960,
    discontinuities: 0,
    rms: 0.2,
    signal: "signal",
    invalidSamples: 0,
    analysis: { valid: true, bandRms: [0.15, 0.05, 0.01], onset: raw, logOnset: logged },
  };
}
test("OKLCH preserves palette endpoints, neutral stability and gamut at every interpolation step", () => {
  const colors = ["#ff0000", "#00ffff", "#000000", "#ffffff", "#008cff", "#7024ff"].map(
    palette.rgb,
  );
  for (const a of colors)
    for (const b of colors) {
      assert.deepEqual(palette.perceptual(a, b, 0), a);
      assert.deepEqual(palette.perceptual(a, b, 1), b);
      for (let i = 0; i <= 100; i++)
        assert(
          palette.perceptual(a, b, i / 100).every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
        );
    }
  const middle = palette.perceptual(colors[0], colors[1], 0.5);
  assert(
    palette.oklch(middle)[1] > 0.08,
    "complementary colors should not pass through a grey midpoint",
  );
  assert.deepEqual(palette.perceptual([128, 128, 128], [128, 128, 128], 0.5), [128, 128, 128]);
});
test("spatial kernels retain a sampled peak on sparse layouts and all mixtures remain bounded", () => {
  const b = settings().behaviors;
  for (const positions of [[0], [0, 1], [0, 0.333, 0.667, 1]])
    for (const width of [0.1, 0.5, 1]) {
      for (let i = 0; i <= 100; i++) {
        const front = i / 100;
        assert.equal(
          Math.max(...positions.map((position) => focus(position, front, width, positions))),
          1,
        );
        for (const shape of ["unison", "wave", "bounce", "mirror", "handoff", "swell"])
          for (const share of [0, 0.15, 0.5])
            for (const position of positions) {
              const value = compose({
                shape,
                position,
                positions,
                at: i * 20,
                onsets: [0, 1000],
                audioTravel: i / 10,
                side: front,
                feel: FEELS.normal,
                b: { ...b, waveWidth: width, spatialAccentShare: share },
              });
              assert(Number.isFinite(value) && value >= 0 && value <= 1);
            }
      }
    }
  assert.deepEqual(
    reactivePositions([
      { position: 0, raveBehavior: "off" },
      { position: 1, raveBehavior: "reactive" },
    ]),
    [1],
  );
});
test("weighted shuffle visits allowed choices once per bag and resets when a choice is blocked", () => {
  const history = createHistory(),
    rng = random();
  const values = [
    { id: "a", weight: 1 },
    { id: "b", weight: 3 },
    { id: "blocked", weight: 0 },
  ];
  for (let i = 0; i < 20; i++) {
    const first = history.draw("shape", values, rng),
      second = history.draw("shape", values, rng);
    assert.notEqual(first.id, second.id);
    assert.equal(second.probabilities[first.id], 0);
    assert.equal(second.probabilities[second.id], 1);
  }
  assert.equal(history.draw("shape", [{ id: "a", weight: 1 }], rng).id, "a");
  assert.equal(history.draw("shape", [{ id: "a", weight: 1 }], rng).id, "a");
  assert.equal(
    history.draw(
      "weights",
      [
        { id: "a", weight: 1 },
        { id: "b", weight: 3 },
      ],
      () => 0.5,
    ).id,
    "b",
  );
  assert.equal(
    history.draw(
      "tiny",
      [
        { id: "a", weight: Number.MIN_VALUE },
        { id: "b", weight: Number.MIN_VALUE },
      ],
      () => 0.5,
    ).id,
    "a",
  );
  assert.throws(() => history.draw("bad", values, () => 1), /invalid_music_random/);
  const scenarioHistory = createHistory();
  const weights = scenarios.weights({
    pulse: 1,
    wave: 1,
    wash: 0,
    bands: 0,
    bounce: 0,
    handoff: 0,
  });
  const first = scenarios.choose(weights, rng, scenarioHistory),
    second = scenarios.choose(weights, rng, scenarioHistory);
  assert.notEqual(first.id, second.id);
  assert.equal(second.candidates.find((r) => r.id === first.id).chance, 0);
});
test("expressive activation uses log onsets, keeps its recipe locked and leaves brightness calibration intact", () => {
  const design = looks.find((look) => look.id === "expressive-mix").design;
  let draws = 0;
  const rng = random();
  const m = createMapper(
    { ...design, minimumBrightness: 10, maximumBrightness: 80, floorDb: -48, ceilingDb: -24 },
    {
      history: createHistory(),
      random: () => {
        draws++;
        return rng();
      },
    },
  );
  m.setPositions([0, 1]);
  const recipe = m.inspect(0).recipe;
  const initialDraws = draws;
  for (let i = 1; i <= 800; i++) {
    const logged = i % 20 === 0 ? { id: i, detectedAtFrame: i * 960 } : null;
    m.update(sample(i, null, logged), i * 20);
    for (const position of [0, 1]) {
      const frame = m.render(i * 20, { position });
      assert(frame.brightness >= 10 && frame.brightness <= 80);
      assert.deepEqual(m.render(i * 20, { position }), frame);
    }
  }
  assert.equal(draws, initialDraws);
  assert.deepEqual(m.inspect(16000).recipe, recipe);
  assert(
    m
      .inspect(16000)
      .layers.find((row) => row.id === "attacksEnabled")
      .reason.includes("Log-spectral"),
  );
  assert.equal(m.settings().floorDb, -48);
  assert.equal(m.settings().ceilingDb, -24);
  const classic = createMapper({ preset: "pulse", behaviors: { spatialEnabled: false } });
  const enhanced = createMapper({
    preset: "pulse",
    behaviors: { spatialEnabled: false, expressiveEnabled: true },
  });
  for (let i = 1; i <= 100; i++) {
    const raw = i === 100 ? { id: 1, detectedAtFrame: 96000 } : null;
    classic.update(sample(i, raw, null), i * 20);
    enhanced.update(sample(i, raw, null), i * 20);
  }
  assert(
    classic.render(2000).brightness > enhanced.render(2000).brightness,
    "a legacy-only onset must not masquerade as a log onset",
  );
});
test("parallel onset protocol enforces independent replay, strength and validity checks", () => {
  const raw = {
    first_frame: 0,
    end_frame: 2048,
    band_rms: [0.1, 0.1, 0.1],
    spectral_flux: 0.2,
    onset_threshold: 0.1,
    onset: null,
    valid: true,
    log_spectral_flux: 0.02,
    log_onset_threshold: 0.01,
    log_onset: { id: 1, detected_at_frame: 2048, strength: 0.02 },
  };
  assert.equal(spectral.analysis(raw, 2048, 8, 0).logOnset.id, 1);
  assert.throws(() => spectral.analysis(raw, 2048, 8, 1), /native_invalid_analysis/);
  assert.throws(
    () => spectral.analysis({ ...raw, log_spectral_flux: NaN }, 2048, 0),
    /native_invalid_analysis/,
  );
  assert.throws(
    () => spectral.analysis({ ...raw, valid: false, spectral_flux: 0 }, 2048, 0),
    /native_invalid_analysis/,
  );
});

test("dense attacks cannot continually erase travelling fronts before they reach distant lights", () => {
  const m = createMapper({
    preset: "pulse",
    intensity: 1,
    maximumBrightness: 90,
    recipeOptions: { shape: { mode: "fixed", value: "wave", allowed: ["wave"] } },
    behaviors: {
      expressiveEnabled: true,
      waveVoices: 8,
      waveMs: 4000,
      waveWidth: 0.2,
      waveDepth: 1,
      spatialAccentShare: 0,
    },
  });
  m.setPositions([0, 1]);
  for (let i = 1; i <= 180; i++)
    m.update(sample(i, null, i % 6 === 0 ? { id: i, detectedAtFrame: i * 960 } : null), i * 20);
  assert(
    m.render(3600, { position: 1 }).brightness > 30,
    "old fronts must survive dense new onsets",
  );
});

test("individual enhancement switches restore reference behavior without resetting onset identity", () => {
  const baseline = {
    preset: "pulse",
    recipeOptions: { shape: { mode: "fixed", value: "bounce", allowed: ["bounce"] } },
    colorMode: "travel",
    palette: ["#ff075b", "#008cff"],
    behaviors: { spatialEnabled: true },
  };
  const reference = createMapper(baseline);
  const candidate = createMapper({
    ...baseline,
    behaviors: {
      ...baseline.behaviors,
      expressiveEnabled: true,
      logAttacksEnabled: false,
      perceptualColorsEnabled: false,
      smoothShapesEnabled: false,
      shuffleChoicesEnabled: false,
    },
  });
  for (let i = 1; i <= 400; i++) {
    const onset = i % 20 === 0 ? { id: i, detectedAtFrame: i * 960 } : null;
    const event = sample(i, onset, null);
    reference.update(event, i * 20);
    candidate.update(event, i * 20);
    for (const position of [0, 0.5, 1])
      assert.deepEqual(
        candidate.render(i * 20, { position }),
        reference.render(i * 20, { position }),
      );
  }
  candidate.configure({
    ...candidate.settings(),
    behaviors: { ...candidate.settings().behaviors, logAttacksEnabled: true },
  });
  assert.doesNotThrow(() =>
    candidate.update(sample(401, null, { id: 1, detectedAtFrame: 401 * 960 }), 8020),
  );
});

test("a fast Pulse wave carries its attack to the far fixture before the global envelope decays", () => {
  const mapper = createMapper({
    preset: "pulse",
    feel: "fast",
    intensity: 1,
    maximumBrightness: 100,
    recipeOptions: { shape: { mode: "fixed", value: "wave", allowed: ["wave"] } },
    behaviors: {
      expressiveEnabled: true,
      smoothShapesEnabled: true,
      spatialEnabled: true,
      pulseBed: 0,
      pulseDecayMs: 80,
      waveMs: 1500,
      waveDepth: 1,
      spatialAccentShare: 0,
    },
  });
  mapper.setPositions([0, 1]);
  for (let i = 1; i <= 45; i++) {
    const onset = i === 1 ? { id: 1, detectedAtFrame: 960 } : null;
    mapper.update(sample(i, onset, onset), i * 20);
  }
  const far = mapper.render(900, { position: 1 });
  assert.ok(
    far.brightness > 70,
    "the measured attack remains visible when its travelling front arrives",
  );
});
