const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../musical-color.cjs"),
  createMapper = require("../mapper.cjs");
const { oklch } = require("../palette-math.cjs");
const palette = [
  [255, 7, 91],
  [112, 36, 255],
  [0, 140, 255],
];
function drive(color, overrides = {}) {
  color.update({
    delta: 20,
    energy: 0.7,
    bands: [0.1, 0.05, 0.02],
    flux: 0.2,
    threshold: 0.3,
    strength: 0,
    seconds: 8,
    blendMs: 300,
    motion: 1,
    ...overrides,
  });
}
function delta(a, b) {
  const lab = (rgb) => {
    const [l, c, h] = oklch(rgb);
    return [l, c * Math.cos(h), c * Math.sin(h)];
  };
  const from = lab(a),
    to = lab(b);
  return Math.hypot(...from.map((v, i) => v - to[i]));
}
test("measured audio carries visible color travel between onsets without polling advancing it", () => {
  const c = create();
  const first = c.color(palette);
  for (let i = 0; i < 50; i++) drive(c);
  assert(delta(first, c.color(palette)) > 0.02);
  const at = c.color(palette);
  for (let i = 0; i < 100; i++) assert.deepEqual(c.color(palette), at);
  for (let i = 0; i < 100; i++) drive(c, { energy: 0, strength: 1 });
  assert.deepEqual(c.color(palette), at, "silent input cannot continue palette travel");
});
test("measured novelty and strength change travel but dense attacks cannot create unbounded jumps", () => {
  const gentle = create(),
    strong = create();
  drive(gentle, { strength: 0.02 });
  drive(strong, { strength: 1, flux: 0.8 });
  assert(delta(palette[0], strong.color(palette)) > delta(palette[0], gentle.color(palette)));
  let previous = strong.color(palette);
  for (let i = 0; i < 500; i++) {
    drive(strong, { strength: 1, flux: 1 });
    const next = strong.color(palette);
    assert(next.every((v) => Number.isInteger(v) && v >= 0 && v <= 255));
    assert(
      delta(previous, next) < 0.06,
      "20 ms color travel stays bounded even under repeated maximum evidence",
    );
    previous = next;
  }
  strong.reset();
  assert.deepEqual(strong.color(palette), palette[0]);
});
test("band balance contributes bounded color movement without influencing brightness", () => {
  const a = createMapper({
    preset: "pulse",
    intensity: 0.6,
    maximumBrightness: 75,
    colorMode: "onsets",
    behaviors: { expressiveEnabled: true, colorBlendMs: 300 },
  });
  const b = createMapper({
    ...a.settings(),
    behaviors: { ...a.settings().behaviors, perceptualColorsEnabled: false },
  });
  const variants = new Set();
  for (let i = 1; i <= 300; i++) {
    const bright = i % 60 < 30;
    const event = {
      endFrame: i * 960,
      discontinuities: 0,
      rms: 0.1,
      signal: "signal",
      invalidSamples: 0,
      analysis: {
        valid: true,
        bandRms: bright ? [0.08, 0.03, 0.01] : [0.01, 0.03, 0.08],
        onset: null,
        logOnset: null,
        logSpectralFlux: 0.2,
        logOnsetThreshold: 0.3,
      },
    };
    a.update(event, i * 20);
    b.update(event, i * 20);
    const frame = a.render(i * 20);
    assert.equal(frame.brightness, b.render(i * 20).brightness);
    variants.add(JSON.stringify(frame.rgb));
  }
  assert(variants.size > 50);
  assert.equal(a.settings().maximumBrightness, 75);
});

test("repeated threshold-edge attacks move color and retain accents at constant volume", () => {
  const m = createMapper({
    preset: "pulse",
    intensity: 1,
    maximumBrightness: 100,
    palette: ["#ff075b", "#7024ff", "#008cff"],
    colorMode: "onsets",
    behaviors: { expressiveEnabled: true, colorBlendMs: 300 },
  });
  const shifts = [];
  let previous = null;
  for (let i = 1; i <= 300; i++) {
    const onset = i % 20 === 0 ? { id: i, detectedAtFrame: i * 960, strength: 1.02 } : null;
    m.update(
      {
        endFrame: i * 960,
        discontinuities: 0,
        rms: 0.1,
        signal: "signal",
        invalidSamples: 0,
        analysis: {
          valid: true,
          bandRms: [0.08, 0.04, 0.01],
          logOnset: onset,
          logOnsetThreshold: 1,
          logSpectralFlux: onset ? 1.02 : 0.1,
        },
      },
      i * 20,
    );
    if (onset) {
      const frame = m.render(i * 20);
      assert(frame.brightness > 45, "a native-qualified regular attack must not disappear");
      const color = Object.values(frame.rgb);
      if (previous) shifts.push(delta(previous, color));
      previous = color;
      assert.equal(m.inspect(i * 20).metrics.colorMotion, true);
    }
  }
  assert(
    shifts.every((shift) => shift > 0.015),
    "each musical interval carries color movement",
  );
});
