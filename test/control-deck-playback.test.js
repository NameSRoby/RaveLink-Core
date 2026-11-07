const test = require("node:test"),
  assert = require("node:assert/strict");
const route = require("../features/song-request/dist/chat-player-commands");

test("individual reward actions follow exact managed IDs and live state without controlling foreign rewards", async () => {
  const rows = [
    { id: "managed-a", title: "Lights", manageable: true, paused: false, enabled: true },
    { id: "managed-b", title: "Songs", manageable: true, paused: true, enabled: true },
    { id: "disabled", title: "Disabled", manageable: true, paused: false, enabled: false },
    { id: "foreign", title: "External", manageable: false, paused: false },
  ];
  const writes = [];
  const owner = {
    snapshot: async () => ({ available: true, rewards: rows }),
    toggleReward: async (id) => {
      writes.push(id);
      const row = rows.find((entry) => entry.id === id);
      row.paused = !row.paused;
      return { ok: true };
    },
  };
  const toggles = require("../src/domains/control-deck/control-deck-pause-actions")({
    feature: async () => {
      throw Error("unexpected feature action");
    },
    activeFeature: () => false,
    getRewards: () => owner,
  });
  await toggles.refresh(true);
  assert.equal(toggles.catalog().find((row) => row.id === "rewards.toggle").state.tone, "mixed");
  const disabled = toggles.catalog().find((row) => row.id === "rewards.toggle:disabled").state;
  assert.equal(disabled.text, "Disabled in Twitch");
  assert.equal(disabled.tone, "inactive");
  assert.equal(disabled.active, false);
  assert.equal(
    toggles.catalog().find((row) => row.id === "rewards.toggle:managed-a").label,
    "Pause Lights",
  );
  assert.equal(
    toggles.catalog().some((row) => row.id === "rewards.toggle:foreign"),
    false,
  );
  await toggles.execute("rewards.toggle:managed-a");
  assert.deepEqual(writes, ["managed-a"]);
  assert.equal(
    toggles.catalog().find((row) => row.id === "rewards.toggle:managed-a").label,
    "Resume Lights",
  );
  rows.splice(0, 1);
  await toggles.refresh(true);
  assert.equal(
    toggles.catalog().some((row) => row.id === "rewards.toggle:managed-a"),
    false,
  );
  await assert.rejects(
    toggles.execute("rewards.toggle:managed-a"),
    /managed_rewards_state_unknown/,
  );
  assert.equal(writes.length, 1);
});

