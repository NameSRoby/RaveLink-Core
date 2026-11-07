// [TITLE] Test Module: test/mod-platform.process-supervisor.test.js
// [TITLE] Purpose: verify isolated mod lifecycle, request limits, and quarantine behavior

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const createModProcessSupervisor = require("../src/capabilities/mod-platform/host/mod-process-supervisor");

const HASH = "a".repeat(64);

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-mod-supervisor-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "dist", "main.js"),
    options.source || "module.exports = {};\n",
    "utf8",
  );
  const manifest = {
    schemaVersion: 1,
    id: "example.test-mod",
    name: "Test Mod",
    version: "1.0.0",
    publisher: "example",
    license: "MIT",
    entry: "dist/main.js",
    engine: { ravelinkModApi: "^1.0.0", node: ">=22" },
    activationEvents: ["onEnable"],
    consumes: options.consumes || [],
    provides: ["test.echo.v1"],
    permissions: {
      network: [],
      storage: false,
      secrets: [],
      ui: false,
      process: false,
      hardware: [],
    },
    resources: {
      idleCpuPercent: 0.1,
      idleRssMiB: 32,
      activeRssMiB: 64,
      timers: 1,
      minTimerMs: 1000,
      ipcFrameBytes: 32768,
      inFlightCalls: options.inFlightCalls || 1,
      queuedCalls: options.queuedCalls === undefined ? 1 : options.queuedCalls,
      externalInFlight: 0,
      storageBytes: 0,
      historyEntries: 10,
      shutdownGraceMs: 500,
    },
    integrity: { algorithm: "sha256", files: { "dist/main.js": HASH } },
  };
  return { root, manifest };
}

function envelope(type, fields = {}) {
  return { protocolVersion: 1, type, sentAt: Date.now(), ...fields };
}

function createFakeChild(onHostSend) {
  const child = new EventEmitter();
  child.pid = 43120;
  child.connected = true;
  child.send = (message) => onHostSend?.(message, child);
  child.kill = (signal) => {
    child.connected = false;
    setImmediate(() => child.emit("exit", signal === "SIGKILL" ? 1 : 0, signal));
  };
  return child;
}

function fakeForkWithSuccessfulHandshake(onRequest) {
  return () => {
    const child = createFakeChild((message, target) => {
      if (message.type === "ready") {
        setImmediate(() =>
          target.emit(
            "message",
            envelope("ready", {
              payload: { phase: "active", ok: true, modId: "example.test-mod" },
            }),
          ),
        );
      } else if (message.type === "request") {
        onRequest?.(message, target);
      } else if (message.type === "shutdown") {
        target.connected = false;
        setImmediate(() => target.emit("exit", 0, null));
      }
    });
    setImmediate(() =>
      child.emit(
        "message",
        envelope("hello", {
          payload: { modId: "example.test-mod", pid: child.pid, apiMajor: 1 },
        }),
      ),
    );
    return child;
  };
}

const ENFORCED_SUPPORT = {
  permission: true,
  fsRead: true,
  fsWrite: true,
  network: true,
  childProcess: true,
  worker: true,
  addons: true,
};

test("a well-formed request expired in transit times out without a protocol violation or provider call", async (t) => {
  const fixture = createFixture(),
    replies = [];
  let child,
    calls = 0;
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const fork = fakeForkWithSuccessfulHandshake();
  const supervisor = createModProcessSupervisor({
    modRoot: fixture.root,
    manifest: fixture.manifest,
    permissionSupport: ENFORCED_SUPPORT,
    forkFn: (...args) => {
      child = fork(...args);
      const send = child.send;
      child.send = (message) => {
        replies.push(message);
        send(message);
      };
      return child;
    },
    onBrokerRequest: async () => {
      calls++;
      return {};
    },
  });
  await supervisor.start();
  t.after(() => supervisor.stop());
  child.emit(
    "message",
    envelope("request", {
      id: "expired",
      capability: "test.echo.v1",
      method: "status",
      deadlineAt: Date.now() - 1,
      payload: {},
    }),
  );
  assert.equal(calls, 0);
  assert.equal(replies.find((row) => row.replyTo === "expired").error.code, "broker_timeout");
  assert.equal(supervisor.getStatus().protocolViolations, 0);
  assert.equal(supervisor.getStatus().lastError, "");
});

