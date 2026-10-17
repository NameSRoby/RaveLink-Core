// [TITLE] Test Module: test/hue-bridge.adapter.test.js
// [TITLE] Purpose: verify Hue adapter timeout fallback and error-log throttling

const test = require("node:test");
const assert = require("node:assert/strict");

const createHueBridgeAdapter = require("../src/adapters/brands/hue-bridge.adapter");

test("Hue discovery uses bounded mDNS fallback and destroys its request-scoped resources", async () => {
  let stopped = 0;
  let destroyed = 0;
  class FakeBonjour {
    find(_query, onService) {
      queueMicrotask(() =>
        onService({
          txt: { bridgeid: "ECB5FAFFFE923D75" },
          addresses: ["192.168.1.131"],
        }),
      );
      return {
        stop: () => {
          stopped += 1;
        },
      };
    }
    destroy() {
      destroyed += 1;
    }
  }
  const adapter = createHueBridgeAdapter({
    axios: { get: async () => ({ data: [] }) },
    Bonjour: FakeBonjour,
    setTimeout: (callback) => setImmediate(callback),
    clearTimeout: (handle) => clearImmediate(handle),
    dryRun: true,
  });

  const result = await adapter.discoverBridges({ mdnsTimeoutMs: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.source, "mdns");
  assert.equal(result.bridges.length, 1);
  assert.equal(stopped, 1);
  assert.equal(destroyed, 1);
});

test("Hue adapter lists bridge lights from legacy API inventory", async () => {
  const adapter = createHueBridgeAdapter({
    axios: {
      get: async () => ({
        status: 200,
        data: {
          2: {
            name: "Desk 2",
            modelid: "LCA001",
            type: "Extended color light",
          },
          1: {
            name: "Desk 1",
            modelid: "LCA001",
            type: "Extended color light",
          },
          abc: { name: "invalid" },
        },
      }),
    },
    dryRun: false,
  });
  const result = await adapter.listLights({
    bridgeIp: "192.168.1.120",
    username: "test-user",
  });
  assert.equal(result.ok, true);
  assert.equal(result.bridgeIp, "192.168.1.120");
  assert.equal(Array.isArray(result.lights), true);
  assert.equal(result.lights.length, 2);
  assert.equal(result.lights[0].lightId, 1);
  assert.equal(result.lights[1].lightId, 2);
  assert.equal(result.lights[0].name, "Desk 1");
});

test("Hue adapter falls back to HTTP when HTTPS request times out", async () => {
  const calls = [];
  const axios = {
    put: async (url) => {
      calls.push(url);
      if (url.startsWith("https://")) {
        const error = new Error("timeout of 1800ms exceeded");
        error.code = "ECONNABORTED";
        throw error;
      }
      return { status: 200, data: [{ success: true }] };
    },
  };
  const adapter = createHueBridgeAdapter({
    axios,
    dryRun: false,
    now: () => 1000,
  });
  const result = await adapter.sendState(
    [
      {
        brand: "hue",
        bridgeIp: "192.168.1.10",
        username: "testuser",
        lightId: 1,
      },
    ],
    { on: true, bri: 120 },
  );

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.command, {
    method: "PUT",
    resource: "light-state",
    body: { on: true, bri: 120 },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].startsWith("https://"), true);
  assert.equal(calls[1].startsWith("http://"), true);
});

test("Hue REST state sends use the baseline shared egress lane", async () => {
  let admission;
  const adapter = createHueBridgeAdapter({
    axios: { put: async () => ({ status: 200 }) },
    dryRun: false,
    egressGovernor: {
      run: async (spec, operation) => {
        admission = spec;
        return operation();
      },
    },
  });
  const result = await adapter.sendState(
    [
      {
        bridgeIp: "192.168.1.10",
        username: "testuser",
        lightId: 1,
      },
    ],
    { on: true },
  );
  assert.equal(result.sent, 1);
  assert.deepEqual(admission, {
    owner: "lighting.hue",
    priority: "baseline",
    queueDeadlineMs: 5000,
  });
});

test("Hue adapter throttles repeated identical send errors", async () => {
  let nowTick = 1000;
  const logWarnings = [];
  const axios = {
    put: async () => {
      throw new Error("network timeout");
    },
  };
  const adapter = createHueBridgeAdapter({
    axios,
    dryRun: false,
    now: () => nowTick,
    log: {
      warn: (...args) => {
        logWarnings.push(args.join(" "));
      },
    },
  });

  await adapter.sendState(
    [{ brand: "hue", bridgeIp: "192.168.1.10", username: "user", lightId: 1 }],
    { on: true },
  );
  nowTick = 1100;
  await adapter.sendState(
    [{ brand: "hue", bridgeIp: "192.168.1.10", username: "user", lightId: 1 }],
    { on: true },
  );
  nowTick = 17000;
  await adapter.sendState(
    [{ brand: "hue", bridgeIp: "192.168.1.10", username: "user", lightId: 1 }],
    { on: true },
  );

  assert.equal(logWarnings.length, 2);
  assert.equal(logWarnings[0].includes("[HUE] REST send failed (bridge timeout)"), true);
  assert.equal(logWarnings[1].includes("[HUE] REST send failed (bridge timeout)"), true);
});

