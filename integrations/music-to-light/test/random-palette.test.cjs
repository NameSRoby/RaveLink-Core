const test = require("node:test");
const assert = require("node:assert/strict");
const generate = require("../random-palette.cjs");
const { rgb, oklch } = require("../palette-math.cjs");
const { family, create } = require("../temperature-colors.cjs");
const createMapper = require("../mapper.cjs");
const createLibrary = require("../saved-effects.cjs");
function seeded(seed) {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
const lab = (color) => {
  const [l, c, h] = oklch(rgb(color));
  return [l, c * Math.cos(h), c * Math.sin(h)];
};
const randomOption = { palette: { mode: "random", value: "generated", allowed: ["generated"] } };
test("5000 seeded palettes have 3-7 distinct stops, warm/cool coverage and pairwise separation", () => {
  const counts = new Set(),
    palettes = new Set();
  for (let seed = 0; seed < 5000; seed++) {
    const colors = generate(seeded(seed));
    counts.add(colors.length);
    palettes.add(colors.join());
    assert(colors.length >= 3 && colors.length <= 7);
    assert(colors.every((c) => /^#[0-9a-f]{6}$/.test(c)));
    assert(colors.some((c) => family(rgb(c)) === "warm"));
    assert(colors.some((c) => family(rgb(c)) === "cool"));
    for (let i = 0; i < colors.length; i++) {
      const a = lab(colors[i]);
      assert(a[0] >= 0.695 && a[0] <= 0.765);
      for (let j = 0; j < i; j++)
        assert(Math.hypot(...a.map((v, k) => v - lab(colors[j])[k])) >= generate.MIN_DISTANCE);
    }
  }
  assert.deepEqual([...counts].sort(), [3, 4, 5, 6, 7]);
  assert.equal(palettes.size, 5000);
  assert.deepEqual(generate(seeded(42)), generate(seeded(42)));
  for (const n of [-1, 1, NaN, Infinity]) assert.throws(() => generate(() => n));
  for (const n of [0, 0.5, 0.999999]) assert(generate(() => n).length >= 3);
});
test("generated palettes lock once, retain manual colors and freeze into saved looks", () => {
  const manual = ["#ff3300", "#0088ff"];
  let calls = 0;
  const random = seeded(33);
  const m = createMapper(
    { palette: manual, recipeOptions: randomOption },
    {
      random: () => {
        calls++;
        return random();
      },
    },
  );
  const generated = m.settings().palette,
    draws = calls;
  for (let i = 1; i <= 50; i++) {
    m.update(sample(i), i * 20);
    m.render(i * 20);
    m.inspect(i * 20);
  }
  m.configure({ palette: manual, intensity: 0.5, recipeOptions: randomOption });
  m.configure({ palette: manual, recipeOptions: randomOption, warmCoolColors: true });
  assert.equal(m.settings().warmCoolColors, true);
  assert.equal(calls, draws);
  assert.deepEqual(m.settings().palette, generated);
  const library = createLibrary();
  const saved = library.save({ name: "Generated favourite" }, m.inspect(1000));
  assert.deepEqual(saved.artistic.palette, generated);
  assert.equal(saved.artistic.recipeOptions.palette, undefined);
  assert.equal(m.inspect(1000).recipeLocked, true);
  const edited = createMapper({ palette: manual });
  edited.configure({ palette: manual, recipeOptions: randomOption });
  const first = edited.settings().palette;
  edited.configure({ palette: manual, recipeOptions: randomOption });
  assert.deepEqual(
    edited.settings().palette,
    first,
    "enabling randomness during a run locks its draw",
  );
});
function sample(i, bands = [0.1, 0.05, 0.02], rms = 0.1) {
  return {
    endFrame: i * 960,
    discontinuities: 0,
    rms,
    signal: rms ? "signal" : "silent",
    invalidSamples: 0,
    analysis: { valid: true, bandRms: bands, onset: null },
  };
}
test("temperature maps bass warm, treble cool, mids between, and overall follows actual band balance", () => {
  const palette = ["#ff3300", "#0088ff"].map(rgb);
  const t = create();
  const sampleColor = (stops) => stops[0];
  t.update([1, 0, 0], 10000);
  assert.deepEqual(t.color(palette, "low", sampleColor), palette[0]);
  assert.deepEqual(t.color(palette, "high", sampleColor), palette[1]);
  const bass = t.color(palette, "all", sampleColor);
  t.update([0, 0, 1], 10000);
  const treble = t.color(palette, "all", sampleColor);
  assert.notDeepEqual(bass, treble);
  const mid = t.color(palette, "mid", sampleColor);
  assert.notDeepEqual(mid, palette[0]);
  assert.notDeepEqual(mid, palette[1]);
  t.update([0, 0, 0], 10000);
  assert.deepEqual(t.color(palette, "all", sampleColor), treble);
});
test("production warm/cool toggle respects color blocks, silence, freshness and native brightness limits", () => {
  const m = createMapper({
    warmCoolColors: true,
    palette: ["#ff3300", "#0088ff"],
    maximumBrightness: 45,
  });
  for (let i = 1; i <= 100; i++) m.update(sample(i), i * 20);
  assert.equal(family(Object.values(m.render(2000, { role: "low" }).rgb)), "warm");
  assert.equal(family(Object.values(m.render(2000, { role: "high" }).rgb)), "cool");
  for (const role of ["low", "mid", "high", "all"]) {
    const frame = m.render(2000, { role, outOfSync: 100 });
    assert(frame.brightness >= 10 && frame.brightness <= 45);
    assert.deepEqual(m.render(2000, { role, outOfSync: 100 }), frame);
  }
  for (let i = 101; i <= 250; i++) m.update(sample(i, [0, 0, 0], 0), i * 20);
  assert.equal(m.render(5000).brightness, 10);
  assert.equal(m.render(5300), null);
  const blocked = createMapper({
    warmCoolColors: true,
    palette: ["#ff3300", "#0088ff"],
    behaviors: { colorEnabled: false },
  });
  blocked.update(sample(1), 20);
  assert.deepEqual(
    blocked.render(20, { role: "low" }).rgb,
    blocked.render(20, { role: "high" }).rgb,
  );
});

test("warm/cool is independent of all movement choices and stored effect recipes", () => {
  const palette = ["#ff3300", "#0088ff"];
  for (const colorMode of ["fixed", "travel", "onsets", "roles", "energy"]) {
    const m = createMapper({ colorMode, warmCoolColors: true, palette });
    for (let i = 1; i <= 100; i++) m.update(sample(i), i * 20);
    assert.equal(family(Object.values(m.render(2000, { role: "low" }).rgb)), "warm", colorMode);
    assert.equal(family(Object.values(m.render(2000, { role: "high" }).rgb)), "cool", colorMode);
    assert.equal(m.settings().colorMode, colorMode);
    const library = createLibrary();
    const saved = library.save({ name: "Bound colors" }, m.inspect(2000));
    library.policy({ mode: "single", ids: [saved.id] });
    const base = require("../mapping-settings.cjs").settings({ warmCoolColors: true });
    assert.equal(library.choose(base, []).design.warmCoolColors, true);
  }
});

test("brightness modes override locked randomness live while the palette and recipe stay fixed", () => {
  const m = createMapper({
    preset: "pulse",
    intensity: 1,
    maximumBrightness: 100,
    recipeOptions: randomOption,
    behaviors: { steadyBrightness: true, loudnessBrightness: true },
  });
  for (let i = 1; i <= 100; i++) m.update(sample(i, [0.005, 0.002, 0.001], 0.01), i * 20);
  assert.equal(m.render(2000).brightness, 100);
  const before = m.inspect(2000);
  for (const [steadyBrightness, loudnessBrightness] of [
    [false, true],
    [false, false],
    [true, false],
  ]) {
    m.configure({
      ...m.settings(),
      behaviors: { ...m.settings().behaviors, steadyBrightness, loudnessBrightness },
    });
    const after = m.inspect(2000);
    assert.equal(after.effective.behaviors.steadyBrightness, steadyBrightness);
    assert.equal(after.effective.behaviors.loudnessBrightness, loudnessBrightness);
    assert.equal(after.recipeId, before.recipeId);
    assert.deepEqual(after.recipe, before.recipe);
    assert.deepEqual(after.effective.palette, before.effective.palette);
    if (steadyBrightness) assert.equal(m.render(2000).brightness, 100);
    else assert(m.render(2000).brightness < 50);
  }
  assert(
    m
      .inspect(2000)
      .layers.filter((f) => ["attacksEnabled", "swellsEnabled", "spatialEnabled"].includes(f.id))
      .every((f) => !f.active),
  );
});
