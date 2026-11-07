/** Draw once at Rave activation. No render-time randomness; no capture settings. */
const profiles = require("./effect-profiles.cjs");
module.exports = function randomProfile(config, history, random = Math.random) {
  if (!config.behaviors.randomProfileEnabled) return config;
  const draw = history.draw(
    "native-effect-profiles",
    profiles.map((p) => ({ id: p.id, weight: 1 })),
    random,
  );
  const profile = profiles.find((p) => p.id === draw.id);
  return {
    ...config,
    colorMode: profile.colorMode,
    parameterRanges: {},
    recipeOptions: Object.fromEntries(
      Object.entries(config.recipeOptions).filter(([id]) =>
        ["palette", "paletteScope"].includes(id),
      ),
    ),
    behaviors: {
      ...config.behaviors,
      ...profile.behaviors,
      profilePaletteEnabled: config.behaviors.profilePaletteEnabled,
      randomProfileEnabled: false,
    },
  };
};
