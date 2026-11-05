const test = require("node:test"),
  assert = require("node:assert/strict");
const plan = require("../fixture-planner.cjs"),
  history = require("../recipe-history.cjs");
const { settings } = require("../mapping-settings.cjs");
const createMapper = require("../mapper.cjs"),
  renderers = require("../fixture-renderers.cjs");
const savedEffects = require("../saved-effects.cjs");
const recipe = require("../recipe.cjs");
const random = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const option = (allowed) => ({ mode: "random", value: allowed[0], allowed });
const rows = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: "f" + i,
    role: "all",
    position: count > 1 ? i / (count - 1) : 0,
    raveBehavior: "reactive",
  }));
const config = (extra = {}) =>
  settings({
    recipeOptions: {
      task: option(["reactive", "dim", "steady", "off"]),
      role: option(["all", "low", "mid", "high"]),
      effect: option(Object.keys(plan.EFFECTS)),
      ...extra,
    },
  });
test("joint assignment preserves foreground, spatial group sizes, route limits and pinned jobs", () => {
  for (let seed = 1; seed <= 100; seed++)
    for (const count of [1, 2, 3, 8, 16, 64]) {
      const input = [
        ...rows(count),
        { id: "scene", role: "all", position: 0.5, raveBehavior: "dim", colorSlot: 2 },
      ];
      const original = structuredClone(input);
      const result = plan(input, config(), true, random(seed));
      assert.deepEqual(input, original);
      assert.deepEqual(result.at(-1), original.at(-1));
      assert.deepEqual(
        result.map((f) => f.id),
        input.map((f) => f.id),
      );
      const active = result.filter((f) => f.raveBehavior === "reactive");
      assert.ok(active.length >= Math.ceil(count / 2));
      for (const id of new Set(active.map((f) => f.assignedEffect))) {
        const group = active.filter((f) => f.assignedEffect === id);
        assert.ok(group.length >= plan.EFFECTS[id].minimum);
        const counts = ["all", "low", "mid", "high"].map(
          (role) => group.filter((f) => f.role === role).length,
        );
        if (id === "pulse") assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
        else
          assert.ok(
            group.every((f) => f.role === "all"),
            "travelling groups share one envelope",
          );
      }
    }
});
test("recent assignments rotate even with constant randomness and do not revive removed routes", () => {
  const memory = history();
  let prior;
  for (let i = 0; i < 40; i++) {
    const result = plan(rows(6), config(), true, () => 0.5, memory);
    assert.notDeepEqual(result, prior);
    prior = result;
  }
  assert.equal(memory.recent("fixture-plans").length, 8);
  const changed = plan(rows(2), config(), true, random(6), memory);
  assert.deepEqual(
    changed.map((f) => f.id),
    ["f0", "f1"],
  );
});
test("blocked or incompatible effects are excluded and single-choice intent remains explicit", () => {
  const b = config({ effect: option(["pulse", "wave"]) });
  b.behaviors.attacksEnabled = false;
  for (let seed = 1; seed <= 30; seed++)
    assert.ok(plan(rows(8), b, false, random(seed)).every((f) => f.assignedEffect === "pulse"));
  assert.throws(
    () => plan(rows(1), config({ effect: option(["wave"]) }), false),
    /music_no_fixture_effects/,
  );
  const scene = plan(rows(4), config({ task: option(["dim", "off"]) }), true, random(8));
  assert.ok(scene.every((f) => ["dim", "off"].includes(f.raveBehavior)));
  const manual = plan(rows(4), config(), false, random(9));
  assert.ok(manual.every((f) => f.raveBehavior === "reactive"));
});
test("mixed effect groups render independently from shared audio and freeze into saved effects", () => {
  const design = settings({
    preset: "pulse",
    maximumBrightness: 80,
    palette: ["#ff3300", "#0088ff"],
    behaviors: { loudnessBrightness: false, spatialEnabled: true },
  });
  const fixtures = rows(3).map((f, i) => ({ ...f, assignedEffect: i ? "bounce" : "pulse" }));
  const bank = renderers(createMapper(design), fixtures);
  for (let i = 1; i <= 200; i++)
    bank.update(
      {
        endFrame: i * 960,
        discontinuities: 0,
        rms: 0.1,
        signal: "signal",
        invalidSamples: 0,
        analysis: { valid: true, bandRms: [0.06, 0.04, 0.02], onset: null },
      },
      i * 20,
    );
  const pulse = bank.render(4000, fixtures[0]),
    bounce = bank.render(4000, fixtures[1]);
  assert.notEqual(pulse.brightness, bounce.brightness);
  assert.deepEqual(bank.render(4000, fixtures[0]), pulse, "polling is inert");
  assert.equal(bank.render(4300, fixtures[0]), null);
  const pipeline = { ...bank.inspect(4000), assignments: fixtures };
  assert.deepEqual(
    pipeline.fixtureEffects.map((e) => e.id),
    ["pulse", "bounce"],
  );
  assert.deepEqual(pipeline.effective.palette, design.palette);
  const library = savedEffects();
  const saved = library.save({ name: "Mixed favourite" }, pipeline);
  library.policy({ mode: "single", ids: [saved.id] });
  const replay = library.choose(design, rows(3));
  assert.deepEqual(
    replay.fixtures.map((f) => f.assignedEffect),
    ["pulse", "bounce", "bounce"],
  );
  assert.deepEqual(
    plan(replay.fixtures, replay.design, true, () => 0),
    replay.fixtures,
  );
});

