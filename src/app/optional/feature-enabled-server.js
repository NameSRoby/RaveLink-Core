/**
 * Feature enabled server.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#startup-and-shutdown
 */
// Default profile: core plus the first-party feature loader. Installed features
// still control their own activation and supervised worker lifecycle.
const path = require("node:path");
const startCoreServer = require("../runtime/start-core-server");
const createFeaturePlatformExtension = require("./create-feature-platform-extension");
const rootDir = path.resolve(__dirname, "../../..");
startCoreServer({
  rootDir,
  label: "CORE+FEATURES",
  capabilities: { features: true },
  extend: createFeaturePlatformExtension({
    rootDir,
    allowUnsafeRuntime: process.env.RAVELINK_ALLOW_UNSAFE_FEATURE_RUNTIME !== "0",
  }),
});
