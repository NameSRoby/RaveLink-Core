/** The default app starts the reviewed clip adapter. Community packages
 * retain a separate opt-in host, installation root and approval workflow. */
const createFeatures = require("./create-feature-platform-extension");
const createMods = require("./create-mod-platform-extension");
module.exports = function createDefaultPlatformExtension(options = {}) {
  const attachFeatures = createFeatures(options);
  const attachBundled = createMods({ ...options, bundledOnly: true });
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
