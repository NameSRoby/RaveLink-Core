// [TITLE] Module: app/optional/mod-enabled-server.js
// [TITLE] Purpose: explicit entrypoint for clean core plus the optional mod host

const path = require("node:path");
const createCoreServer = require("../core/create-core-server");
const createModPlatformExtension = require("./create-mod-platform-extension");

const port = Number(process.env.PORT || 5050);
const host = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const rootDir = path.resolve(__dirname, "../../..");
const extend = createModPlatformExtension({
  rootDir,
  maxActiveMods: Number(process.env.RAVELINK_MAX_ACTIVE_MODS || 4)
});
const { app, extension, services } = createCoreServer({ rootDir, port, capabilities: { mods: true }, extend, requestShutdown: signal => stop(signal) });
const server = app.listen(port, host, () => {
  console.log(`[CORE+MODS] RaveLink listening on http://${host}:${port}`);
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 5000);
  timeout.unref?.();
  const shutdownResults = await services.lifecycle.stopAll();
  shutdownResults.filter(result => !result.ok).forEach(result => console.error(`[${result.owner}] shutdown error: ${result.error}`));
  server.close(() => {
    clearTimeout(timeout);
    console.log(`[CORE+MODS] stopped (${signal})`);
    process.exit(0);
  });
}

server.on("error", error => {
  console.error(`[CORE+MODS] server error: ${error?.message || error}`);
  process.exitCode = 1;
});
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
