/** Deliberate room compositions. Applying a look changes artistic settings only;
 * capture grants, routes, fixture scenes and brightness bounds stay with the user.
 * The simulator and native UI consume this same catalog, so previews exercise
 * the production renderer rather than a separate animation implementation.
 */
const { behaviors } = require("./behavior-settings.cjs");
const smooth = require("./profiles/accepted-smooth-v2.json");
const reference = require("./profiles/reference-pulse-v1.json");
const artisticKeys = [
  "preset",
  "interpretation",
  "arrangement",
  "feel",
  "palette",
  "colorMode",
  "colorSeconds",
  "behaviors",
  "recipeOptions",
  "parameterRanges",
  "scenarioMode",
  "layerMode",
];
const looks = [
  {
    id: "smooth-reference",
    label: "Reference Pulse",
    scenario: "pulse",
    help: "Original Pulse timing: 30% smoothing, 260 ms decay and 300 ms color blending. Softer falling light, measured accent strength and restrained color changes. Calibration, brightness limits and output pacing remain yours.",
    design: {
      ...Object.fromEntries(artisticKeys.map((key) => [key, reference[key]])),
      behaviors: { ...reference.behaviors, outputReleaseMs: 180, outputColorMs: 120 },
    },
  },
  {
    id: "smooth-handoff",
    label: "Smooth Handoff",
    scenario: "pulse",
    help: "A slower crossfade between room ends, using the earlier smooth handoff composition.",
    design: Object.fromEntries(artisticKeys.map((key) => [key, smooth[key]])),
  },
  {
    id: "rave-mix",
    label: "Rave Mix",
    scenario: "pulse",
    help: "The reference Pulse response with fresh colors and a compatible room movement. Pulse decay, smoothing and response feel stay consistent. One composition is chosen at each start.",
    design: {
      preset: "pulse",
      scenarioMode: "manual",
      layerMode: "fixed",
      raveLayerMode: "fixed",
      raveScenario: "random",
      scenarioWeights: { pulse: 1, wave: 0, bounce: 0, handoff: 0 },
      palette: ["#ff075b", "#7024ff", "#008cff"],
      recipeOptions: {
        shape: {
          mode: "random",
          value: "bounce",
          allowed: ["unison", "wave", "bounce", "handoff", "swell", "mirror"],
        },
        palette: {
          mode: "random",
          value: "electric-pulse",
          allowed: ["electric-pulse", "ember-pulse", "aurora-swell", "prism-pulse"],
        },
        color: {
          mode: "random",
          value: "onsets",
          allowed: ["onsets", "travel", "roles"],
        },
        feel: { mode: "fixed", value: "normal", allowed: ["normal"] },
      },
      parameterRanges: {
        waveWidth: { min: 0.45, max: 0.6 },
        bounceSeconds: { min: 1.5, max: 2.5 },
        handoffMs: { min: 300, max: 450 },
        interactionDepth: { min: 0.3, max: 0.55 },
      },
      behaviors: {
        ...reference.behaviors,
        outputReleaseMs: 180,
        outputColorMs: 120,
        waveDepth: 0.45,
        swellDepth: 0.45,
      },
    },
  },
  {
    id: "electric-pulse",
    label: "Electric Pulse",
    scenario: "pulse",
    help: "The working attack response in hot pink, electric blue and violet.",
    design: {
      preset: "pulse",
      arrangement: "unified",
      colorMode: "onsets",
      palette: ["#ff075b", "#7024ff", "#008cff"],
      behaviors: { colorBlendMs: 300, colorVibrance: 1 },
    },
  },
  {
    id: "neon-relay",
    label: "Neon Relay",
    scenario: "handoff",
    help: "Three measured attacks hand the leading side across the room, with continuous electric color flow and a softer supporting glow. A fixed composition for comparison with the smooth reference.",
    design: {
      preset: "pulse",
      arrangement: "spatial",
      feel: "normal",
      colorMode: "travel",
      colorSeconds: 6,
      palette: ["#ff075b", "#7024ff", "#008cff"],
      recipeOptions: {
        shape: { mode: "fixed", value: "handoff", allowed: ["handoff"] },
      },
      behaviors: {
        handoffHits: 3,
        handoffMs: 300,
        interactionDepth: 0.65,
        pulseDecayMs: 320,
        outputReleaseMs: 180,
        colorVibrance: 1,
      },
    },
  },
  {
    id: "ember-pulse",
    label: "Ember Pulse",
    scenario: "pulse",
    help: "Whole-room attacks move between red, orange and molten gold.",
    design: {
      preset: "pulse",
      arrangement: "unified",
      colorMode: "onsets",
      palette: ["#ff1800", "#ff6200", "#ffb000"],
      behaviors: { colorBlendMs: 300, colorVibrance: 1 },
    },
  },
  {
    id: "laser-wave",
    label: "Laser Wave",
    scenario: "wave",
    help: "Measured attacks travel across fixture positions in cyan, blue and magenta. Pins Wave for this recipe.",
    design: {
      preset: "pulse",
      arrangement: "spatial",
      colorMode: "travel",
      colorSeconds: 4,
      palette: ["#00f5ff", "#1450ff", "#ff008c"],
      scenarioMode: "random",
      layerMode: "fixed",
      scenarioWeights: { pulse: 0, wave: 1, bounce: 0, handoff: 0 },
      behaviors: {
        waveDepth: 0.9,
        waveWidth: 0.5,
        waveMs: 1200,
        waveVoices: 12,
        colorBlendMs: 300,
        colorVibrance: 1,
      },
    },
  },
  {
    id: "aurora-swell",
    label: "Aurora Pulse",
    scenario: "pulse",
    help: "Pulse dynamics with green, cyan and violet, shaped by a gentle travelling swell.",
    design: {
      preset: "pulse",
      arrangement: "spatial",
      colorMode: "travel",
      colorSeconds: 4,
      palette: ["#00ff62", "#00b8ff", "#7620ff"],
      recipeOptions: { shape: { mode: "fixed", value: "swell", allowed: ["swell"] } },
      behaviors: {
        colorVibrance: 1,
        swellDepth: 0.8,
        swellTravelSeconds: 2.5,
      },
    },
  },
  {
    id: "prism-pulse",
    label: "Prism Pulse",
    scenario: "pulse",
    help: "Pulse response with red-orange, violet and cyan distributed across your frequency roles.",
    design: {
      preset: "pulse",
      arrangement: "roles",
      colorMode: "fixed",
      palette: ["#ff3600", "#9400ff", "#00eaff"],
      behaviors: {
        colorVibrance: 1,
        midTrimDb: 0,
        highTrimDb: 3,
        attackMs: 25,
        releaseMs: 200,
      },
    },
  },
];
looks.push({
  id: "expressive-mix",
  label: "Expressive Mix",
  scenario: "pulse",
  help: "The researched composition: log-spectral attacks, smooth travelling masks, a bounded companion, vivid OKLCH colors and activation-only shuffle variety. One recipe stays locked until Stop.",
  design: {
    ...structuredClone(looks.find((look) => look.id === "rave-mix").design),
    behaviors: {
      ...looks.find((look) => look.id === "rave-mix").design.behaviors,
      expressiveEnabled: true,
      loudnessBrightness: true,
      pulseBed: 0,
      pulseDecayMs: 160,
      spatialAccentShare: 0.15,
    },
    parameterRanges: {
      ...looks.find((look) => look.id === "rave-mix").design.parameterRanges,
      pulseDecayMs: { min: 100, max: 220 },
      spatialAccentShare: { min: 0.05, max: 0.3 },
    },
  },
});
// Each selection supplies a complete artistic state. In particular a former
// random layer mask or Wave-only scenario cannot silently control a manual look.
// Output permissions, source bindings, calibration, brightness and transport
// settings are deliberately absent, so applying a look cannot replace them.
module.exports = Object.freeze(
  looks.map((look) =>
    Object.freeze({
      ...look,
      design: {
        interpretation: "musical",
        arrangement: "unified",
        feel: "normal",
        colorMode: "onsets",
        colorSeconds: 8,
        scenarioMode: "manual",
        layerMode: "fixed",
        recipeOptions: {},
        parameterRanges: {},
        ...look.design,
        behaviors: {
          ...behaviors(),
          ...reference.behaviors,
          outputReleaseMs: 180,
          outputColorMs: 120,
          ...look.design.behaviors,
        },
      },
    }),
  ),
);
