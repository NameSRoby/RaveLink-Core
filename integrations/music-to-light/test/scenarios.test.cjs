const test = require("node:test");
const assert = require("node:assert/strict");
const { choose, weights, chances } = require("../scenarios.cjs");
const { chooseLayers } = require("../scenarios.cjs");
const { settings } = require("../mapping-settings.cjs");
const createMapper = require("../mapper.cjs");
const event = (i, onset = false) => ({
  endFrame: i * 960,
  discontinuities: 0,
  rms: 0.08,
  signal: "signal",
  invalidSamples: 0,
  analysis: {
    valid: true,
    bandRms: [0.06, 0.03, 0.01],
    onset: onset ? { id: i, detectedAtFrame: i * 960 } : null,
  },
});
test("the complete recipe exists before audio and survives loudness, onsets, gaps and artistic edits", () => {
  let draws = 0;
  const m = createMapper(
    { scenarioMode: "random", layerMode: "random", palette: ["#ff0000", "#0000ff"] },
    {
      random: () => {
        draws++;
        return 0.4;
      },
    },
  );
  const initial = m.inspect(0);
  assert.equal(initial.recipeLocked, true);
  assert.ok(initial.scenario);
  assert.equal(initial.fresh, false);
  assert.equal(draws, 6);
  for (let i = 1; i <= 200; i++)
    m.update(
      {
        ...event(i, i % 10 === 0),
        rms: i % 3 === 0 ? 0.3 : 0.001,
        discontinuities: i > 100 ? 1 : 0,
      },
      i * 20,
    );
  const edited = m.configure({
    ...m.settings(),
    preset: "bands",
    arrangement: "roles",
    colorMode: "energy",
    palette: ["#00ff00"],
    feel: "aggressive",
    layerMode: "fixed",
    behaviors: { smoothing: 1 },
    maximumBrightness: 25,
  });
  const after = m.inspect(4000);
  assert.equal(after.recipeId, initial.recipeId);
  assert.deepEqual(after.scenario, initial.scenario);
  assert.equal(draws, 6);
  assert.deepEqual(edited.palette, ["#ff0000", "#0000ff"]);
  assert.equal(edited.colorMode, initial.effective.colorMode);
  assert.equal(edited.feel, initial.effective.feel);
  assert.equal(edited.behaviors.smoothing, initial.effective.behaviors.smoothing);
  assert.equal(edited.maximumBrightness, 25);
  m.configure({ ...m.settings(), maximumBrightness: 90 });
  assert.equal(m.settings().maximumBrightness, 25);
  const next = createMapper(
    { scenarioMode: "random", layerMode: "random" },
    { random: () => 0.99 },
  ).inspect(0);
  assert.notEqual(next.recipeId, initial.recipeId);
  assert.notEqual(next.scenario.id, initial.scenario.id);
});
test("draw odds depend only on operator weights", () => {
  assert.deepEqual(
    chances(weights()).map((r) => r.chance),
    [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6],
  );
  assert.deepEqual(
    chances(weights({ wash: 0, pulse: 3, bands: 1, wave: 0 })).map((r) => r.chance),
    [0, 0.75, 0.25, 0, 0, 0],
  );
});
test("random layer combinations are stable, respect hard blocks and keep the defining mechanism", () => {
  const b = settings().behaviors;
  for (const id of ["wash", "pulse", "bands", "wave"]) {
    const draw = chooseLayers({ ...b, colorEnabled: false }, id, () => 0.99);
    assert.equal(draw.colorEnabled, false);
    if (["pulse", "wave"].includes(id)) assert.equal(draw.attacksEnabled, true);
    if (id === "wave") assert.equal(draw.spatialEnabled, true);
  }
  let calls = 0;
  const m = createMapper(
    { scenarioMode: "random", layerMode: "random" },
    {
      random: () => {
        calls++;
        return 0.4;
      },
    },
  );
  for (let i = 1; i < 150; i++) m.update(event(i, i % 20 === 0), i * 20);
  const selected = m.inspect(2980).scenario;
  assert.ok(selected.layers);
  assert.equal(calls, 6);
  for (let i = 150; i < 200; i++) m.update(event(i), i * 20);
  assert.deepEqual(m.inspect(3980).scenario.layers, selected.layers);
  assert.equal(calls, 6);
});
test("a band scenario distributes ordinary all-role fixtures across frequency bands", () => {
  const m = createMapper({
    scenarioMode: "random",
    scenarioWeights: { wash: 0, pulse: 0, wave: 0, bands: 1 },
    colorMode: "fixed",
    palette: ["#ff0000", "#00ff00", "#0000ff"],
  });
  for (let i = 1; i <= 100; i++) m.update(event(i), i * 20);
  const low = m.render(2000, { role: "all", position: 0 }),
    high = m.render(2000, { role: "all", position: 1 });
  assert.notDeepEqual(low.rgb, high.rgb);
  assert.notEqual(low.brightness, high.brightness);
});
test("energy colors use the supplied palette independently of brightness and fixed roles retain assigned colors", () => {
  const m = createMapper({
    colorMode: "energy",
    minimumBrightness: 20,
    maximumBrightness: 20,
    palette: ["#ff0000", "#0000ff"],
  });
  for (let i = 1; i <= 100; i++) m.update({ ...event(i), rms: 0.001 }, i * 20);
  const quiet = m.render(2000);
  for (let i = 101; i <= 200; i++) m.update({ ...event(i), rms: 0.2 }, i * 20);
  const loud = m.render(4000);
  assert.equal(quiet.brightness, loud.brightness);
  assert.notDeepEqual(quiet.rgb, loud.rgb);
  const roles = createMapper({ colorMode: "roles", palette: ["#ff0000", "#00ff00", "#0000ff"] });
  roles.update(event(1), 20);
  assert.deepEqual(roles.render(20, { role: "mid", position: 0.5 }).rgb, { r: 0, g: 255, b: 0 });
});
test("weighted draws never choose blocked scenarios and explain normalized artistic odds", () => {
  const w = weights({ wash: 0, pulse: 2, bands: 0, wave: 1 });
  for (let i = 0; i < 100; i++) {
    const s = choose(w, () => i / 100);
    assert.ok(["pulse", "wave"].includes(s.id));
    assert.ok(Math.abs(s.candidates.reduce((n, r) => n + r.chance, 0) - 1) < 1e-10);
  }
  assert.equal(
    choose(weights({ wash: 0, pulse: 0, bands: 0, wave: 0 }), {
      level: 0,
      rise: 0,
      spread: 0,
      attack: false,
    }),
    null,
  );
  assert.throws(() => weights({ pulse: null }), /invalid_music_scenarios/);
  assert.throws(() => settings({ behaviors: { attackMs: 0 } }), /invalid_music_behaviors/);
  assert.throws(() => settings({ behaviors: { attacksEnabled: null } }), /invalid_music_behaviors/);
});
test("one scenario is drawn per request and inspection never consumes random choices", () => {
  let draws = 0;
  const m = createMapper(
    { scenarioMode: "random" },
    {
      random: () => {
        draws++;
        return 0.4;
      },
    },
  );
  for (let i = 1; i <= 150; i++) {
    m.update(event(i, i % 20 === 0), i * 20);
    m.render(i * 20);
    m.inspect(i * 20);
  }
  const selected = m.inspect(3000).scenario;
  assert.equal(draws, 1);
  assert.ok(selected);
  for (let i = 151; i <= 200; i++) m.update(event(i), i * 20);
  assert.equal(m.inspect(4000).scenario.id, selected.id);
  assert.equal(m.inspect(4300).fresh, false);
  assert.ok(m.inspect(4300).layers.every((l) => !l.active));
});
test("multiple responsive layers can be active and hard blocking removes their contribution", () => {
  const m = createMapper({
    preset: "pulse",
    colorMode: "onsets",
    palette: ["#ff0000", "#0000ff"],
    behaviors: { colorBlendMs: 0 },
  });
  for (let i = 1; i < 100; i++) m.update(event(i), i * 20);
  m.update(event(100, true), 2000);
  const before = m.render(2000);
  assert.ok(m.inspect(2000).layers.filter((l) => l.active).length >= 2);
  m.configure({
    ...m.settings(),
    behaviors: { ...m.settings().behaviors, attacksEnabled: false, colorEnabled: false },
  });
  const after = m.render(2000);
  assert.ok(after.brightness < before.brightness);
  assert.deepEqual(after.rgb, { r: 255, g: 0, b: 0 });
  assert.ok(
    m
      .inspect(2000)
      .layers.filter((l) => ["attacksEnabled", "colorEnabled"].includes(l.id))
      .every((l) => !l.active && !l.enabled),
  );
});
test("onset color blending is smooth, bounded and independent from brightness", () => {
  const m = createMapper({
    preset: "pulse",
    colorMode: "onsets",
    palette: ["#ff0000", "#0000ff"],
    behaviors: { colorBlendMs: 160 },
  });
  for (let i = 1; i <= 100; i++) m.update(event(i, i === 100), i * 20);
  assert.deepEqual(m.render(2000).rgb, { r: 255, g: 0, b: 0 });
  const halfway = m.render(2080).rgb;
  assert.ok(halfway.r > 0 && halfway.b > 0);
  assert.deepEqual(m.render(2160).rgb, { r: 0, g: 0, b: 255 });
  assert.deepEqual(m.render(2080), m.render(2080), "polling does not advance or restart the blend");
});
