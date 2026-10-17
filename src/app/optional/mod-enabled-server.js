/**
 * Mod enabled server.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#startup-and-shutdown
 */
// Explicit mod-host profile. It does not attach the first-party feature loader.
const path = require("node:path");
const startCoreServer = require("../runtime/start-core-server");
const createModPlatformExtension = require("./create-mod-platform-extension");
const rootDir = path.resolve(__dirname, "../../..");
startCoreServer({
  rootDir,
  label: "CORE+MODS",
  capabilities: { mods: true },
  extend: createModPlatformExtension({
    rootDir,
    maxActiveMods: Number(process.env.RAVELINK_MAX_ACTIVE_MODS || 4),
  }),
});
