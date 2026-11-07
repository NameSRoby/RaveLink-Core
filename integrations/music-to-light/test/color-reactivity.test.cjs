const test = require("node:test");
const assert = require("node:assert/strict");
const create = require("../color-reactivity.cjs");
const mapper = require("../mapper.cjs");

test("sustained low energy gives slower gestures and fades than high energy", () => {
  const low = create(),
    high = create();
  for (let i = 0; i < 300; i++) {
    low.update(0.2, 20);
    high.update(0.95, 20);
  }
  const quiet = low.timing(60),
    intense = high.timing(60);
  assert(quiet.intervalMs > intense.intervalMs * 4);
  assert(quiet.blendMs > intense.blendMs * 4);
  assert(intense.intervalMs >= 150 && quiet.intervalMs <= 1000);
});

test("short dips do not collapse color speed but sustained quiet settles it", () => {
  const state = create();
  for (let i = 0; i < 100; i++) state.update(1, 20);
  state.update(0.1, 20);
  assert(state.timing().intervalMs < 200);
  for (let i = 0; i < 150; i++) state.update(0.1, 20);
  assert(state.timing().intervalMs > 800);
  for (let i = 0; i < 10; i++) state.update(1, 20);
  assert(state.timing().intervalMs < 220, "intensity should increase reactivity promptly");
});

test("dense measured attacks and spectral activity keep compressed passages reactive", () => {
  const sustained = create(),
    dense = create(),
    texture = create();
  for (let i = 0; i < 150; i++) {
    sustained.update(0.4, 20);
    dense.update(0.4, 20, 1, { attack: i % 10 === 0 });
    texture.update(0.4, 20, 1, { novelty: 1 });
  }
  assert(dense.timing().intervalMs < sustained.timing().intervalMs * 0.7);
  assert(texture.timing().intervalMs < sustained.timing().intervalMs);
  assert(
    Math.abs(dense.timing().loudness - sustained.timing().loudness) < 1e-8,
    "color activity must not redefine the measured loudness",
  );
});

test("a pronounced measured attack can use the next color slot without a brightness accent", () => {
  const m = mapper({
    interpretation: "literal",
    outputHz: 12,
    intensity: 0.75,
    maximumBrightness: 100,
    floorDb: -44,
    ceilingDb: -20,
    behaviors: {
      attacksEnabled: false,
      smoothing: 0,
      colorBlendMs: 60,
      literalAttackMs: 120,
      literalReleaseMs: 240,
    },
  });
  for (let i = 1; i <= 80; i++)
    m.update(
      {
        endFrame: i * 960,
        discontinuities: 0,
        rms: 0.09,
        signal: "signal",
        invalidSamples: 0,
        analysis: {
          valid: true,
          bandRms: [0.03, 0.01, 0.005],
          onset: [65, 71].includes(i)
            ? { id: i, detectedAtFrame: i * 960, strength: i === 71 ? 2 : 1.01 }
            : null,
          onsetThreshold: 1,
        },
      },
      i * 20,
    );
  assert.equal(m.inspect(1600).metrics.colorChangeAt, 1420);
  assert.equal(m.inspect(1600).metrics.colorBlendMs, 60);
});

test("quiet logarithmic attacks remain visible below the brightness floor without Expressive", () => {
  const accepted = require("../profiles/accepted-color-led-v1.json");
  const m = mapper({ ...accepted, floorDb: -44, ceilingDb: -20 });
  const colors = new Set();
  for (let i = 1; i <= 120; i++) {
    m.update(
      {
        endFrame: i * 960,
        discontinuities: 0,
        rms: 0.003,
        signal: "signal",
        invalidSamples: 0,
        analysis: {
          valid: true,
          bandRms: [0.002, 0.001, 0.0005],
          onset: null,
          onsetThreshold: 0.001,
          logOnsetThreshold: 0.01,
          logSpectralFlux: 0.015,
          logOnset: [65, 85, 105].includes(i)
            ? { id: i, detectedAtFrame: i * 960, strength: 0.015 }
            : null,
        },
      },
      i * 20,
    );
    if ([68, 88, 108].includes(i)) colors.add(JSON.stringify(m.render(i * 20).rgb));
  }
  assert.equal(colors.size, 2, "quiet hits retain the same neighboring-color phrase as loud hits");
  assert.equal(m.render(2400).quiet, true);
  assert.equal(m.inspect(2400).metrics.colorChangeAt, 2100);
  assert.equal(m.settings().behaviors.expressiveEnabled, false);
});

test("sample-clock-qualified hits survive small delivery-clock jitter", () => {
  const accepted = require("../profiles/accepted-color-led-v1.json");
  const m = mapper(accepted);
  let hits = 0,
    changes = 0,
    previous = null;
  for (let i = 1; i <= 120; i++) {
    const hit = i % 6 === 1;
    const at = i * 20 + (i % 12 === 1 ? 0.01 : -0.01);
    m.update(
      {
        endFrame: i * 960,
        discontinuities: 0,
        rms: 0.003,
        signal: "signal",
        invalidSamples: 0,
        analysis: {
          valid: true,
          bandRms: [0.002, 0.001, 0.0005],
          onsetThreshold: 1,
          onset: hit ? { id: i, detectedAtFrame: i * 960, strength: 1.01 } : null,
        },
      },
      at,
    );
    if (hit) hits++;
    const current = m.inspect(at).metrics.colorChangeAt;
    if (current !== previous) {
      changes++;
      previous = current;
    }
  }
  assert.equal(
    changes,
    hits,
    "a second wall-clock refractory check must not discard a genuine hit",
  );
});

test("quiet drums and loud drums receive equal color timing without brightness pulses", () => {
  const design = {
    interpretation: "literal",
    outputHz: 12,
    intensity: 0.75,
    maximumBrightness: 100,
    floorDb: -44,
    ceilingDb: -20,
    colorMode: "onsets",
    behaviors: {
      attacksEnabled: false,
      smoothing: 0,
      literalAttackMs: 120,
      literalReleaseMs: 240,
      colorBlendMs: 60,
      outputColorMs: 0,
    },
  };
  const changes = [];
  for (const level of [-0.2, 0.95]) {
    const colors = mapper(design),
      plain = mapper(design);
    let prior = null,
      count = 0;
    const visible = new Set();
    for (let i = 1; i <= 250; i++) {
      const at = i * 20,
        rms = 10 ** ((-44 + 24 * level) / 20);
      const event = {
        endFrame: i * 960,
        discontinuities: 0,
        rms,
        signal: "signal",
        invalidSamples: 0,
        analysis: {
          valid: true,
          bandRms: [rms * 0.8, rms * 0.4, rms * 0.1],
          onset: i % 5 === 1 ? { id: i, detectedAtFrame: i * 960, strength: 1.01 } : null,
          onsetThreshold: 1,
        },
      };
      colors.update(event, at);
      plain.update({ ...event, analysis: { ...event.analysis, onset: null } }, at);
      assert.equal(
        colors.render(at).brightness,
        plain.render(at).brightness,
        "color events cannot pulse brightness",
      );
      const changed = colors.inspect(at).metrics.colorChangeAt;
      if (i > 100) visible.add(JSON.stringify(colors.render(at).rgb));
      if (changed !== prior) {
        count++;
        prior = changed;
      }
    }
    changes.push(count);
    assert(
      visible.size >= 3,
      "quiet beats must change the rendered colors even below the brightness floor",
    );
  }
  assert.equal(
    changes[1],
    changes[0],
    "quiet beats must not be held by a loudness-dependent timer",
  );
  assert(changes[0] > 20);
});
