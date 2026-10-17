/**
 * Combined enabled server.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#startup-and-shutdown
 */
// Explicit combined profile: both hosts remain independently supervised.
const path = require("node:path");
const startCoreServer = require("../runtime/start-core-server");
const createFeaturePlatformExtension = require("./create-feature-platform-extension");
const createModPlatformExtension = require("./create-mod-platform-extension");
const rootDir = path.resolve(__dirname, "../../..");
const attachFeatures = createFeaturePlatformExtension({
  rootDir,
  allowUnsafeRuntime: process.env.RAVELINK_ALLOW_UNSAFE_FEATURE_RUNTIME !== "0",
});
const attachMods = createModPlatformExtension({
  rootDir,
  maxActiveMods: Number(process.env.RAVELINK_MAX_ACTIVE_MODS || 4),
});
startCoreServer({
  rootDir,
  label: "CORE+FEATURES+MODS",
  capabilities: { features: true, mods: true },
  extend(context) {
    const features = attachFeatures(context);
    const mods = attachMods(context);
    return Object.freeze({
      owner: "optional-platforms",
      features,
      mods,
      async shutdown() {
        await Promise.allSettled([features.shutdown(), mods.shutdown()]);
      },
    });
  },
});
