const path = require("node:path");
const createCoreServer = require("../core/create-core-server");
const createFeaturePlatformExtension = require("./create-feature-platform-extension");
const createModPlatformExtension = require("./create-mod-platform-extension");

const port = Number(process.env.PORT || 5050);
const host = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const rootDir = path.resolve(__dirname, "../../..");
const attachFeatures = createFeaturePlatformExtension({ rootDir, allowUnsafeRuntime: process.env.RAVELINK_ALLOW_UNSAFE_FEATURE_RUNTIME !== "0" });
const attachMods = createModPlatformExtension({ rootDir, maxActiveMods: Number(process.env.RAVELINK_MAX_ACTIVE_MODS || 4) });
const extend = context => {
  const features = attachFeatures(context);
  const mods = attachMods(context);
  return Object.freeze({
    owner: "optional-platforms",
    features,
    mods,
    async shutdown() { await Promise.allSettled([features.shutdown(), mods.shutdown()]); }
  });
};
const { app, services } = createCoreServer({ rootDir, port, capabilities: { features: true, mods: true }, extend, requestShutdown: signal => stop(signal) });
const server = app.listen(port, host, () => console.log(`[CORE+FEATURES+MODS] RaveLink listening on http://${host}:${port}`));

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 5000);
  timeout.unref?.();
  await services.lifecycle.stopAll();
  server.close(() => { clearTimeout(timeout); console.log(`[CORE+FEATURES+MODS] stopped (${signal})`); process.exit(0); });
}

server.on("error", error => { console.error(`[CORE+FEATURES+MODS] server error: ${error?.message || error}`); process.exitCode = 1; });
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
