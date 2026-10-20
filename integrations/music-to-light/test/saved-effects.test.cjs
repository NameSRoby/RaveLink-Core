const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const create = require("../saved-effects.cjs"),
  mapper = require("../mapper.cjs");
const { settings } = require("../mapping-settings.cjs");
function current() {
  const m = mapper(
    {
      ...require("../looks.cjs").find((l) => l.id === "expressive-mix").design,
      maximumBrightness: 100,
    },
    { random: () => 0.4 },
  );
  return {
    ...m.inspect(0),
    assignments: [{ id: "lamp.1", role: "low", raveBehavior: "reactive" }],
  };
}
test("saving resolves the actual random combination and keeps it deterministic across replays", () => {
  const library = create(),
    original = current();
  const saved = library.save({ name: "Favourite" }, original, { openingStyle: 2, endingStyle: 1 });
  library.policy({ mode: "single", ids: [saved.id] });
  const base = settings({
    floorDb: -50,
    ceilingDb: -26,
    maximumBrightness: 40,
    intensity: 0.4,
    outputHz: 16,
  });
  const a = library.choose(base, [{ id: "lamp.1", brand: "hue", role: "all", position: 0 }]);
  assert.equal(a.design.floorDb, -50);
  assert.equal(a.design.ceilingDb, -26);
  assert.equal(a.design.maximumBrightness, 40);
  assert.equal(a.design.intensity, 0.4);
  assert.equal(a.design.outputHz, 16);
  assert.equal(a.design.behaviors.openingStyle, 2);
  assert.equal(a.fixtures[0].role, "low");
  const b = mapper(a.design, { random: () => 0.99 }),
    c = mapper(a.design, { random: () => 0.01 });
  assert.equal(b.inspect(0).recipe.shape, original.recipe.shape);
  assert.deepEqual(b.inspect(0).effective, c.inspect(0).effective);
  assert.deepEqual(
    b.inspect(0).effective.behaviors,
    original.effective.behaviors.openingStyle === 2
      ? original.effective.behaviors
      : { ...original.effective.behaviors, openingStyle: 2, endingStyle: 1 },
  );
});
test("saved random selects only its allowed pool without consecutive repeats; full random keeps the original design", () => {
  const lib = create({ random: () => 0 }),
    p = ["one", "two", "excluded"].map((name) => lib.save({ name }, current()));
  lib.policy({ mode: "saved-random", ids: p.slice(0, 2).map((x) => x.id) });
  const picks = Array.from({ length: 12 }, () => lib.choose(settings(), []).profile.id);
  assert.ok(picks.every((id) => id !== p[2].id));
  assert.ok(picks.every((id, i) => !i || id !== picks[i - 1]));
  lib.policy({ mode: "full-random", ids: [] });
  const base = settings();
  assert.equal(lib.choose(base, []).design, base);
  assert.throws(() => lib.policy({ mode: "saved-random", ids: [] }), /invalid_music_effect_policy/);
  assert.throws(
    () => lib.policy({ mode: "single", ids: [p[0].id, p[1].id] }),
    /invalid_music_effect_policy/,
  );
});
test("saved combinations persist atomically; in-use deletion and corrupt restrictions fail closed", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saved-effects-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, "effects.json");
  const lib = create({ storePath }),
    p = lib.save({ name: "Saved" }, current());
  lib.policy({ mode: "single", ids: [p.id] });
  assert.equal(create({ storePath }).choose(settings(), []).profile.name, "Saved");
  assert.throws(() => lib.remove(p.id), /music_effect_profile_in_use/);
  fs.writeFileSync(storePath, "bad");
  const broken = create({ storePath });
  assert.equal(broken.snapshot().recovered, true);
  assert.throws(() => broken.choose(settings(), []), /music_effect_library_unavailable/);
  broken.policy({ mode: "full-random", ids: [] });
  assert.equal(broken.choose(settings(), []).profile, null);
});
