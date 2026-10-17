/**
 * HTTP process lifecycle shared by the four supported startup profiles.
 *
 * Entrypoints choose their extensions; this module never enables a host itself.
 * Services drain before HTTP closes. Repeated signals share the same shutdown,
 * and a forced-exit timer bounds a stuck worker or socket. Listen errors also
 * drain services so an occupied port cannot leave background timers running.
 * Dependencies can be injected to test ordering without exiting the test runner.
 */
module.exports = function startCoreServer(options, dependencies = {}) {
  const runtimeProcess = dependencies.process || process;
  const log = dependencies.log || console;
  const createServer = dependencies.createCoreServer || require("../core/create-core-server");
  const label = options.label || "CORE";
  const port = Number(runtimeProcess.env.PORT || 5050);
  const host = String(runtimeProcess.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
  const core = createServer({
    ...options,
    port,
    requestShutdown: (signal) => stop(signal),
  });
  const server = core.app.listen(port, host, () => {
    log.log(`[${label}] RaveLink ${options.description || ""}listening on http://${host}:${port}`);
  });
  let shutdown = null;

  function stop(signal, exitCode = 0) {
    if (shutdown) return shutdown;
    shutdown = Promise.resolve().then(async () => {
      const timeout = setTimeout(() => runtimeProcess.exit(1), options.shutdownTimeoutMs || 5000);
      timeout.unref?.();
      try {
        const results = await core.services.lifecycle.stopAll();
        for (const result of results) {
          if (!result.ok) log.error(`[${result.owner}] shutdown error: ${result.error}`);
        }
      } catch (error) {
        log.error(`[${label}] shutdown error: ${error?.message || error}`);
        exitCode = 1;
      }
      await new Promise((resolve) => server.close(resolve));
      clearTimeout(timeout);
      log.log(`[${label}] stopped (${signal})`);
      runtimeProcess.exit(exitCode);
    });
    return shutdown;
  }

  server.on("error", (error) => {
    log.error(`[${label}] server error: ${error?.message || error}`);
    void stop("server-error", 1);
  });
  runtimeProcess.on("SIGINT", () => {
    void stop("SIGINT");
  });
  runtimeProcess.on("SIGTERM", () => {
    void stop("SIGTERM");
  });
  return { ...core, server, stop };
};
