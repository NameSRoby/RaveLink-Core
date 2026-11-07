const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../src/domains/control-deck/player-transport");
test("Next and Previous target the currently selected native session without global keys or uncertain retries", async () => {
  let provider = "tidal",
    reply = { ok: true, accepted: true };
  const calls = [],
    state = {
      players: { "song.player.preferences.v1": { player: "tidal" } },
      song: {
        playback: { primary: { provider: "tidal", status: "playing", observedAt: Date.now() } },
      },
    },
    transport = create({
      getState: () => state,
      feature: async (cap) => ({
        ok: true,
        value: cap === "song.player.preferences.v1" ? { player: provider } : state.song.playback,
      }),
      getController: () => ({
        control: async (value) => {
          calls.push(value);
          return reply;
        },
      }),
    });
  assert(transport.catalog().every((row) => row.available));
  await transport.execute("native.player.next");
  await transport.execute("native.player.previous");
  assert.deepEqual(calls, [
    { provider: "tidal", action: "next" },
    { provider: "tidal", action: "previous" },
  ]);
  provider = "spotify";
  await transport.execute("native.player.next");
  assert.deepEqual(calls.at(-1), { provider: "spotify", action: "next" });
  reply = { ok: false, error: "media_control_rejected" };
  await assert.rejects(transport.execute("native.player.previous"), /media_control_rejected/);
  assert.equal(calls.length, 4, "an uncertain or rejected native command is never replayed");
  provider = "youtube";
  await assert.rejects(transport.execute("native.player.next"), /media_player_unavailable/);
  assert.equal(calls.length, 4);
  provider = "tidal";
  reply = { ok: true };
  await transport.execute("native.player.playPause");
  assert.equal(calls.at(-1).action, "pause");
  state.song.playback.primary.status = "paused";
  await transport.execute("native.player.playPause");
  assert.equal(calls.at(-1).action, "resume");
  delete state.song.playback.primary.observedAt;
  await assert.rejects(transport.execute("native.player.playPause"), /state_unknown/);
  await assert.rejects(transport.execute("native.player.next", { aborted: true }), /cancelled/);
  state.song.playback.playbackSource = "auto";
  state.song.playback.primary = {
    provider: "apple-music",
    status: "playing",
    observedAt: Date.now(),
  };
  await transport.execute("native.player.next");
  assert.deepEqual(
    calls.at(-1),
    { provider: "apple-music", action: "next" },
    "Automatic follows confirmed now-playing, not a different request-provider preference",
  );
});
