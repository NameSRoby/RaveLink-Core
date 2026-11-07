const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  vm = require("node:vm");
const createBridge = require("../src/capabilities/feature-platform/providers/experimental-tidal-bridge");
const { createAdapter } = require("../integrations/tidal-desktop/adapter.cjs");

test("one bounded long poll wakes on volume input and releases on cancellation or shutdown", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-volume-wake-")),
    bridge = createBridge({ runtimeDir: root }),
    input = { companionId: "volume-fixture", ready: true, volumeReady: true, waitMs: 1500 };
  t.after(() => {
    bridge.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const waiting = bridge.pollWait(input);
  assert.equal((await bridge.pollWait(input)).error, "tidal_poll_busy");
  const operation = bridge.volume({ percent: 37 }),
    reply = await waiting;
  assert.equal(reply.command.percent, 37);
  assert.equal(reply.waitSupported, true);
  bridge.complete({ id: reply.command.id, companionId: input.companionId, ok: true, percent: 37 });
  assert.deepEqual(await operation, { ok: true, percent: 37 });
  const controller = new AbortController(),
    cancelled = bridge.pollWait(input, controller.signal);
  controller.abort();
  assert.equal((await cancelled).error, "tidal_poll_cancelled");
  const next = bridge.volume({ percent: 12 });
  assert.equal((await bridge.pollWait(input, controller.signal)).error, "tidal_poll_cancelled");
  const delivered = bridge.poll(input);
  assert.equal(delivered.command.percent, 12, "a cancelled reader cannot consume a command");
  bridge.complete({
    id: delivered.command.id,
    companionId: input.companionId,
    ok: true,
    percent: 12,
  });
  await next;
  let settled = false;
  const closing = bridge.pollWait({ ...input, ready: false }).then((reply) => {
    settled = true;
    return reply;
  });
  await Promise.resolve();
  assert.equal(settled, false, "initializing players must wait too, without busy polling");
  bridge.shutdown();
  assert.equal((await closing).error, "tidal_poll_cancelled");
});

test("native volume is a bounded confirmed command and never changes the native queue", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-volume-"));
  const bridge = createBridge({ runtimeDir: root });
  t.after(() => {
    bridge.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const poll = (extra) =>
    bridge.poll({
      companionId: "volume-fixture",
      ready: true,
      queueReady: true,
      ...extra,
    });
  poll({});
  assert.equal((await bridge.volume({ percent: 100 })).error, "tidal_companion_update_required");
  poll({ volumeReady: true });
  for (const percent of [-1, 101, 12.5, "40", NaN])
    assert.equal((await bridge.volume({ percent })).error, "tidal_volume_invalid");
  const pending = bridge.volume({ percent: 100 });
  const command = poll({ volumeReady: true }).command;
  assert.equal(command.kind, "volume");
  assert.equal(command.percent, 100);
  assert.equal(command.trackId, undefined);
  assert.equal((await bridge.volume({ percent: 20 })).error, "tidal_bridge_busy");
  assert.equal(
    bridge.complete({
      id: command.id,
      companionId: "foreign",
      ok: true,
      percent: 100,
    }).error,
    "tidal_command_stale",
  );
  assert.equal(
    bridge.complete({
      id: command.id,
      companionId: "volume-fixture",
      ok: true,
      percent: 99,
    }).error,
    "tidal_volume_unconfirmed",
  );
  bridge.complete({
    id: command.id,
    companionId: "volume-fixture",
    ok: true,
    percent: 100,
  });
  assert.deepEqual(await pending, { ok: true, percent: 100 });
  assert.equal(bridge.status().handoffs.length, 0);
});

test("the renderer changes only local volume through the allowlisted action and confirms Redux state", async () => {
  const state = {
    player: "BOOMBOX",
    activePlayer: { activePlayer: "PLAYER_SDK" },
    playbackControls: { volume: 40 },
    playQueue: { elements: ["unchanged"] },
  };
  const calls = [];
  const redux = {
    store: { getState: () => state },
    actions: {
      "playbackControls/SET_VOLUME": (input) => {
        calls.push(input);
        state.playbackControls.volume = input.volume;
      },
    },
  };
  const adapter = createAdapter(redux, new Set());
  assert.equal(adapter.canSetVolume(), true);
  assert.deepEqual(await adapter.setVolume(100), { percent: 100 });
  assert.deepEqual(calls, [{ volume: 100 }]);
  assert.deepEqual(state.playQueue.elements, ["unchanged"]);
  await assert.rejects(adapter.setVolume(101), /tidal_volume_invalid/);
  state.remotePlayback = { isConnected: true };
  assert.equal(adapter.canSetVolume(), false);
  await assert.rejects(adapter.setVolume(20), /tidal_volume_unavailable/);
  const sandbox = { setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../integrations/tidal-desktop/renderer-runtime.js"),
      "utf8",
    ),
    sandbox,
  );
  const hooks = sandbox.__ravelinkTidal;
  const creator = hooks.wrapAction((type) => (payload) => ({ type, payload }))(
    "playbackControls/SET_VOLUME",
  );
  let dispatched;
  hooks.captureStore({
    getState: () => ({ playQueue: {}, activePlayer: {} }),
    dispatch: (value) => {
      dispatched = value;
    },
    subscribe() {},
  });
  creator({ volume: 10 });
  hooks.redux.actions["playbackControls/SET_VOLUME"]({ volume: 15 });
  assert.equal(dispatched.payload.volume, 15);
  assert.equal(hooks.redux.actions["user/LOGIN"], undefined);
});
