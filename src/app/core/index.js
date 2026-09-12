// [TITLE] Module: app/core/index.js
// [TITLE] Purpose: lean process entrypoint for the clean-slate lighting core

const path = require("node:path");
const createCoreServer = require("./create-core-server");

const port = Number(process.env.PORT || 5050);
const host = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const rootDir = path.resolve(__dirname, "../../..");
const { app, services } = createCoreServer({ rootDir, port, requestShutdown: signal => stop(signal) });
const server = app.listen(port, host, () => {
  console.log(`[CORE] RaveLink lighting core listening on http://${host}:${port}`);
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 2500);
  timeout.unref?.();
  await services.lifecycle.stopAll();
  server.close(() => {
    clearTimeout(timeout);
    console.log(`[CORE] stopped (${signal})`);
    process.exit(0);
  });
}

server.on("error", error => {
  console.error(`[CORE] server error: ${error?.message || error}`);
  process.exitCode = 1;
});
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