test("Hue adapter applies temporary cooldown after timeout failures", async () => {
  let nowTick = 1000;
  let calls = 0;
  const axios = {
    put: async () => {
      calls += 1;
      const error = new Error("timeout of 1800ms exceeded");
      error.code = "ECONNABORTED";
      throw error;
    },
  };
  const adapter = createHueBridgeAdapter({
    axios,
    dryRun: false,
    now: () => nowTick,
    log: {
      warn() {},
    },
  });
  const fixture = {
    brand: "hue",
    bridgeIp: "192.168.1.10",
    username: "user",
    lightId: 1,
  };

  const first = await adapter.sendState([fixture], { on: true });
  assert.equal(first.sent, 0);
  assert.equal(first.failed, 1);
  assert.equal(calls, 2);

  // [DEV] Immediate re-send should be skipped due to transient bridge cooldown.
  nowTick = 1050;
  const second = await adapter.sendState([fixture], { on: true });
  assert.equal(second.sent, 0);
  assert.equal(second.failed, 0);
  assert.equal(second.skipped, 1);
  assert.equal(calls, 2);

  // [DEV] After cooldown window passes, adapter should retry bridge transport.
  nowTick = 5000;
  const third = await adapter.sendState([fixture], { on: true });
  assert.equal(third.sent, 0);
  assert.equal(third.failed, 1);
  assert.equal(calls, 4);
});

test("Hue adapter honors fixture capability forceHttp hint", async () => {
  const calls = [];
  const axios = {
    put: async (url) => {
      calls.push(url);
      return { status: 200, data: [{ success: true }] };
    },
  };
  const adapter = createHueBridgeAdapter({
    axios,
    dryRun: false,
    now: () => 1000,
  });
  const result = await adapter.sendState(
    [
      {
        brand: "hue",
        bridgeIp: "192.168.1.30",
        username: "http-only-user",
        lightId: 2,
        extras: {
          hueBridgeCapabilities: {
            forceHttp: true,
            supportsHttps: false,
            supportsEntertainment: false,
            bridgeModelId: "BSB001",
          },
        },
      },
    ],
    { on: true, bri: 180 },
  );

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].startsWith("http://"), true);
});

test("Hue adapter keeps using HTTP after fallback finds a working rest path", async () => {
  let nowTick = 1000;
  const calls = [];
  const axios = {
    put: async (url) => {
      calls.push(url);
      if (url.startsWith("https://")) {
        const error = new Error("timeout of 1800ms exceeded");
        error.code = "ECONNABORTED";
        throw error;
      }
      return { status: 200, data: [{ success: true }] };
    },
  };
  const adapter = createHueBridgeAdapter({
    axios,
    dryRun: false,
    now: () => nowTick,
  });
  const fixture = {
    brand: "hue",
    bridgeIp: "192.168.1.10",
    username: "testuser",
    lightId: 1,
  };

  const first = await adapter.sendState([fixture], { on: true, bri: 120 });
  assert.equal(first.sent, 1);
  assert.equal(first.failed, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].startsWith("https://"), true);
  assert.equal(calls[1].startsWith("http://"), true);

  nowTick += 11 * 60 * 1000;
  const second = await adapter.sendState([fixture], { on: true, bri: 120 });
  assert.equal(second.sent, 1);
  assert.equal(second.failed, 0);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].startsWith("http://"), true);
});

test("Hue adapter suppresses repeated entertainment retries after closed socket fallback", async () => {
  let nowTick = 1000;
  let entertainmentCalls = 0;
  const logWarnings = [];
  const entertainmentRuntime = {
    getStatus: () => ({
      available: true,
      reason: "",
    }),
    sendFrame: async () => {
      entertainmentCalls += 1;
      return { ok: false, error: "The socket is closed. Cannot send data." };
    },
    stopAll: async () => ({ ok: true }),
  };
  const axios = {
    put: async () => ({ status: 200, data: [{ success: true }] }),
  };
  const adapter = createHueBridgeAdapter({
    axios,
    dryRun: false,
    now: () => nowTick,
    createHueEntertainmentRuntime: () => entertainmentRuntime,
    log: {
      warn: (...args) => {
        logWarnings.push(args.join(" "));
      },
    },
  });
  const fixture = {
    brand: "hue",
    bridgeIp: "192.168.1.10",
    username: "ent-user",
    lightId: 1,
    clientKey: "A".repeat(32),
    entertainmentAreaId: "desk-area",
    bridgeId: "ECB5FAFFFE923D75",
    extras: {
      hueBridgeCapabilities: {
        supportsEntertainment: true,
        supportsHttps: true,
        forceHttp: false,
        bridgeModelId: "BSB002",
      },
    },
  };

  const first = await adapter.sendState([fixture], { on: true, bri: 140 });
  assert.equal(first.sent, 1);
  assert.equal(first.failed, 0);
  assert.equal(entertainmentCalls, 1);
  assert.equal(
    logWarnings.some((entry) =>
      entry.includes("[HUE] Entertainment fallback -> REST (session closed)"),
    ),
    true,
  );

  nowTick += 1000;
  const second = await adapter.sendState([fixture], { on: true, bri: 140 });
  assert.equal(second.sent, 1);
  assert.equal(second.failed, 0);
  assert.equal(entertainmentCalls, 1);
});

