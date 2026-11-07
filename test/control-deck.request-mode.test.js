const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../src/domains/control-deck/request-intake-mode");
function fixture() {
  const status = {
      connected: true,
      scopes: ["user:read:chat"],
      managedRewards: [{ purpose: "song_request" }],
      monitorConfig: {
        intakeMode: "native",
        songRequestChatEnabled: false,
        commandPermissions: { request: { viewers: true } },
      },
    },
    calls = [];
  let paused = false,
    queuePaused = false,
    failConfigure = false;
  const mode = create({
    getFeatures: () => ({
      list: () => ({ features: [{ id: "twitch-integration", lifecycle: "active" }] }),
      request: async (feature, cap, method, input) => {
        assert.equal(feature, "twitch-integration");
        if (cap === "twitch.connection.read.v1")
          return { ok: true, value: structuredClone(status) };
        assert.equal(cap, "twitch.monitor.admin.v1");
        assert.equal(method, "configure");
        calls.push(["configure", input.songRequestChatEnabled]);
        if (failConfigure) return { ok: false };
        Object.assign(status.monitorConfig, input);
        return { ok: true, value: { ok: true } };
      },
    }),
    getRewards: () => ({
      snapshot: async () => ({
        available: true,
        rewards: [{ id: "synthetic", purpose: "song_request", manageable: true, paused }],
      }),
      update: async (input) => {
        calls.push(["reward", input.paused]);
        if (!input.paused && queuePaused)
          return { ok: true, partial: true, results: [{ ok: false, held: true }] };
        paused = input.paused;
        return { ok: true };
      },
    }),
  });
  return {
    mode,
    status,
    calls,
    get paused() {
      return paused;
    },
    setQueuePaused(v) {
      queuePaused = v;
    },
    failConfigure() {
      failConfigure = true;
    },
  };
}
test("request mode reads the owner, pauses paid intake before chat and preserves command permissions", async () => {
  const f = fixture();
  await f.mode.refresh(true);
  assert.equal(f.mode.catalog()[0].state.text, "Channel Points");
  await f.mode.execute();
  assert.deepEqual(f.calls, [
    ["reward", true],
    ["configure", true],
  ]);
  assert.equal(f.mode.catalog()[0].state.text, "Chat · !sr");
  assert.deepEqual(f.status.monitorConfig.commandPermissions, { request: { viewers: true } });
  await f.mode.execute();
  assert.deepEqual(f.calls.slice(-2), [
    ["configure", false],
    ["reward", false],
  ]);
  assert.equal(f.paused, false);
});
test("changing to Channel Points cannot reopen a paused queue", async () => {
  const f = fixture();
  await f.mode.execute();
  f.setQueuePaused(true);
  await f.mode.execute();
  assert.equal(f.status.monitorConfig.songRequestChatEnabled, false);
  assert.equal(f.paused, true);
});
test("failed or unauthorized mode changes never announce success or resume a reward", async () => {
  const f = fixture();
  f.status.scopes = [];
  await assert.rejects(f.mode.execute(), /chat_access_required/);
  assert.deepEqual(f.calls, []);
  f.status.scopes = ["user:read:chat"];
  f.failConfigure();
  await assert.rejects(f.mode.execute(), /mode_change_failed/);
  assert.equal(f.status.monitorConfig.songRequestChatEnabled, false);
  assert.equal(f.paused, true);
  assert(!f.calls.some((row) => row[0] === "reward" && row[1] === false));
  await assert.rejects(f.mode.execute(AbortSignal.abort()), /cancelled/);
});
