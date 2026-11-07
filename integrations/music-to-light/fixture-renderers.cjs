/** One measured stream, bounded effect groups, one writer per routed fixture.
 * Groups share the resolved palette/reference but have independent envelopes.
 */
const createMapper = require("./mapper.cjs");
const crypto = require("node:crypto");
const { EFFECTS, compatible } = require("./fixture-planner.cjs");
function groupDesign(config, id) {
  const effect = EFFECTS[id];
  const direct = config.interpretation === "literal";
  return {
    ...config,
    behaviors: { ...config.behaviors, profilePaletteEnabled: false },
    preset: effect.preset,
    scenarioMode: "manual",
    layerMode: "fixed",
    ...(direct && id === "handoff" ? { arrangement: "spatial" } : {}),
    ...(direct
      ? { colorMode: { pulse: "onsets", wave: "roles", bounce: "energy", handoff: "travel" }[id] }
      : {}),
    parameterRanges: {},
    recipeOptions: {
      shape: {
        mode: "fixed",
        value: direct ? "unison" : effect.shape,
        allowed: [direct ? "unison" : effect.shape],
      },
      ...(config.recipeOptions.role ? { role: config.recipeOptions.role } : {}),
    },
  };
}
module.exports = function renderers(base, fixtures) {
  const config = base.inspect(0).effective;
  const palettes = fixtures.map((f) => f.assignedPalette).filter(Boolean);
  base.setPalettes(palettes);
  const groups = new Map();
  const layouts = new Map();
  for (const f of fixtures)
    if (f.assignedEffect && f.raveBehavior === "reactive" && !groups.has(f.assignedEffect)) {
      if (!EFFECTS[f.assignedEffect]) throw Error("invalid_music_fixture_effect");
      groups.set(f.assignedEffect, createMapper(groupDesign(config, f.assignedEffect)));
    }
  for (const [id, mapper] of groups) {
    const positions = fixtures
      .filter((f) => f.raveBehavior === "reactive" && f.assignedEffect === id)
      .map((f) => f.position);
    if (
      !compatible(
        id,
        positions.length,
        config,
        positions.map((position) => ({ position })),
      )
    )
      throw Object.assign(Error("music_no_fixture_effects"), { code: "music_no_fixture_effects" });
    const left = Math.min(...positions),
      span = Math.max(...positions) - left;
    layouts.set(id, { left, span });
    mapper.setPositions(positions.map((p) => (span ? (p - left) / span : 0)));
    mapper.setPalettes(palettes);
  }
  if (!groups.size && !palettes.length) return base;
  const recipeId = crypto.randomBytes(6).toString("hex");
  return Object.freeze({
    settings: () => base.settings(),
    preset: () => base.preset(),
    setPositions: (values) => base.setPositions(values),
    update(event, at) {
      base.update(event, at);
      for (const mapper of groups.values()) mapper.update(event, at);
    },
    render(at, fixture = {}) {
      const group = groups.get(fixture.assignedEffect);
      if (!group) return base.render(at, fixture);
      const layout = layouts.get(fixture.assignedEffect);
      return group.render(at, {
        ...fixture,
        position: layout.span ? (fixture.position - layout.left) / layout.span : 0,
      });
    },
    inspect(at) {
      const main = base.inspect(at);
      const effects = [...groups].map(([id, m]) => ({ id, ...m.inspect(at) }));
      const metrics = effects.map((e) => e.metrics).filter(Boolean);
      if (main.metrics && metrics.length)
        for (const key of ["level", "rise", "spread", "attackStrength", "energyRise"])
          if (metrics.some((m) => Number.isFinite(m[key])))
            main.metrics[key] = Math.max(
              main.metrics[key] || 0,
              ...metrics.map((m) => m[key] || 0),
            );
      if (main.metrics) main.metrics.attack = main.metrics.attack || metrics.some((m) => m.attack);
      if (main.metrics)
        main.metrics.attackAt = Math.max(
          main.metrics.attackAt ?? -Infinity,
          ...metrics.map((m) => m.attackAt ?? -Infinity),
        );
      if (main.metrics && !Number.isFinite(main.metrics.attackAt)) main.metrics.attackAt = null;
      if (main.metrics)
        for (const key of ["colorMotion", "brightnessMotion", "spatialMotion"])
          main.metrics[key] = main.metrics[key] || metrics.some((m) => m[key]);
      main.fixtureEffects = effects.map(({ id, preset, recipe, metrics }) => ({
        id,
        preset,
        shape: recipe.shape,
        metrics,
      }));
      for (const layer of main.layers) {
        const active = effects.some((e) => e.layers.some((l) => l.id === layer.id && l.active));
        if (active) {
          layer.active = true;
          layer.selected = true;
          layer.reason = "Active in assigned fixture effects";
        }
      }
      main.recipeLocked = true;
      main.recipeId ||= recipeId;
      return main;
    },
    configure(input) {
      const result = base.configure(input);
      for (const [id, mapper] of groups) mapper.configure(groupDesign(result, id));
      return result;
    },
  });
};
