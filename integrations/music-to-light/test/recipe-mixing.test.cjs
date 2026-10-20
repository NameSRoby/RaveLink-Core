const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../mapper.cjs"),
  recipe = require("../recipe.cjs");
const { settings } = require("../mapping-settings.cjs");
const mix = require("../looks.cjs").find((l) => l.id === "rave-mix").design;
const sample = (i) => ({
  endFrame: i * 960,
  discontinuities: 0,
  rms: 0.06,
  signal: "signal",
  invalidSamples: 0,
  analysis: {
    valid: true,
    bandRms: [0.05, 0.02, 0.005],
    onset: i % 12 === 0 ? { id: i, detectedAtFrame: i * 960 } : null,
  },
});
function seeded(seed) {
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

test("new activations combine independent axes; audio cannot redraw the combination", () => {
  const shapes = new Set(),
    palettes = new Set(),
    colors = new Set(),
    feels = new Set(),
    combinations = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    let draws = 0;
    const rng = seeded(seed * 1009);
    const m = create(mix, {
        random: () => {
          draws++;
          return rng();
        },
      }),
      initial = m.inspect(0);
    const before = draws;
    for (let i = 1; i <= 150; i++) m.update(sample(i), i * 20);
    assert.equal(draws, before);
    assert.deepEqual(m.inspect(3000).recipe, initial.recipe);
    assert.equal(m.inspect(3000).scenario.id, "pulse");
    const r = initial.recipe;
    shapes.add(r.shape);
    palettes.add(r.palette);
    colors.add(r.color);
    feels.add(r.feel);
    combinations.add(JSON.stringify(r));
    for (const [id, range] of Object.entries(mix.parameterRanges))
      assert.ok(r.parameters[id] >= range.min && r.parameters[id] <= range.max);
  }
  assert.equal(shapes.size, 6);
  assert.equal(palettes.size, 4);
  assert.equal(colors.size, 3);
  assert.equal(feels.size, 3);
  assert.ok(combinations.size >= 35);
});

test("every spatial choice combines with every brightness response", () => {
  for (const preset of ["ambient", "pulse", "bands"])
    for (const shape of recipe.axes[0].choices) {
      const m = create({
        preset,
        intensity: 1,
        minimumBrightness: 10,
        maximumBrightness: 100,
        recipeOptions: { shape: { mode: "fixed", value: shape, allowed: [shape] } },
      });
      for (let i = 1; i <= 250; i++) {
        m.update(sample(i), i * 20);
        for (const position of [0, 1 / 3, 2 / 3, 1]) {
          const f = m.render(i * 20, { position });
          assert.ok(f.brightness >= 10 && f.brightness <= 100);
          assert.ok(Object.values(f.rgb).every(Number.isFinite));
        }
      }
      assert.equal(m.inspect(5000).recipe.shape, shape);
    }
});

test("pinning, empty choices, invalid ranges and disabled tasks are explicit", () => {
  assert.throws(
    () => create({ recipeOptions: { shape: { mode: "random", value: "bounce", allowed: [] } } }),
    /music_no_recipe_choices/,
  );
  assert.throws(
    () => settings({ parameterRanges: { maximumBrightness: { min: 0, max: 100 } } }),
    /invalid_music_parameter_ranges/,
  );
  assert.throws(
    () => settings({ parameterRanges: { pulseDecayMs: { min: 500, max: 200 } } }),
    /invalid_music_parameter_ranges/,
  );
  const config = settings({
    recipeOptions: {
      task: { mode: "random", value: "reactive", allowed: ["reactive", "steady"] },
      role: { mode: "random", value: "all", allowed: ["low", "high"] },
    },
  });
  const rows = [
    { id: "a", role: "all" },
    { id: "b", role: "all" },
  ];
  let roll = 0;
  const assigned = recipe.fixtures(rows, config, true, () => {
    roll++;
    return roll % 2 ? 0.1 : 0.9;
  });
  assert.ok(assigned.every((f) => ["reactive", "steady"].includes(f.raveBehavior)));
  assert.ok(assigned.every((f) => ["low", "high"].includes(f.role)));
  assert.ok(rows.every((f) => f.role === "all" && !f.raveBehavior));
  assert.ok(
    recipe.fixtures(rows, config, false, () => 0.9).every((f) => f.raveBehavior === "reactive"),
    "manual music never inherits Rave-only off/dim tasks",
  );
});

test("mirror pairing and call-and-response assign purposeful leading sides", () => {
  const design = (shape) => ({
    preset: "pulse",
    intensity: 1,
    recipeOptions: { shape: { mode: "fixed", value: shape, allowed: [shape] } },
    behaviors: { handoffHits: 1, handoffMs: 100 },
  });
  const mirror = create(design("mirror"));
  for (let i = 1; i <= 100; i++) mirror.update(sample(i), i * 20);
  assert.equal(
    mirror.render(2000, { position: 0 }).brightness,
    mirror.render(2000, { position: 1 }).brightness,
  );
  const m = create(design("handoff"));
  let sides = [];
  for (let i = 1; i <= 150; i++) {
    m.update(sample(i), i * 20);
    if (i % 12 === 6 && i > 20)
      sides.push(
        Math.sign(
          m.render(i * 20, { position: 0 }).brightness -
            m.render(i * 20, { position: 1 }).brightness,
        ),
      );
  }
  assert.ok(sides.includes(1) && sides.includes(-1));
});
