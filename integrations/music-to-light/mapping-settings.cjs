/** Portable artistic settings only: no source IDs, paths, credentials or fixtures.
 * Explicit validation precedes replacement so a bad edit retains the last design.
 */
const { behaviors } = require("./behavior-settings.cjs");
const { weights } = require("./scenarios.cjs");
const recipe = require("./recipe.cjs");
const DEFAULT = Object.freeze({
  version: 1,
  preset: "ambient",
  intensity: 0.6,
  outputHz: 4,
  outputRateMode: "fixed",
  recipeOptions: Object.freeze({}),
  parameterRanges: Object.freeze({}),
  interpretation: "musical",
  arrangement: "spatial",
  feel: "normal",
  palette: Object.freeze(["#ffd8ad", "#e8c4ff", "#9dc9ff"]),
  colorMode: "travel",
  colorSeconds: 8,
  minimumBrightness: 10,
  maximumBrightness: 35,
  floorDb: -42,
  ceilingDb: -18,
  behaviors: Object.freeze(behaviors()),
  scenarioMode: "manual",
  scenarioWeights: Object.freeze(weights()),
  raveEnabled: false,
  raveSeconds: 30,
  raveDurationMode: "song",
  raveScenario: "random",
  layerMode: "fixed",
  raveLayerMode: "random",
  raveColorPlan: "configured",
});
const FEELS = Object.freeze({
  slow: Object.freeze({ envelope: 1.8, motion: 0.6 }),
  normal: Object.freeze({ envelope: 1, motion: 1 }),
  fast: Object.freeze({ envelope: 0.65, motion: 1.5 }),
  aggressive: Object.freeze({ envelope: 0.4, motion: 2 }),
});
const fault = (code) => Object.assign(new Error(code), { code });
function settings(input = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !Object.hasOwn(DEFAULT, key))
  )
    throw fault("invalid_music_settings");
  const value = { ...DEFAULT, ...input };
  const choice = (key, choices) => choices.includes(value[key]);
  const range = (key, min, max) =>
    Number.isFinite(value[key]) && value[key] >= min && value[key] <= max;
  if (
    value.version !== 1 ||
    !choice("preset", ["ambient", "pulse", "bands"]) ||
    !choice("interpretation", ["musical", "literal"]) ||
    !choice("arrangement", ["unified", "roles", "spatial"]) ||
    typeof value.feel !== "string" ||
    !Object.hasOwn(FEELS, value.feel) ||
    !choice("colorMode", ["fixed", "travel", "onsets", "roles", "energy"]) ||
    !choice("raveColorPlan", ["configured", "frequency", "energy"]) ||
    !choice("scenarioMode", ["manual", "random"]) ||
    !choice("raveDurationMode", ["song", "dynamic", "separate"]) ||
    !choice("raveScenario", ["random", "wash", "pulse", "bands", "wave", "bounce", "handoff"]) ||
    !choice("layerMode", ["fixed", "random"]) ||
    !choice("raveLayerMode", ["fixed", "random"]) ||
    typeof value.raveEnabled !== "boolean" ||
    !Number.isInteger(value.raveSeconds) ||
    !range("raveSeconds", 1, 3600) ||
    !range("intensity", 0, 1) ||
    !choice("outputRateMode", ["fixed", "adaptive"]) ||
    ![2, 4, 6, 8, 12, 16].includes(value.outputHz) ||
    !range("minimumBrightness", 1, 100) ||
    !range("maximumBrightness", 1, 100) ||
    value.minimumBrightness > value.maximumBrightness ||
    !range("floorDb", -100, -20) ||
    !range("ceilingDb", -60, 0) ||
    value.ceilingDb - value.floorDb < 12 ||
    !range("colorSeconds", 2, 60) ||
    !Array.isArray(value.palette) ||
    !value.palette.length ||
    value.palette.length > 8 ||
    !value.palette.every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))
  )
    throw fault("invalid_music_settings");
  value.behaviors = behaviors(value.behaviors);
  value.recipeOptions = recipe.options(value.recipeOptions);
  value.parameterRanges = recipe.ranges(value.parameterRanges);
  value.scenarioWeights = weights(value.scenarioWeights);
  return { ...value, palette: value.palette.map((color) => color.toLowerCase()) };
}
module.exports = { settings, DEFAULT, FEELS, fault };
