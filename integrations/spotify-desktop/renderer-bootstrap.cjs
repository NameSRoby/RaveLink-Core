/**
 * Renderer bootstrap.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
const createFacade = require("./native-facade.cjs");
const createAdapter = require("./desktop-adapter.cjs");
const createConnection = require("./connection-worker.cjs");
module.exports = function installSpotifyRuntime(root, options = {}) {
  if (Object.hasOwn(root, "__ravelinkSpotify")) throw Error("spotify_runtime_already_installed");
  let captured = false,
    client = null,
    connection = null,
    timer = null,
    failed = false;
  const bridge = {};
  Object.defineProperty(bridge, "capturePlatform", {
    set(platform) {
      if (captured || !platform || typeof platform !== "object") return;
      captured = true;
      try {
        const facade = createFacade(platform, {
          catalog: options.connection?.catalog,
        });
        client = createAdapter(facade, {
          verifyLocalDevice: options.verifyLocalDevice || (() => facade.localDevice()),
        });
        options.onReady?.(client, facade);
      } catch {
        failed = true;
      }
    },
  });
  if (options.connection) {
    // Pair as soon as our renderer loads. Native methods remain unavailable
    // until capture completes, allowing Setup to distinguish loading from pairing.
    const unavailable = () => ({
      ok: false,
      error: "spotify_companion_unavailable",
    });
    const proxy = Object.fromEntries(
      ["search", "lookup", "append", "remove", "control", "snapshot", "playlist"].map((method) => [
        method,
        (...args) => (client ? client[method](...args) : unavailable()),
      ]),
    );
    connection = createConnection(proxy, options.connection);
    if (options.autoPoll !== false)
      timer = setInterval(() => {
        void connection.step();
      }, 1000);
  }
  Object.defineProperty(bridge, "status", {
    value() {
      let readable = false;
      try {
        readable = Boolean(client?.queue().ok);
      } catch {}
      return {
        version: "0.1.0-prototype",
        captured,
        queueReadable: readable,
        failed,
        liveVerified: false,
        commandBridgeInstalled: Boolean(connection),
        connected: connection?.status().paired || false,
      };
    },
  });
  Object.defineProperty(root, "__ravelinkSpotify", {
    value: Object.freeze(bridge),
    configurable: false,
    enumerable: false,
  });
  root.addEventListener?.(
    "pagehide",
    () => {
      clearInterval(timer);
      connection?.close();
    },
    { once: true },
  );
  return root.__ravelinkSpotify;
};
