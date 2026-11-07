const test = require("node:test");
const assert = require("node:assert/strict");
const profiles = require("../effect-profiles.cjs");
const create = require("../mapper.cjs");
const wrap = require("../profile-renderer.cjs");
const bank = require("../fixture-renderers.cjs");
const baseline = require("../profiles/accepted-color-led-v1.json");
const { settings } = require("../mapping-settings.cjs");
const shuffle = require("../random-profile.cjs");
function event(i, hits = true, rms = 0.07) {
  return {
    endFrame: i * 960,
    discontinuities: 0,
    rms,
    signal: rms ? "signal" : "silent",
    invalidSamples: 0,
    analysis: {
      valid: true,
      bandRms:
        i % 40 < 20 ? [rms * 0.8, rms * 0.2, rms * 0.04] : [rms * 0.1, rms * 0.65, rms * 0.4],
      onset: hits && i % 10 === 1 ? { id: i, detectedAtFrame: i * 960, strength: 1.2 } : null,
      onsetThreshold: 1,
    },
  };
}
const routes = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: "test-" + i,
    role: "all",
    brand: "wiz",
    position: i / Math.max(1, count - 1),
    raveBehavior: "reactive",
  }));
const design = (p, extra = {}) =>
  settings({
    ...baseline,
    minimumBrightness: 10,
    maximumBrightness: 100,
    ...extra,
    behaviors: {
      ...baseline.behaviors,
      ...p.behaviors,
      profilePaletteEnabled: true,
      ...extra.behaviors,
    },
  });
test("ten genuinely different room sequences share the exact reference response", () => {
  assert.equal(profiles.length, 10);
  assert.equal(new Set(profiles.map((p) => p.palette.join())).size, 10);
  const fixtures = routes(5),
    signatures = [];
  for (const p of profiles) {
    const config = design(p),
      base = create(config),
      renderer = wrap(bank(base, fixtures), fixtures);
    const reference = create(config),
      samples = [];
    for (let i = 1; i <= 420; i++) {
      const at = i * 20,
        input = event(i);
      renderer.update(input, at);
      reference.update(input, at);
      if (i % 5) continue;
      const frames = fixtures.map((f) => renderer.render(at, f));
      assert.deepEqual(
        frames,
        fixtures.map((f) => renderer.render(at, f)),
        "polling cannot advance choreography",
      );
      for (const f of frames) {
        assert(
          f.brightness >= config.minimumBrightness && f.brightness <= config.maximumBrightness,
        );
        assert(
          f.brightness <= reference.render(at).brightness + 1e-9,
          "profiles cannot invent brightness impacts",
        );
        assert(Object.values(f.rgb).every((v) => Number.isFinite(v) && v >= 0 && v <= 255));
      }
      if (!p.value) assert.deepEqual(frames[0], reference.render(at, fixtures[0]));
      samples.push(frames.map((f) => [Math.round(f.brightness), ...Object.values(f.rgb)]));
    }
    signatures.push(JSON.stringify(samples));
  }
  assert.equal(new Set(signatures).size, 10);
});
test("each profile works with one light, missing bands, scene jobs and custom palettes", () => {
  for (const p of profiles) {
    const fixtures = [...routes(1), { id: "scene", position: 1, raveBehavior: "off", role: "all" }];
    const custom = ["#ff8800", "#0044ff"];
    const config = design(p, { palette: custom, behaviors: { profilePaletteEnabled: false } });
    const base = create(config),
      renderer = wrap(base, fixtures);
    for (let i = 1; i <= 20; i++) {
      const input = event(i);
      delete input.analysis;
      renderer.update(input, i * 20);
      assert.deepEqual(renderer.render(i * 20, fixtures[0]), base.render(i * 20, fixtures[0]));
      assert.deepEqual(renderer.render(i * 20, fixtures[1]), base.render(i * 20, fixtures[1]));
    }
    assert.deepEqual(renderer.inspect(400).effective.palette, custom);
  }
});
test("profile colors and generated colors resolve without overwriting the user's palette", () => {
  for (const p of profiles) {
    const config = design(p, { palette: ["#ffee00", "#1100ff"] });
    assert.deepEqual(create(config).inspect(0).effective.palette, p.palette);
    const random = create(
      {
        ...config,
        recipeOptions: { palette: { mode: "random", value: "generated", allowed: ["generated"] } },
      },
      { random: () => 0.37 },
    );
    assert.equal(random.inspect(0).recipe.palette, "generated");
    assert.notDeepEqual(random.inspect(0).effective.palette, p.palette);
    assert.deepEqual(config.palette, ["#ffee00", "#1100ff"]);
  }
});
test("profile shuffle visits all ten before repeating and preserves palette independence", () => {
  const history = require("../recipe-history.cjs")();
  const input = design(profiles[0], {
    behaviors: { randomProfileEnabled: true },
    recipeOptions: { palette: { mode: "random", value: "generated", allowed: ["generated"] } },
  });
  const picks = Array.from({ length: 30 }, () => shuffle(input, history, () => 0.37));
  for (let i = 0; i < picks.length; i += 10)
    assert.equal(new Set(picks.slice(i, i + 10).map((c) => c.behaviors.profileMotion)).size, 10);
  assert(
    picks.every((c, i) => !i || c.behaviors.profileMotion !== picks[i - 1].behaviors.profileMotion),
  );
  assert(picks.every((c) => !c.behaviors.randomProfileEnabled));
  assert.deepEqual(picks[3].recipeOptions.palette, input.recipeOptions.palette);
  assert.equal(input.behaviors.randomProfileEnabled, true);
});
test("silence cannot keep moving a relay and saved effects freeze the resolved profile", () => {
  const fixtures = routes(4),
    config = design(profiles[2]);
  const renderer = wrap(create(config), fixtures);
  renderer.update(event(1), 20);
  for (let i = 2; i <= 200; i++) renderer.update(event(i, false, 0), i * 20);
  assert(fixtures.every((f) => renderer.render(4000, f).brightness <= 10.001));
  const snapshot = renderer.inspect(4000);
  const saved = require("../saved-effects.cjs").freezeCurrent(snapshot);
  assert.equal(saved.behaviors.profileMotion, 2);
  assert.equal(saved.behaviors.profilePaletteEnabled, false);
  assert.equal(saved.behaviors.randomProfileEnabled, false);
  assert.deepEqual(saved.palette, profiles[2].palette);
});