test("deck pause toggles read current owners, serialize competing buttons and keep playback separate from intake", async () => {
  let playbackPaused = false,
    intakePaused = false,
    native = false;
  const changes = [];
  const feature = async (capability, method, payload) => {
    if (capability === "song.player.preferences.v1")
      return {
        ok: true,
        value: { player: native ? "tidal" : "youtube", youtubePlayback: "embed" },
      };
    if (capability === "song.playback.read.v1")
      return { ok: true, value: { control: { paused: playbackPaused }, primary: null } };
    if (capability === "song.tidal.experimental.v1")
      return { ok: true, value: { connected: false, ready: false, current: { paused: false } } };
    if (capability === "song.queue.read.v1") return { ok: true, value: { paused: intakePaused } };
    assert.equal(method, "moderate");
    await new Promise((resolve) => setTimeout(resolve, 5));
    changes.push(payload);
    if (payload.operatorPlayback) playbackPaused = payload.action === "pause";
    else intakePaused = payload.action === "pause";
    return { ok: true, value: { ok: true } };
  };
  const toggles = require("../src/domains/control-deck/control-deck-pause-actions")({
    feature,
    activeFeature: () => true,
    getRewards: () => null,
  });
  await toggles.refresh(true);
  assert.equal(
    toggles.catalog().find((row) => row.id === "song.playback-toggle").label,
    "Pause playback",
  );
  await Promise.all([
    toggles.execute("song.playback-toggle"),
    toggles.execute("song.playback-toggle"),
  ]);
  assert.deepEqual(
    changes.map((row) => row.action),
    ["pause", "resume"],
  );
  assert(changes.every((row) => row.operatorPlayback === true));
  assert.equal(intakePaused, false);
  await toggles.execute("song.intake-toggle");
  assert.equal(intakePaused, true);
  assert.equal(playbackPaused, false);
  playbackPaused = true;
  await toggles.refresh(true);
  assert.equal(
    toggles.catalog().find((row) => row.id === "song.playback-toggle").label,
    "Resume playback",
    "external owner change overrides previous click history",
  );
  native = true;
  await toggles.refresh(true);
  assert.equal(toggles.catalog().find((row) => row.id === "song.playback-toggle").available, false);
  await assert.rejects(toggles.execute("song.playback-toggle"), /song_player_not_connected/);
  assert.equal(
    toggles.catalog().find((row) => row.id === "song.playback-toggle").state.text,
    "Connect the selected player",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    toggles.execute("song.intake-toggle", controller.signal),
    /control_deck_cancelled/,
  );
  assert.equal(changes.length, 3);
});
test("operator playback routes every selected player without changing request intake or posting chat", async () => {
  for (const player of ["youtube", "soundcloud", "tidal", "spotify", "youtube-browser"]) {
    const calls = [],
      queue = {
        status: () => ({ volume: { floorPercent: 0, ceilingPercent: 40 } }),
        moderate: (payload) => {
          calls.push(["queue", payload]);
          return { ok: true, code: "volume_changed" };
        },
        controlPlayback: (payload) => {
          calls.push(["local-playback", payload]);
          return { ok: true, code: "playback_" + payload.action };
        },
      };
    const native = async (method, payload) => {
      calls.push(["native", method, payload]);
      return { ok: true };
    };
    const handler = route({
      queue,
      preferences: async () => ({
        ok: true,
        player: player === "youtube-browser" ? "youtube" : player,
        youtubePlayback: player === "youtube-browser" ? "browser" : "embed",
      }),
      tidal: native,
      spotify: native,
      youtubeBrowser: native,
      context: {
        callCapability: async (...args) => {
          calls.push(args);
          return { ok: true };
        },
      },
      changed: () => {},
    });
    for (const action of ["pause", "resume", "volume"]) {
      const result = await handler({
        capability: "song.queue.admin.v1",
        method: "moderate",
        payload: { action, operatorPlayback: true, ...(action === "volume" ? { value: 50 } : {}) },
      });
      assert.equal(result.value.ok, true, player + " " + action);
    }
    assert(calls.some((row) => row[0] === "queue" && row[1].action === "volume"));
    if (["youtube", "soundcloud"].includes(player))
      assert(calls.some((row) => row[0] === "local-playback"));
    else
      assert(
        calls.some((row) => row[0] === "native" && (row[2].percent === 20 || row[2].value === 20)),
      );
    assert.equal(
      await handler({
        capability: "song.queue.admin.v1",
        method: "moderate",
        payload: { action: "pause" },
      }),
      null,
      "plain pause still belongs to request intake",
    );
  }
});

test("operator playback flag passes the real supervised contract and keeps intake separate", async (t) => {
  const sent = [];
  const harness = require("./support/feature-runtime-harness").createFeatureRuntimeHarness(
    require("../features/song-request/dist/main"),
    {
      featureId: "song-request",
      providers: {
        "twitch.chat.send.v1/send": async (payload) => {
          sent.push(payload);
          return { ok: true };
        },
      },
    },
  );
  await harness.start();
  t.after(() => harness.stop());
  const result = await harness.request("song.queue.admin.v1", "moderate", {
    action: "pause",
    operatorPlayback: true,
  });
  assert.equal(result.ok, true);
  const queue = await harness.request("song.queue.read.v1", "status", { limit: 1 });
  const playback = await harness.request("song.playback.read.v1", "status", null);
  assert.equal(queue.paused, false);
  assert.equal(playback.control.paused, true);
  assert.equal(sent.length, 0);
});
