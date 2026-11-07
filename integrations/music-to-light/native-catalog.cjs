/** Native controls expose the current color-led model. Legacy IDs remain readable
 * in saved files; pulse and secondary brightness-envelope controls stay retired.
 */
const direct = require("./direct-brightness-settings.cjs");
const hidden = new Set([
  "attacksEnabled",
  "swellsEnabled",
  "balanceEnabled",
  "expressiveEnabled",
  "logAttacksEnabled",
  "smoothShapesEnabled",
  "perceptualColorsEnabled",
  "loudnessBrightness",
  "steadyBrightness",
  "pulseDecayMs",
  "pulseBed",
  "accentDepth",
  "impactDepth",
  "bodyAttackMs",
  "bodyReleaseMs",
  "attackMs",
  "releaseMs",
  "referenceMs",
  "riseGain",
  "riseDecayMs",
  "outputAttackMs",
  "outputReleaseMs",
  "spatialAccentShare",
  "waveVoices",
  "hueGlideMs",
  "waveMs",
  "waveWidth",
  "waveDepth",
  "bounceSeconds",
  "handoffHits",
  "handoffMs",
  "interactionDepth",
  "swellSpan",
  "swellDepth",
  "swellTravelSeconds",
  "midTrimDb",
  "highTrimDb",
]);
const accepted = require("./profiles/accepted-color-led-v1.json");
const {
  intensity: _intensity,
  outputHz: _hz,
  outputRateMode: _rate,
  warmCoolColors: _temperature,
  ...artistic
} = accepted;
const legacy = require("./looks.cjs");
artistic.behaviors = { ...artistic.behaviors, ...require("./effect-profiles.cjs")[0].behaviors };
const ids = [
  "smooth-reference",
  "rave-mix",
  "electric-pulse",
  "ember-pulse",
  "aurora-swell",
  "prism-pulse",
];
const names = {
  "smooth-reference": "Color-led audio",
  "rave-mix": "Smart random",
  "electric-pulse": "Electric colors",
  "ember-pulse": "Ember colors",
  "aurora-swell": "Aurora colors",
  "prism-pulse": "Prism colors",
};
const looks = ids.map((id) => {
  const old = legacy.find((l) => l.id === id);
  const randomized = id === "rave-mix";
  return {
    id,
    kind: ["smooth-reference", "rave-mix"].includes(id) ? "response" : "palette",
    label: names[id],
    scenario: "pulse",
    help: randomized
      ? "Fresh palettes and audio-driven color styles, with the accepted brightness response kept stable."
      : id === "smooth-reference"
        ? "Musical energy drives brightness; measured rhythmic hits alternate neighboring colors with controlled fades. Calibration and output limits stay yours."
        : "Apply this palette while keeping your brightness smoothing, audio mapping, calibration and limits.",
    design: direct({
      ...artistic,
      palette: id === "smooth-reference" || randomized ? artistic.palette : old.design.palette,
      recipeOptions: randomized
        ? {
            palette: {
              mode: "random",
              value: "electric-pulse",
              allowed: ["electric-pulse", "ember-pulse", "aurora-swell", "prism-pulse"],
            },
            color: { mode: "random", value: "onsets", allowed: ["onsets", "energy", "roles"] },
            feel: { mode: "fixed", value: "normal", allowed: ["normal"] },
          }
        : artistic.recipeOptions,
      parameterRanges: {},
    }),
  };
});
for (const profile of require("./effect-profiles.cjs")) {
  if (!profile.value) continue;
  looks.splice(profile.value, 0, {
    id: profile.id,
    kind: "profile",
    label: profile.label,
    help: profile.help,
    lights: profile.lights,
    summary: profile.summary,
    design: direct({
      ...artistic,
      colorMode: profile.colorMode,
      palette: [...profile.palette],
      behaviors: { ...artistic.behaviors, ...profile.behaviors },
      recipeOptions: {},
      parameterRanges: {},
    }),
  });
}
looks[0].kind = "profile";
looks[0].lights = 1;
looks[0].summary = require("./effect-profiles.cjs")[0].summary;
const hiddenNative = new Set([
  ...hidden,
  "outputColorMs",
  "spatialEnabled",
  "profilePaletteEnabled",
]);
module.exports = {
  looks,
  recipeAxes: require("./recipe.cjs").axes.filter((axis) => axis.id !== "shape"),
  behaviors: require("./behavior-settings.cjs")
    .catalog.filter((field) => !hiddenNative.has(field.id))
    .map((field) => ({
      ...field,
      ...(field.id === "colorVibrance"
        ? {
            label: "Transition vividness",
            help: "Keep transitions vivid between palette colors. Used by audio-driven color transitions, not a static color or warm/cool mapping.",
          }
        : {}),
      ...(field.id === "rateHoldMs"
        ? {
            label: "Experimental output-rate hold",
            help: "Only for experimental adaptive output cadence. Does not control musical color reactivity.",
          }
        : {}),
      ...(field.id === "rateRiseThreshold"
        ? {
            label: "Experimental output-rate rise",
            help: "Only for experimental adaptive output cadence. Color reactivity follows its own calibrated audio level.",
          }
        : {}),
      ...(field.id === "literalAttackMs"
        ? {
            label: "Normal brightness rise",
            help: "Smooth ordinary brightness rises. Distinct upward impacts respond faster, down to 20 ms, including quieter hits. Colors cannot trigger a brightness pulse.",
          }
        : {}),
      ...(field.id === "literalReleaseMs"
        ? {
            label: "Brightness fall",
            help: "Smooth the sustained brightness fall. No pulse decay is added.",
          }
        : {}),
      ...(field.id === "colorBlendMs"
        ? {
            label: "Beat color fade",
            min: 0,
            max: 300,
            help: "Fade after each measured hit, at the same speed in quiet and loud passages. Zero selects immediate color steps.",
          }
        : {}),
    })),
  baseline: looks[0].design,
};
