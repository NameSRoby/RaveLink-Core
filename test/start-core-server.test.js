const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const startCoreServer = require("../src/app/runtime/start-core-server");

function fixture(stopAll = async () => []) {
  const runtimeProcess = new EventEmitter();
  runtimeProcess.env = { PORT: "43210", HOST: "127.0.0.1" };
  const calls = [];
  runtimeProcess.exit = (code) => calls.push(["exit", code]);
  const server = new EventEmitter();
  server.close = (callback) => {
    calls.push(["close"]);
    callback();
  };
  let config;
  const runtime = startCoreServer(
    { rootDir: "test-root", label: "TEST" },
    {
      process: runtimeProcess,
      log: { log() {}, error() {} },
      createCoreServer(options) {
        config = options;
        return {
          app: {
            listen(port, host, callback) {
              calls.push(["listen", port, host]);
              callback();
              return server;
            },
          },
          services: { lifecycle: { stopAll } },
        };
      },
    },
  );
  return { process: runtimeProcess, calls, runtime, config };
}

test("signals and the shutdown route share one drain and close HTTP afterwards", async () => {
  const calls = [];
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture(async () => {
    calls.push("drain");
    await waiting;
    return [];
  });
  f.process.emit("SIGINT");
  const first = f.runtime.stop("route");
  f.config.requestShutdown("host");
  f.process.emit("SIGTERM");
  assert.equal(first, f.runtime.stop("again"));
  await Promise.resolve();
  assert.deepEqual(calls, ["drain"]);
  assert.deepEqual(f.calls, [["listen", 43210, "127.0.0.1"]]);
  release();
  await first;
  assert.deepEqual(f.calls.slice(1), [["close"], ["exit", 0]]);
});

test("listen errors drain services and terminate with failure", async () => {
  let drains = 0;
  const f = fixture(async () => {
    drains++;
    return [];
  });
  f.runtime.server.emit("error", new Error("EADDRINUSE"));
  await f.runtime.stop("wait");
  assert.equal(drains, 1);
  assert.deepEqual(f.calls.at(-1), ["exit", 1]);
});

test("a rejected shutdown hook still closes the listener", async () => {
  const f = fixture(async () => {
    throw new Error("failed shutdown");
  });
  await f.runtime.stop("test");
  assert.deepEqual(f.calls.slice(1), [["close"], ["exit", 1]]);
});
