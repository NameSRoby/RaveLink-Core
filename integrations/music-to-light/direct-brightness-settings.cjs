/** Native Core policy: color carries transients; brightness follows audio alone.
 * Legacy saved looks retain palettes/routing but cannot restore pulse accents.
 */
module.exports = function directBrightness(config) {
  const legacy = config.interpretation !== "literal";
  return {
    ...config,
    interpretation: "literal",
    intensity: 1,
    scenarioMode: "manual",
    layerMode: "fixed",
    raveScenario: "pulse",
    raveLayerMode: "fixed",
    scenarioWeights: {
      pulse: Object.values(config.scenarioWeights || { pulse: 1 }).some((weight) => weight > 0)
        ? 1
        : 0,
      wave: 0,
      bounce: 0,
      handoff: 0,
    },
    parameterRanges: Object.fromEntries(
      Object.entries(config.parameterRanges || {}).filter(([id]) =>
        ["colorBlendMs", "colorVibrance"].includes(id),
      ),
    ),
    recipeOptions: {
      ...config.recipeOptions,
      ...(config.recipeOptions?.effect && config.recipeOptions.effect.mode !== "configured"
        ? { color: { mode: "configured", value: config.colorMode, allowed: [config.colorMode] } }
        : {}),
      shape: { mode: "fixed", value: "unison", allowed: ["unison"] },
    },
    behaviors: {
      ...config.behaviors,
      attacksEnabled: false,
      swellsEnabled: false,
      expressiveEnabled: false,
      loudnessBrightness: false,
      steadyBrightness: false,
      smoothing: 0,
      outputAttackMs: 0,
      outputReleaseMs: 0,
      outputColorMs: 0,
      hueGlideMs: 0,
      ...(legacy
        ? { literalAttackMs: 35, literalReleaseMs: 100, colorBlendMs: 80, outputColorMs: 0 }
        : {}),
    },
  };
};
