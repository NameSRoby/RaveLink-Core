const path = require("node:path");
const createCoreServer = require("../core/create-core-server");
const createFeaturePlatformExtension = require("./create-feature-platform-extension");

const port = Number(process.env.PORT || 5050);
const host = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const rootDir = path.resolve(__dirname, "../../..");
const extend = createFeaturePlatformExtension({ rootDir, allowUnsafeRuntime: process.env.RAVELINK_ALLOW_UNSAFE_FEATURE_RUNTIME !== "0" });
const { app, extension, services } = createCoreServer({ rootDir, port, capabilities: { features: true }, extend, requestShutdown: signal => stop(signal) });
const server = app.listen(port, host, () => console.log(`[CORE+FEATURES] RaveLink listening on http://${host}:${port}`));

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 5000);
  timeout.unref?.();
  await services.lifecycle.stopAll();
  server.close(() => { clearTimeout(timeout); console.log(`[CORE+FEATURES] stopped (${signal})`); process.exit(0); });
}

server.on("error", error => { console.error(`[CORE+FEATURES] server error: ${error?.message || error}`); process.exitCode = 1; });
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
