/**
 * Index.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#startup-and-shutdown
 */
// Lighting-only entrypoint. No feature loader, mod host, or inbox watcher.
const path = require("node:path");
const startCoreServer = require("../runtime/start-core-server");
startCoreServer({
  rootDir: path.resolve(__dirname, "../../.."),
  label: "CORE",
  description: "lighting core ",
  shutdownTimeoutMs: 2500,
});
