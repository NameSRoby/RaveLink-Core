const test = require("node:test"),
  assert = require("node:assert/strict");
const mapper = require("../mapper.cjs"),
  settings = require("../mapping-settings.cjs").settings;
const history = require("../recipe-history.cjs");
const recipe = require("../recipe.cjs"),
  bank = require("../fixture-renderers.cjs");
const mix = require("../looks.cjs").find((l) => l.id === "rave-mix").design;
const option = (allowed) => ({ mode: "random", value: allowed[0], allowed });
const fixtures = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: "f" + i,
    role: "all",
    raveBehavior: "reactive",
    brand: "wiz",
    position: n > 1 ? i / (n - 1) : 0,
  }));
const event = (i) => ({
  endFrame: i * 960,
  rms: 0.06,
  signal: "signal",
  invalidSamples: 0,
  discontinuities: 0,
  analysis: {
    valid: true,
    bandRms: [0.04, 0.02, 0.01],
    onset: i % 12 === 0 ? { id: i, detectedAtFrame: i * 960 } : null,
  },
});

test("a pinned color narrows random movement to a compatible composition", () => {
  for (let seed = 0; seed < 20; seed++) {
    const m = mapper(
      {
        recipeOptions: {
          shape: option(["wave", "swell"]),
          color: { mode: "fixed", value: "travel", allowed: ["travel"] },
        },
      },
      { random: () => seed / 20, fixtures: fixtures(4) },
    );
    assert.equal(m.inspect(0).recipe.shape, "swell");
    assert.throws(
      () =>
        mapper({
          recipeOptions: {
            shape: { mode: "fixed", value: "wave", allowed: ["wave"] },
            color: { mode: "fixed", value: "travel", allowed: ["travel"] },
            feel: option(["normal", "fast"]),
          },
        }),
      /music_no_compatible_recipes/,
    );
  }
});

test("constant randomness rotates whole compositions rather than alternating stale pairs", () => {
  const memory = history(),
    chosen = [];
  for (let i = 0; i < 80; i++) {
    const m = mapper(mix, { history: memory, random: () => 0, fixtures: fixtures(6) });
    const initial = m.inspect(0).recipe;
    for (let frame = 1; frame <= 20; frame++) m.update(event(frame), frame * 20);
    assert.deepEqual(m.inspect(400).recipe, initial);
    chosen.push(initial);
  }
  assert.equal(new Set(chosen.map((r) => r.shape)).size, 6);
  assert.ok(chosen.every((row, i) => !i || JSON.stringify(row) !== JSON.stringify(chosen[i - 1])));
  assert.ok(new Set(chosen.map((r) => [r.shape, r.color, r.feel].join(":"))).size >= 8);
  assert.ok(
    chosen.every((r) => r.feel === "normal"),
    "Smart random retains the reference response timing",
  );
});

test("one light and slow shared REST transport exclude unreadable spatial choices", () => {
  const single = fixtures(1);
  for (let i = 0; i < 25; i++) {
    const m = mapper(mix, { fixtures: single, random: () => i / 25 });
    assert.equal(m.inspect(0).recipe.shape, "unison");
    assert.ok(!["travel", "roles"].includes(m.inspect(0).recipe.color));
  }
  const slow = fixtures(32).map((f) => ({ ...f, brand: "hue", entertainmentActive: false }));
  assert.equal(mapper(mix, { fixtures: slow }).inspect(0).recipe.shape, "unison");
});

test("a spatial group uses its full local span and one audio envelope", () => {
  const design = settings({
    colorMode: "fixed",
    behaviors: { pulseBed: 1, loudnessBrightness: false },
    recipeOptions: {
      effect: { mode: "fixed", value: "handoff", allowed: ["handoff"] },
      role: option(["all", "low", "mid", "high"]),
    },
  });
  const routes = fixtures(2).map((f, i) => ({ ...f, position: 0.2 + i * 0.2 }));
  const base = mapper(design, { fixtures: routes });
  const assignments = recipe.fixtures(routes, base.settings(), false, () => 0);
  assert.ok(assignments.every((f) => f.role === "all"));
  const rendered = bank(base, assignments);
  const full = bank(
    mapper(design),
    assignments.map((f, i) => ({ ...f, position: i })),
  );
  for (let i = 1; i <= 70; i++) {
    rendered.update(event(i), i * 20);
    full.update(event(i), i * 20);
  }
  assignments.forEach((f, i) =>
    assert.deepEqual(rendered.render(1400, f), full.render(1400, { ...f, position: i })),
  );
});

test("configured Entertainment rooms are planned at their stream rate before verified preheat", async () => {
  const routes = fixtures(32).map((f) => ({ ...f, brand: "hue" }));
  const session = require("../session.cjs")({
    settings: {
      ...mix,
      outputHz: 16,
      recipeOptions: {
        shape: option(["wave"]),
        color: { mode: "fixed", value: "onsets", allowed: ["onsets"] },
        feel: { mode: "fixed", value: "normal", allowed: ["normal"] },
      },
    },
    output: {
      fixtures: routes,
      planFixtures: (rows) => rows.map((f) => ({ ...f, entertainmentActive: true })),
      prepare: async () => ({ ok: true, activeIds: routes.map((f) => f.id) }),
      ownership: Object.fromEntries(
        ["acquire", "write", "release", "releaseOwner", "has"].map((method) => [
          method,
          () => {
            throw Error("no I/O before Start");
          },
        ]),
      ),
    },
  });
  assert.equal(session.inspect().recipe.shape, "wave");
  assert.equal(session.snapshot().state, "idle");
  await session.stop();
});