test("Hue adapter keeps entertainment RGB independent from bri when __rgb is unavailable", async () => {
  const frames = [];
  const entertainmentRuntime = {
    getStatus: () => ({
      available: true,
      reason: "",
    }),
    sendFrame: async (_config, frameInput) => {
      frames.push(frameInput);
      return { ok: true };
    },
    stopAll: async () => ({ ok: true }),
  };
  const adapter = createHueBridgeAdapter({
    axios: {
      put: async () => {
        throw new Error("rest_fallback_should_not_run");
      },
    },
    dryRun: false,
    now: () => 1000,
    createHueEntertainmentRuntime: () => entertainmentRuntime,
  });

  const result = await adapter.sendState(
    [
      {
        brand: "hue",
        bridgeIp: "192.168.1.10",
        username: "ent-user",
        lightId: 1,
        clientKey: "A".repeat(32),
        entertainmentAreaId: "desk-area",
        bridgeId: "ECB5FAFFFE923D75",
        extras: {
          hueBridgeCapabilities: {
            supportsEntertainment: true,
            supportsHttps: true,
            forceHttp: false,
            bridgeModelId: "BSB002",
          },
        },
      },
    ],
    {
      on: true,
      xy: [0.3127, 0.329],
      bri: 12,
    },
  );

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].bri, 12);
  assert.ok(Number(frames[0].rgb?.r) >= 220);
  assert.ok(Number(frames[0].rgb?.g) >= 220);
  assert.ok(Number(frames[0].rgb?.b) >= 220);
});

test("Hue adapter may attempt Entertainment on an explicitly configured legacy bridge and keeps HTTP as fallback", async () => {
  let frames = 0,
    restCalls = 0;
  const adapter = createHueBridgeAdapter({
    axios: {
      put: async () => {
        restCalls += 1;
        return { status: 200 };
      },
    },
    dryRun: false,
    createHueEntertainmentRuntime: () => ({
      getStatus: () => ({ available: true, reason: "" }),
      sendFrame: async () => {
        frames += 1;
        return { ok: true };
      },
      stopAll: async () => ({ ok: true }),
    }),
  });
  const result = await adapter.sendState(
    [
      {
        brand: "hue",
        bridgeIp: "192.168.1.2",
        username: "legacy-user",
        lightId: 1,
        clientKey: "B".repeat(32),
        entertainmentAreaId: "legacy-area",
        bridgeId: "legacy-bridge",
        extras: {
          hueBridgeCapabilities: {
            supportsEntertainment: true,
            supportsHttps: false,
            forceHttp: true,
            bridgeModelId: "BSB001",
          },
        },
      },
    ],
    { on: true, bri: 200, xy: [0.2, 0.3] },
  );
  assert.equal(result.sent, 1);
  assert.equal(frames, 1);
  assert.equal(restCalls, 0);
});

test("Hue REST fan-out stays within the declared four-request lane", async () => {
  let active = 0;
  let peak = 0;
  const adapter = createHueBridgeAdapter({
    dryRun: false,
    axios: {
      put: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { status: 200 };
      },
    },
  });
  const fixtures = Array.from({ length: 12 }, (_, index) => ({
    brand: "hue",
    bridgeIp: "192.168.2." + String(index + 1),
    username: "user-" + String(index),
    lightId: 1,
    extras: {
      hueBridgeCapabilities: {
        forceHttp: true,
        supportsHttps: false,
        supportsEntertainment: false,
      },
    },
  }));
  const result = await adapter.sendState(fixtures, { on: true, bri: 100 });
  assert.equal(result.sent, fixtures.length);
  assert.equal(result.failed, 0);
  assert.equal(peak, 4);
  assert.equal(adapter.getTelemetry().resources.maximumRestConcurrency, 4);
  assert.equal(adapter.getTelemetry().resources.maximumEntriesPerCache, 256);
});

test("Hue adapter evicts removed fixture transport state and shuts down cleanly", async () => {
  const adapter = createHueBridgeAdapter({
    dryRun: false,
    axios: { put: async () => ({ status: 200 }) },
  });
  const fixture = {
    id: "hue-1",
    brand: "hue",
    bridgeIp: "192.168.1.20",
    bridgeId: "bridge-1",
    username: "local-user",
    lightId: 1,
    extras: {
      hueBridgeCapabilities: {
        supportsHttps: true,
        supportsEntertainment: false,
      },
    },
  };
  assert.equal((await adapter.sendState([fixture], { on: true, bri: 100 })).sent, 1);
  assert.equal(adapter.getTelemetry().resources.cacheEntries > 0, true);
  const reconciled = await adapter.reconcileFixtures([]);
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.removed > 0, true);
  assert.equal(adapter.getTelemetry().resources.cacheEntries, 0);
  assert.equal((await adapter.shutdown()).ok, true);
});
