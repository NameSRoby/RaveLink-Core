/** A composition has one leading movement. Random axes are filtered together,
 * before audio or fixture ownership exists. Manual designs retain their intent.
 */
const combinations = Object.freeze({
  unison: {
    colors: ["fixed", "onsets", "energy", "roles", "travel"],
    feels: ["slow", "normal", "fast", "aggressive"],
  },
  wave: { colors: ["fixed", "onsets"], feels: ["slow", "normal", "fast"] },
  bounce: { colors: ["fixed", "onsets", "roles"], feels: ["normal", "fast"] },
  handoff: { colors: ["fixed", "onsets"], feels: ["slow", "normal"] },
  swell: { colors: ["fixed", "travel", "energy"], feels: ["slow", "normal"] },
  mirror: { colors: ["fixed", "onsets", "energy"], feels: ["slow", "normal"] },
});
const fault = (code) => Object.assign(Error(code), { code });
const motion = { slow: 0.6, normal: 1, fast: 1.5, aggressive: 2 };
function pool(config, axis, inherited) {
  const option = config.recipeOptions[axis];
  if (!option || option.mode === "configured") return [inherited];
  if (!option.allowed.length) throw fault("music_no_recipe_choices");
  return option.mode === "fixed" ? [option.value] : option.allowed;
}
function spatial(shape, config, fixtures) {
  if (shape === "unison") return true;
  if (
    config.interpretation !== "musical" ||
    !config.behaviors.spatialEnabled ||
    config.behaviors.steadyBrightness
  )
    return false;
  if (["wave", "handoff"].includes(shape) && !config.behaviors.attacksEnabled) return false;
  if (!fixtures) return true;
  const active = fixtures.filter((f) => !f.raveBehavior || f.raveBehavior === "reactive");
  return active.length >= 2 && new Set(active.map((f) => f.position)).size >= 2;
}
function parameterActive(id, shapes, color, b) {
  const has = (...ids) => shapes.some((s) => ids.includes(s));
  if (id.startsWith("wave"))
    return id === "waveWidth" ? has("wave", "bounce", "mirror") : has("wave");
  if (id.startsWith("handoff")) return has("handoff");
  if (id.startsWith("swell") && id !== "swellsEnabled") return has("swell");
  if (id === "bounceSeconds") return has("bounce", "mirror");
  if (id === "interactionDepth") return has("bounce", "mirror", "handoff");
  if (id === "spatialAccentShare")
    return (
      b.expressiveEnabled &&
      b.smoothShapesEnabled &&
      has("wave", "bounce", "mirror", "handoff", "swell")
    );
  if (id.startsWith("literal")) return false;
  if (["referenceMs", "riseGain", "riseDecayMs"].includes(id)) return false;
  if (id.startsWith("body") || ["accentDepth", "impactDepth"].includes(id))
    return b.loudnessBrightness && !b.steadyBrightness;
  if (id === "pulseBed" || id === "pulseDecayMs") return b.attacksEnabled && !b.steadyBrightness;
  if (id.startsWith("color"))
    return b.colorEnabled && (id !== "colorBlendMs" || color === "onsets");
  if (["midTrimDb", "highTrimDb"].includes(id)) return b.balanceEnabled;
  return true;
}
function interval(config, fixtures) {
  const rows = fixtures?.filter((f) => !f.raveBehavior || f.raveBehavior === "reactive") || [];
  const hueCount = rows.filter((f) => f.brand === "hue" && !f.entertainmentActive).length;
  return (
    1000 /
    Math.min(
      config.outputHz,
      hueCount ? 8 / hueCount : config.outputHz,
      rows.some((f) => f.brand === "govee") ? 8 : config.outputHz,
    )
  );
}
function timingValid(shape, config, fixtures) {
  const b = config.behaviors,
    tick = interval(config, fixtures),
    speed = motion[config.feel];
  if (shape === "wave") return b.waveMs / speed >= tick * 2;
  if (shape === "handoff") return b.handoffMs >= tick;
  if (["bounce", "mirror"].includes(shape)) return (b.bounceSeconds * 1000) / speed >= tick * 4;
  if (shape === "swell") return (b.swellTravelSeconds * 1000) / speed >= tick * 4;
  return true;
}
function bounds(id, shape, feel, config, fixtures) {
  const stepMs = interval(config, fixtures);
  const speed = motion[feel];
  const values = {
    waveMs: [Math.max(600, stepMs * speed * 2), 1800],
    waveVoices: [2, 4],
    waveWidth: [0.35, 0.7],
    waveDepth: [0.5, 0.9],
    interactionDepth: [0.5, 0.9],
    handoffMs: [Math.max(250, stepMs * 1.5), 700],
    handoffHits: [2, 4],
    bounceSeconds: [Math.max(1.5, (stepMs / 1000) * speed * 4), 4],
    swellTravelSeconds: [3, 8],
    swellSpan: [0.4, 0.85],
    swellDepth: [0.5, 0.85],
    spatialAccentShare: [0, 0.15],
    pulseDecayMs:
      feel === "slow"
        ? [180, 500]
        : feel === "fast" || feel === "aggressive"
          ? [100, 350]
          : [140, 450],
    colorBlendMs: [250, feel === "fast" || feel === "aggressive" ? 450 : 650],
    smoothing: [0, 0.4],
  };
  return values[id] || [-Infinity, Infinity];
}
function parameterRange(id, range, shape, feel, config, fixtures) {
  const [minimum, maximum] = bounds(id, shape, feel, config, fixtures);
  const field = require("./behavior-settings.cjs").catalog.find((f) => f.id === id);
  const low = Math.max(range.min, minimum),
    high = Math.min(range.max, maximum);
  return {
    min: Number(
      (field.min + Math.ceil((low - field.min) / field.step - 1e-8) * field.step).toFixed(6),
    ),
    max: Number(
      (field.min + Math.floor((high - field.min) / field.step + 1e-8) * field.step).toFixed(6),
    ),
  };
}
function mixed(config) {
  return config.recipeOptions.effect && config.recipeOptions.effect.mode !== "configured";
}
function candidates(config, inherited, fixtures) {
  const b = config.behaviors;
  const grouped = mixed(config);
  const shapes = grouped ? ["unison"] : pool(config, "shape", inherited);
  const colors =
    !b.colorEnabled || config.warmCoolColors
      ? [
          config.recipeOptions.color?.mode === "fixed"
            ? config.recipeOptions.color.value
            : config.colorMode,
        ]
      : grouped && (!config.recipeOptions.color || config.recipeOptions.color.mode === "configured")
        ? [["fixed", "onsets"].includes(config.colorMode) ? config.colorMode : "fixed"]
        : pool(config, "color", config.colorMode);
  const feels =
    grouped && (!config.recipeOptions.feel || config.recipeOptions.feel.mode === "configured")
      ? ["normal"]
      : pool(config, "feel", config.feel);
  const random =
    ["shape", "color", "feel"].some((id) => config.recipeOptions[id]?.mode === "random") ||
    Object.keys(config.parameterRanges).length > 0 ||
    grouped;
  if (!random) return [{ shape: shapes[0], color: colors[0], feel: feels[0] }];
  const result = [];
  for (const shape of shapes)
    for (const color of colors)
      for (const feel of feels) {
        const rule = combinations[shape];
        if (!spatial(shape, config, fixtures)) continue;
        if (!rule.feels.includes(feel)) continue;
        if (grouped && feel !== "normal") continue;
        if (b.colorEnabled && !config.warmCoolColors && !rule.colors.includes(color)) continue;
        if (
          grouped &&
          b.colorEnabled &&
          !config.warmCoolColors &&
          !["fixed", "onsets"].includes(color)
        )
          continue;
        if (!b.attacksEnabled && color === "onsets" && b.colorEnabled && !config.warmCoolColors)
          continue;
        if (config.recipeOptions.paletteScope?.value === "fixtures" && color === "travel") continue;
        if (
          fixtures &&
          fixtures.filter((f) => !f.raveBehavior || f.raveBehavior === "reactive").length < 2 &&
          ["roles", "travel"].includes(color) &&
          b.colorEnabled &&
          !config.warmCoolColors
        )
          continue;
        const timingField = {
          wave: "waveMs",
          handoff: "handoffMs",
          bounce: "bounceSeconds",
          mirror: "bounceSeconds",
          swell: "swellTravelSeconds",
        }[shape];
        if (
          !grouped &&
          !config.parameterRanges[timingField] &&
          !timingValid(shape, { ...config, feel }, fixtures)
        )
          continue;
        if (
          Object.entries(config.parameterRanges).some(([id, range]) => {
            if (!parameterActive(id, grouped ? ["wave", "bounce", "handoff"] : [shape], color, b))
              return false;
            const adjusted = parameterRange(id, range, shape, feel, config, fixtures);
            return (
              adjusted.min > adjusted.max &&
              !(grouped && /^(wave|handoff|bounce|interaction)/.test(id))
            );
          })
        )
          continue;
        result.push({ shape, color, feel });
      }
  return result;
}
function choose(config, inherited, random, history, fixtures) {
  const rows = candidates(config, inherited, fixtures);
  if (!rows.length) throw fault("music_no_compatible_recipes");
  if (rows.length === 1) return rows[0];
  const prior = history?.recent("compositions") || [];
  const key = (r) => [r.shape, r.color, r.feel].join(":");
  const last = prior.at(-1);
  const allowed = rows.length > 1 ? rows.filter((r) => key(r) !== last) : rows;
  const scored = allowed.map((r) => ({
    row: r,
    weight:
      1 /
      (1 +
        prior.reduce((sum, old, i) => {
          const [shape, color, feel] = old.split(":");
          return (
            sum +
            (((shape === r.shape ? 3 : 0) +
              (color === r.color ? 1 : 0) +
              (feel === r.feel ? 0.25 : 0)) *
              (i + 1)) /
              prior.length
          );
        }, 0)),
  }));
  const best = Math.max(...scored.map((r) => r.weight));
  // Recent similarity is a constraint before the draw. Otherwise a constant
  // RNG can alternate the first two tuples forever despite novelty weights.
  const weighted = scored.filter((r) => r.weight >= best * 0.9);
  const roll = random();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw fault("invalid_music_random");
  let cursor = roll * weighted.reduce((sum, row) => sum + row.weight, 0);
  let chosen = weighted.at(-1).row;
  for (const row of weighted) {
    cursor -= row.weight;
    if (cursor < 0) {
      chosen = row.row;
      break;
    }
  }
  history?.remember("compositions", key(chosen));
  return chosen;
}
function validate(config) {
  const shapes =
    config.scenarioMode === "random" &&
    (!config.recipeOptions.shape || config.recipeOptions.shape.mode === "configured")
      ? Object.entries(config.scenarioWeights)
          .filter(([, weight]) => weight > 0)
          .map(([id]) => (id === "pulse" ? "unison" : id))
      : ["unison"];
  if (shapes.length && !shapes.some((shape) => candidates(config, shape).length))
    throw fault("music_no_compatible_recipes");
}
module.exports = {
  combinations,
  candidates,
  choose,
  validate,
  mixed,
  spatial,
  pool,
  parameterActive,
  parameterRange,
  timingValid,
};