test("palettes can follow effects or fixtures independently and retain exact saved colors", () => {
  const memory = history();
  const design = settings({
    recipeOptions: {
      palette: { mode: "fixed", value: "generated", allowed: ["generated"] },
      effect: option(["pulse", "bounce"]),
      paletteScope: { mode: "fixed", value: "effects", allowed: ["effects"] },
    },
  });
  const source = createMapper(design, { history: memory, random: random(66) });
  const fixtures = recipe.fixtures(
    rows(6),
    source.settings(),
    false,
    random(77),
    memory,
    "generated",
  );
  const groups = new Map();
  for (const f of fixtures) {
    if (groups.has(f.assignedEffect))
      assert.deepEqual(f.assignedPalette, groups.get(f.assignedEffect));
    groups.set(f.assignedEffect, f.assignedPalette);
  }
  assert.equal(groups.size, 2);
  assert.notDeepEqual(...groups.values());
  const bank = renderers(source, fixtures);
  for (let i = 1; i <= 100; i++)
    bank.update(
      {
        endFrame: i * 960,
        discontinuities: 0,
        rms: 0.1,
        signal: "signal",
        invalidSamples: 0,
        analysis: {
          valid: true,
          bandRms: [0.06, 0.04, 0.02],
          onset: i % 10 === 0 ? { id: i, detectedAtFrame: i * 960 } : null,
        },
      },
      i * 20,
    );
  const a = fixtures[0],
    b = {
      ...a,
      assignedPalette: fixtures.find((f) => f.assignedEffect !== a.assignedEffect).assignedPalette,
    };
  assert.equal(
    bank.render(2000, a).brightness,
    bank.render(2000, b).brightness,
    "palette selection cannot change brightness",
  );
  assert.notDeepEqual(bank.render(2000, a).rgb, bank.render(2000, b).rgb);
  const library = savedEffects();
  const saved = library.save(
    { name: "Group colors" },
    { ...bank.inspect(2000), assignments: fixtures },
  );
  library.policy({ mode: "single", ids: [saved.id] });
  assert.deepEqual(
    library.choose(design, rows(6)).fixtures.map((f) => f.assignedPalette),
    fixtures.map((f) => f.assignedPalette),
  );
  const individual = settings({
    recipeOptions: {
      palette: design.recipeOptions.palette,
      paletteScope: { mode: "fixed", value: "fixtures", allowed: ["fixtures"] },
    },
  });
  const assigned = recipe.fixtures(rows(64), individual, false, random(88), memory, "generated");
  const palettes = new Set(assigned.map((f) => JSON.stringify(f.assignedPalette)));
  assert.equal(palettes.size, 8, "large rooms reuse bounded palette families");
  assert.ok(
    assigned.every((f) => !f.assignedEffect),
    "palette scope does not enable mixed effects",
  );
});

test("manual palette assignments only use selected colors and shared mode stays compatible", () => {
  const design = settings({
    palette: ["#ff3300", "#0088ff", "#44ff00"],
    recipeOptions: {
      paletteScope: { mode: "fixed", value: "fixtures", allowed: ["fixtures"] },
    },
  });
  const assigned = recipe.fixtures(rows(4), design, false, random(19), history());
  assert.ok(assigned.every((f) => f.assignedPalette.every((c) => design.palette.includes(c))));
  const deterministic = recipe.fixtures(rows(4), design, false, () => 0.5, history());
  assert.equal(new Set(deterministic.map((f) => [...f.assignedPalette].sort().join(","))).size, 4);
  assert.ok(recipe.fixtures(rows(4), settings(), false).every((f) => !f.assignedPalette));
});