test("a completed stop cannot later terminate or corrupt a replacement worker", async (t) => {
  const fixture = createFixture();
  const workers = [];
  const fork = fakeForkWithSuccessfulHandshake();
  const supervisor = createModProcessSupervisor({
    modRoot: fixture.root,
    manifest: fixture.manifest,
    permissionSupport: ENFORCED_SUPPORT,
    forkFn: () => {
      const child = fork();
      workers.push(child);
      return child;
    },
  });
  t.after(async () => {
    await supervisor.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  assert.equal((await supervisor.start()).lifecycle, "active");
  assert.equal((await supervisor.stop()).lifecycle, "installed-disabled");
  assert.equal((await supervisor.start()).lifecycle, "active");
  workers[0].emit("exit", 1, "SIGKILL");
  workers[0].emit("message", envelope("hello", { payload: {} }));
  workers[0].emit("error", new Error("late_old_worker_error"));
  await new Promise((resolve) =>
    setTimeout(resolve, fixture.manifest.resources.shutdownGraceMs + 100),
  );
  assert.equal(supervisor.getStatus().lifecycle, "active");
  assert.equal(supervisor.getStatus().forcedStops, 0);
  assert.equal(supervisor.getStatus().lastError, "");
  assert.equal(workers[1].connected, true);
});

test("supervisor fails closed when runtime isolation is incomplete", async () => {
  const fixture = createFixture();
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: { ...ENFORCED_SUPPORT, network: false },
  });
  const status = await supervisor.start();
  assert.equal(status.lifecycle, "permission-required");
  assert.equal(status.lastError, "runtime_isolation_unavailable");
  assert.equal(status.pid, 0);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("supervisor handshakes, dispatches a request, and drains shutdown", async () => {
  const fixture = createFixture();
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: ENFORCED_SUPPORT,
    forkFn: fakeForkWithSuccessfulHandshake((message, child) => {
      setImmediate(() =>
        child.emit(
          "message",
          envelope("response", {
            replyTo: message.id,
            ok: true,
            payload: { echo: message.payload },
          }),
        ),
      );
    }),
  });
  const started = await supervisor.start();
  assert.equal(started.lifecycle, "active");
  const result = await supervisor.request("test.echo.v1", "echo", {
    value: 42,
  });
  assert.deepEqual(result, { ok: true, value: { echo: { value: 42 } } });
  const stopped = await supervisor.stop();
  assert.equal(stopped.lifecycle, "installed-disabled");
  assert.equal(stopped.pendingCount, 0);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("supervisor brokers bounded requests originating from an active mod", async () => {
  const fixture = createFixture({ consumes: ["chat.send.v1"] });
  let fakeChild;
  const responses = [];
  const events = [];
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: ENFORCED_SUPPORT,
    onBrokerRequest: async (capability, method, payload, options) => ({
      ok: true,
      value: { capability, method, payload, providerId: options.providerId },
    }),
    onBrokerEvent: async (capability, method, payload) =>
      events.push({ capability, method, payload }),
    forkFn: () => {
      fakeChild = fakeForkWithSuccessfulHandshake()();
      const originalSend = fakeChild.send;
      fakeChild.send = (message) => {
        if (message.type === "response") responses.push(message);
        originalSend(message);
      };
      return fakeChild;
    },
  });
  await supervisor.start();
  fakeChild.emit(
    "message",
    envelope("request", {
      id: "worker_1",
      capability: "chat.send.v1",
      method: "send",
      providerId: "ravelink.chat",
      deadlineAt: Date.now() + 1000,
      payload: { text: "hello" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].payload.providerId, "ravelink.chat");
  assert.equal(supervisor.getStatus().protocolViolations, 0);
  fakeChild.emit(
    "message",
    envelope("event", {
      capability: "test.echo.v1",
      method: "changed",
      payload: { value: 2 },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    { capability: "test.echo.v1", method: "changed", payload: { value: 2 } },
  ]);
  await supervisor.stop();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("supervisor aborts an expired host provider call and releases inbound capacity", async (t) => {
  const fixture = createFixture({ consumes: ["chat.send.v1"] });
  let fakeChild;
  let providerSignal;
  const responses = [];
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: ENFORCED_SUPPORT,
    onBrokerRequest: async (capability, method, payload, options) => {
      providerSignal = options.signal;
      return await new Promise(() => {});
    },
    forkFn: () => {
      fakeChild = fakeForkWithSuccessfulHandshake()();
      const originalSend = fakeChild.send;
      fakeChild.send = (message) => {
        if (message.type === "response") responses.push(message);
        originalSend(message);
      };
      return fakeChild;
    },
  });
  t.after(async () => {
    await supervisor.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  await supervisor.start();
  fakeChild.emit(
    "message",
    envelope("request", {
      id: "worker_timeout",
      capability: "chat.send.v1",
      method: "send",
      deadlineAt: Date.now() + 40,
      payload: { text: "hello" },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(providerSignal.aborted, true);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.code, "broker_timeout");
  assert.equal(supervisor.getStatus().inboundCount, 0);
  assert.equal(supervisor.getStatus().providerTimeouts, 1);
});

test("supervisor bounds in-flight and queued requests", async () => {
  const fixture = createFixture({ inFlightCalls: 1, queuedCalls: 1 });
  const held = [];
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: ENFORCED_SUPPORT,
    forkFn: fakeForkWithSuccessfulHandshake((message, child) => held.push({ message, child })),
  });
  await supervisor.start();
  const first = supervisor.request("test.echo.v1", "echo", { index: 1 });
  const second = supervisor.request("test.echo.v1", "echo", { index: 2 });
  const third = await supervisor.request("test.echo.v1", "echo", { index: 3 });
  assert.equal(third.ok, false);
  assert.equal(third.error.code, "queue_full");
  assert.equal(supervisor.getStatus().pendingCount, 1);
  assert.equal(supervisor.getStatus().queuedCount, 1);

  held[0].child.emit(
    "message",
    envelope("response", { replyTo: held[0].message.id, ok: true, payload: 1 }),
  );
  assert.equal((await first).value, 1);
  await new Promise((resolve) => setImmediate(resolve));
  held[1].child.emit(
    "message",
    envelope("response", { replyTo: held[1].message.id, ok: true, payload: 2 }),
  );
  assert.equal((await second).value, 2);
  await supervisor.stop();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("supervisor rejects malformed or oversized requests before queueing", async () => {
  const fixture = createFixture();
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: ENFORCED_SUPPORT,
    forkFn: fakeForkWithSuccessfulHandshake(),
  });
  await supervisor.start();
  let result = await supervisor.request("test.echo.v1", "Bad Method", null);
  assert.equal(result.error.code, "invalid_request");

  const circular = {};
  circular.self = circular;
  result = await supervisor.request("test.echo.v1", "echo", circular);
  assert.equal(result.error.code, "invalid_request");

  result = await supervisor.request("test.echo.v1", "echo", {
    text: "x".repeat(40000),
  });
  assert.equal(result.error.code, "invalid_request");
  assert.equal(supervisor.getStatus().pendingCount, 0);
  assert.equal(supervisor.getStatus().queuedCount, 0);
  await supervisor.stop();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("supervisor quarantines repeated invalid IPC", async () => {
  const fixture = createFixture();
  let fakeChild;
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: ENFORCED_SUPPORT,
    protocolViolationLimit: 2,
    forkFn: () => {
      fakeChild = fakeForkWithSuccessfulHandshake()();
      return fakeChild;
    },
  });
  await supervisor.start();
  fakeChild.emit("message", { unexpected: true });
  fakeChild.emit("message", { unexpected: true });
  assert.equal(supervisor.getStatus().lifecycle, "quarantined");
  assert.equal(supervisor.getStatus().protocolViolations, 2);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("supervisor cancels timed-out requests and releases queue capacity", async () => {
  const fixture = createFixture();
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: ENFORCED_SUPPORT,
    forkFn: fakeForkWithSuccessfulHandshake(),
  });
  await supervisor.start();
  const result = await supervisor.request("test.echo.v1", "echo", null, {
    timeoutMs: 20,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "request_timeout");
  assert.equal(supervisor.getStatus().pendingCount, 0);
  await supervisor.stop();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("supervisor quarantines a handshake identity mismatch", async () => {
  const fixture = createFixture();
  let fakeChild;
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: ENFORCED_SUPPORT,
    forkFn: () => {
      fakeChild = createFakeChild();
      setImmediate(() =>
        fakeChild.emit(
          "message",
          envelope("hello", {
            payload: {
              modId: "attacker.wrong-mod",
              pid: fakeChild.pid,
              apiMajor: 1,
            },
          }),
        ),
      );
      return fakeChild;
    },
  });
  const status = await supervisor.start();
  assert.equal(status.lifecycle, "quarantined");
  assert.equal(status.lastError, "handshake_mismatch");
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("supervisor quarantines repeated unexpected process exits", async () => {
  const fixture = createFixture();
  const children = [];
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: ENFORCED_SUPPORT,
    crashLimit: 2,
    forkFn: () => {
      const child = fakeForkWithSuccessfulHandshake()();
      children.push(child);
      return child;
    },
  });
  await supervisor.start();
  children[0].emit("exit", 1, null);
  assert.equal(supervisor.getStatus().lifecycle, "crashed");
  await supervisor.start();
  children[1].emit("exit", 1, null);
  assert.equal(supervisor.getStatus().lifecycle, "quarantined");
  assert.equal(supervisor.getStatus().crashes, 2);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("supervisor terminates a child that never completes activation", async () => {
  const fixture = createFixture();
  let killed = false;
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: ENFORCED_SUPPORT,
    startupTimeoutMs: 100,
    forkFn: () => {
      const child = createFakeChild();
      const originalKill = child.kill;
      child.kill = (signal) => {
        killed = true;
        originalKill(signal);
      };
      return child;
    },
  });
  const status = await supervisor.start();
  assert.equal(status.lifecycle, "crashed");
  assert.equal(status.lastError, "activation_timeout");
  assert.equal(killed, true);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("supervisor resolves shutdown after forcibly terminating a hung child", async () => {
  const fixture = createFixture();
  fixture.manifest.resources.shutdownGraceMs = 100;
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: ENFORCED_SUPPORT,
    forkFn: () => {
      const child = createFakeChild((message, target) => {
        if (message.type === "ready") {
          setImmediate(() =>
            target.emit(
              "message",
              envelope("ready", {
                payload: {
                  phase: "active",
                  ok: true,
                  modId: "example.test-mod",
                },
              }),
            ),
          );
        }
      });
      child.kill = () => {};
      setImmediate(() =>
        child.emit(
          "message",
          envelope("hello", {
            payload: { modId: "example.test-mod", pid: child.pid, apiMajor: 1 },
          }),
        ),
      );
      return child;
    },
  });
  await supervisor.start();
  const stopped = await supervisor.stop();
  assert.equal(stopped.lifecycle, "installed-disabled");
  assert.equal(stopped.forcedStops, 1);
  assert.equal(stopped.lastError, "shutdown_timeout");
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("supervisor runs a real child only with explicit unsafe override on this runtime", async () => {
  const fixture = createFixture({
    source: [
      "module.exports = {",
      "  handleRequest({ method, payload }) {",
      "    if (method !== 'echo') throw new Error('unknown_method');",
      "    return { echoed: payload, leaked: process.env.RAVELINK_TEST_SECRET || null };",
      "  },",
      "  deactivate() {}",
      "};",
    ].join("\n"),
  });
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    allowUnsafeRuntime: true,
    environment: {
      TEMP: os.tmpdir(),
      RAVELINK_TEST_SECRET: "must-not-cross-boundary",
    },
    startupTimeoutMs: 5000,
  });
  const started = await supervisor.start();
  assert.equal(started.lifecycle, "active", started.lastError);
  assert.equal(started.unsafeRuntime, true);
  const result = await supervisor.request("test.echo.v1", "echo", {
    real: true,
  });
  assert.deepEqual(result, {
    ok: true,
    value: { echoed: { real: true }, leaked: null },
  });
  const stopped = await supervisor.stop();
  assert.equal(stopped.lifecycle, "installed-disabled");
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("cancelling an outer worker call aborts its queued host action without later side effects", async (t) => {
  const fixture = createFixture({
    consumes: ["desktop.control.v1"],
    source: `
    let host;
    module.exports = {
      activate(context) { host = context; },
      async handleRequest() {
        await new Promise(resolve => setImmediate(resolve));
        return host.callCapability('desktop.control.v1', 'toggle', {}, {timeoutMs: 5000});
      }
    };`,
  });
  let observed,
    calls = 0,
    markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    allowUnsafeRuntime: true,
    startupTimeoutMs: 5000,
    onBrokerRequest: async (_capability, _method, _payload, options) => {
      observed = options.signal;
      markStarted();
      await new Promise((resolve) =>
        options.signal.addEventListener("abort", resolve, { once: true }),
      );
      if (!options.signal.aborted) calls++;
      return {
        ok: false,
        error: { code: "request_cancelled", message: "Cancelled", retryable: true },
      };
    },
  });
  t.after(async () => {
    await supervisor.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  assert.equal((await supervisor.start()).lifecycle, "active");
  const controller = new AbortController();
  const pending = supervisor.request(
    "test.echo.v1",
    "toggle",
    {},
    { timeoutMs: 3000, signal: controller.signal },
  );
  await started;
  controller.abort();
  assert.equal((await pending).error.code, "request_cancelled");
  assert.equal(observed.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
  assert.equal(supervisor.getStatus().pendingCount, 0);
  assert.equal(supervisor.getStatus().inboundCount, 0);
});

test("queued worker requests expire from enqueue time and cancelled requests never dispatch", async (t) => {
  const fixture = createFixture(),
    sent = [];
  const supervisor = createModProcessSupervisor({
    manifest: fixture.manifest,
    modRoot: fixture.root,
    permissionSupport: ENFORCED_SUPPORT,
    forkFn: fakeForkWithSuccessfulHandshake((message) => sent.push(message)),
  });
  t.after(async () => {
    await supervisor.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  await supervisor.start();
  const controller = new AbortController();
  const first = supervisor.request(
    "test.echo.v1",
    "echo",
    {},
    { timeoutMs: 1000, signal: controller.signal },
  );
  const queued = supervisor.request("test.echo.v1", "echo", {}, { timeoutMs: 20 });
  assert.equal((await queued).error.code, "request_timeout");
  controller.abort();
  assert.equal((await first).error.code, "request_cancelled");
  assert.equal(sent.length, 1);
  assert.equal(supervisor.getStatus().queuedCount, 0);
  assert.equal(
    (await supervisor.request("test.echo.v1", "echo", {}, { signal: controller.signal })).error
      .code,
    "request_cancelled",
  );
  assert.equal(sent.length, 1);
});
