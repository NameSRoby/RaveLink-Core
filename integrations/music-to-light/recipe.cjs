/** Independent activation-time recipe axes. This module performs no I/O. One
 * draw per enabled axis (or per fixture for task/role), never a draw per frame.
 * Saved ranges are artistic choices; brightness ceilings, grants and transport
 * budgets cannot be randomized through this catalog.
 */
const { catalog: behaviors } = require("./behavior-settings.cjs");
const looks = require("./looks.cjs");
const axes = [
  {
    id: "shape",
    label: "Spatial interaction",
    choices: ["unison", "wave", "bounce", "handoff", "swell", "mirror"],
  },
  {
    id: "color",
    label: "Color movement",
    choices: ["fixed", "onsets", "travel", "energy", "roles"],
  },
  {
    id: "palette",
    label: "Palette",
    choices: [
      "configured",
      "generated",
      "electric-pulse",
      "ember-pulse",
      "aurora-swell",
      "prism-bands",
    ],
  },
  { id: "feel", label: "Response feel", choices: ["slow", "normal", "fast", "aggressive"] },
  {
    id: "task",
    label: "Per-fixture task · Rave only",
    choices: ["reactive", "dim", "steady", "off"],
  },
  { id: "role", label: "Per-fixture frequency role", choices: ["all", "low", "mid", "high"] },
];
const fault = (code) => Object.assign(Error(code), { code });
function options(input = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !axes.some((a) => a.id === k))
  )
    throw fault("invalid_music_recipe_options");
  const result = {};
  for (const axis of axes) {
    if (!Object.hasOwn(input, axis.id)) continue;
    const row = input[axis.id];
    if (
      !row ||
      Object.keys(row).some((k) => !["mode", "value", "allowed"].includes(k)) ||
      !["configured", "fixed", "random"].includes(row.mode) ||
      !axis.choices.includes(row.value) ||
      !Array.isArray(row.allowed) ||
      new Set(row.allowed).size !== row.allowed.length ||
      row.allowed.some((c) => !axis.choices.includes(c)) ||
      (row.mode === "fixed" && !row.allowed.includes(row.value))
    )
      throw fault("invalid_music_recipe_options");
    result[axis.id] = { mode: row.mode, value: row.value, allowed: [...row.allowed] };
  }
  return result;
}
function ranges(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw fault("invalid_music_parameter_ranges");
  const result = {};
  for (const [id, range] of Object.entries(input)) {
    const f = behaviors.find((f) => f.id === id && f.type === "number" && f.stage !== "output");
    if (
      !f ||
      !range ||
      Object.keys(range).length !== 2 ||
      !Number.isFinite(range.min) ||
      !Number.isFinite(range.max) ||
      range.min < f.min ||
      range.max > f.max ||
      range.min > range.max ||
      Math.ceil((range.min - f.min) / f.step - 1e-8) >
        Math.floor((range.max - f.min) / f.step + 1e-8)
    )
      throw fault("invalid_music_parameter_ranges");
    result[id] = { min: range.min, max: range.max };
  }
  return result;
}
function pick(axis, configured, config, random, history = null, key = axis) {
  const option = config.recipeOptions[axis];
  if (!option || option.mode === "configured") return configured;
  if (!option.allowed.length) throw fault("music_no_recipe_choices");
  if (option.mode === "fixed") return option.value;
  if (history)
    return history.draw(
      key,
      option.allowed.map((id) => ({ id, weight: 1 })),
      random,
    ).id;
  const roll = random();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw fault("invalid_music_random");
  return option.allowed[Math.floor(roll * option.allowed.length)];
}
function resolve(config, scenario, random, history = null) {
  const inherited =
    { wave: "wave", bounce: "bounce", handoff: "handoff", wash: "swell" }[scenario] ||
    (config.preset === "ambient" && config.arrangement === "spatial" ? "swell" : "unison");
  const shape = pick("shape", inherited, config, random, history);
  config.colorMode = pick("color", config.colorMode, config, random, history);
  config.feel = pick("feel", config.feel, config, random, history);
  const palette = pick("palette", "configured", config, random, history);
  if (palette === "generated") config.palette = require("./random-palette.cjs")(random);
  else if (palette !== "configured")
    config.palette = [...looks.find((l) => l.id === palette).design.palette];
  const parameters = {};
  for (const [id, range] of Object.entries(config.parameterRanges)) {
    const roll = random();
    if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw fault("invalid_music_random");
    const f = behaviors.find((f) => f.id === id);
    const first = Math.ceil((range.min - f.min) / f.step - 1e-8),
      last = Math.floor((range.max - f.min) / f.step + 1e-8);
    const value = f.min + (first + Math.floor(roll * (last - first + 1))) * f.step;
    config.behaviors[id] = parameters[id] = Number(value.toFixed(6));
  }
  return { shape, color: config.colorMode, palette, feel: config.feel, parameters };
}
function fixtures(rows, config, effect, random = Math.random, history = null) {
  return rows.map((row) => ({
    ...row,
    role: pick("role", row.role, config, random, history, "role:" + (row.id || row.position)),
    raveBehavior:
      effect && (!row.raveBehavior || row.raveBehavior === "reactive")
        ? pick(
            "task",
            row.raveBehavior || "reactive",
            config,
            random,
            history,
            "task:" + (row.id || row.position),
          )
        : row.raveBehavior || "reactive",
  }));
}
module.exports = { axes, options, ranges, resolve, fixtures };
