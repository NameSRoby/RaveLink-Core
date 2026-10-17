const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  vm = require("node:vm");
const createBridge = require("../src/capabilities/feature-platform/providers/experimental-tidal-bridge");
const { createAdapter } = require("../integrations/tidal-desktop/adapter.cjs");

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
