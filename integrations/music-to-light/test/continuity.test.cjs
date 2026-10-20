const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../mapper.cjs");
const looks = require("../looks.cjs");
const { settings } = require("../mapping-settings.cjs");
test("every reactive color mode visits multiple colors on sustained audio, with stable brightness", () => {
  for (const colorMode of ["fixed", "roles", "energy", "onsets", "travel"]) {
    const m = create({
      preset: "pulse",
      colorMode,
      colorSeconds: 2,
      palette: ["#ff0000", "#00ff00", "#0000ff"],
    });
    const colors = [new Set(), new Set()];
    const brightness = [];
    for (let i = 1; i <= 800; i++) {
      m.update(sample(i), i * 20);
      if (i > 200 && i % 20 === 0) {
        for (const [slot, role] of ["low", "high"].entries()) {
          const frame = m.render(i * 20, { role, position: slot });
          colors[slot].add(JSON.stringify(frame.rgb));
          assert.deepEqual(m.render(i * 20, { role, position: slot }), frame);
        }
        brightness.push(m.render(i * 20).brightness);
      }
    }
    assert(
      colors.every((set) => set.size >= 5),
      `${colorMode} must move each fixture through the palette`,
    );
    assert(
      Math.max(...brightness) - Math.min(...brightness) < 0.01,
      "color movement must not modulate brightness",
    );
  }
});
test("legacy monochrome palettes expand deterministically and color blocking remains explicit", () => {
  const m = create({ palette: ["#ff0000", "#ff0000"], colorMode: "roles", colorSeconds: 2 });
  assert.equal(new Set(m.settings().palette).size, 2);
  assert.deepEqual(create({ palette: ["#ff0000"] }).settings().palette, m.settings().palette);
  m.configure({
    palette: ["#00ff00"],
    colorMode: "roles",
    colorSeconds: 2,
    behaviors: { colorEnabled: false },
  });
  const colors = new Set();
  for (let i = 1; i <= 400; i++) {
    m.update(sample(i), i * 20);
    colors.add(JSON.stringify(m.render(i * 20).rgb));
  }
  assert.equal(colors.size, 1);
  assert.equal(new Set(m.settings().palette).size, 2);
});
function sample(i, onset = false, rms = 0.06) {
  return {
    endFrame: i * 960,
    discontinuities: 0,
    rms,
    signal: rms ? "signal" : "silent",
    invalidSamples: 0,
    analysis: {
      valid: true,
      bandRms: [rms * 0.8, rms * 0.4, rms * 0.1],
      onset: onset ? { id: i, detectedAtFrame: i * 960 } : null,
    },
  };
}
test("a new onset continues from the current color, including interrupted fades", () => {
  const m = create({
    colorMode: "onsets",
    palette: ["#ff0000", "#00ff00", "#0000ff"],
    behaviors: { colorBlendMs: 500, colorVibrance: 1 },
  });
  for (let i = 1; i <= 50; i++) m.update(sample(i, i === 40), i * 20);
  const before = m.render(1020).rgb;
  m.update(sample(51, true), 1020);
  assert.deepEqual(m.render(1020).rgb, before);
  const later = m.render(1100).rgb;
  assert.notDeepEqual(later, before);
  assert.deepEqual(m.render(1100).rgb, later, "polling cannot advance the transition");
});
test("an attack resumes from gentle idle palette travel without a color jump", () => {
  const m = create({
    colorMode: "onsets",
    colorSeconds: 2,
    palette: ["#ff0000", "#00ff00", "#0000ff"],
    behaviors: { colorBlendMs: 500, colorVibrance: 1 },
  });
  for (let i = 1; i <= 175; i++) m.update(sample(i), i * 20);
  const before = m.render(3520).rgb;
  m.update(sample(176, true), 3520);
  assert.deepEqual(m.render(3520).rgb, before);
  assert.notDeepEqual(m.render(3640).rgb, before);
});
test("a handoff interrupted by another attack starts at its interpolated position", () => {
  const m = create({
    preset: "ambient",
    intensity: 1,
    recipeOptions: { shape: { mode: "fixed", value: "handoff", allowed: ["handoff"] } },
    behaviors: { handoffHits: 1, handoffMs: 500, ambientBed: 1 },
  });
  for (let i = 1; i <= 300; i++) m.update(sample(i, i === 280 || i === 290), i * 20);
  const before = [0, 1].map((position) => m.render(6020, { position }).brightness);
  m.update(sample(301, true), 6020);
  const after = [0, 1].map((position) => m.render(6020, { position }).brightness);
  after.forEach((value, i) =>
    assert.ok(Math.abs(value - before[i]) < 1e-5, JSON.stringify({ before, after })),
  );
});
test("older measured wave fronts reach distant fixtures under repeated attacks", () => {
  function run(waveVoices) {
    const m = create({
      preset: "pulse",
      intensity: 1,
      maximumBrightness: 100,
      recipeOptions: { shape: { mode: "fixed", value: "wave", allowed: ["wave"] } },
      behaviors: { waveVoices, waveMs: 1200, waveWidth: 0.4, waveDepth: 1 },
    });
    for (let i = 1; i <= 200; i++) m.update(sample(i, i % 10 === 0), i * 20);
    return m.render(4000, { position: 1 }).brightness;
  }
  assert.equal(run(1), 10);
  assert.ok(run(12) > 30, "a new onset must not erase every older travelling front");
});
test("sub-floor noise settles without turning a quiet room into continuing color motion", () => {
  const m = create({ preset: "ambient", colorMode: "travel", colorSeconds: 2 });
  for (let i = 1; i <= 150; i++) m.update(sample(i, false, 0.00001), i * 20);
  const a = m.render(3000, { position: 0 }),
    b = m.render(3000, { position: 1 });
  assert.equal(a.quiet, true);
  assert.equal(a.brightness, 10);
  assert.deepEqual(a.rgb, b.rgb);
});
test("composition selections reset artistic overrides and preserve host-owned limits", () => {
  const prior = settings({
    ...looks.find((l) => l.id === "rave-mix").design,
    maximumBrightness: 42,
    floorDb: -47,
    ceilingDb: -23,
    outputHz: 16,
  });
  for (const id of ["electric-pulse", "aurora-swell", "prism-bands", "smooth-reference"]) {
    const look = looks.find((l) => l.id === id),
      merged = settings({ ...prior, ...look.design });
    assert.equal(merged.maximumBrightness, 42);
    assert.equal(merged.floorDb, -47);
    assert.equal(merged.ceilingDb, -23);
    assert.equal(merged.outputHz, 16);
    const m = create(merged);
    assert.equal(m.preset(), look.design.preset);
    assert.equal(m.inspect(0).recipeLocked, false);
  }
});
test("a moving-color draw retains its mechanism and respects an explicit color block", () => {
  const mix = looks.find((l) => l.id === "rave-mix").design;
  for (const colorEnabled of [true, false]) {
    const m = create(
      {
        ...mix,
        recipeOptions: {
          ...mix.recipeOptions,
          color: { mode: "fixed", value: "travel", allowed: ["travel"] },
        },
        behaviors: { ...mix.behaviors, colorEnabled },
      },
      { random: () => 0.99 },
    );
    const layer = m.inspect(0).layers.find((l) => l.id === "colorEnabled");
    assert.equal(layer.selected, colorEnabled);
  }
});
