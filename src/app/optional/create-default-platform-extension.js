/** Discover dropped community packages by default; execute only after approval. */
const createFeatures = require("./create-feature-platform-extension");
const createMods = require("./create-mod-platform-extension");
module.exports = function createDefaultPlatformExtension(options = {}) {
  const attachFeatures = createFeatures(options);
  const attachBundled = createMods(options);
  return function attach(context) {
    const features = attachFeatures(context),
      mods = attachBundled(context);
    return Object.freeze({
      owner: "optional-platforms",
      features,
      mods,
      startup: Promise.all([features.startup, mods.startup]),
      async shutdown() {
        await Promise.allSettled([features.shutdown(), mods.shutdown()]);
      },
    });
  };
};
