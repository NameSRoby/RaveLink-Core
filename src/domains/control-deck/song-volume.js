/** Request-range volume remains usable when a selected desktop companion is disabled.
 * A known unavailable bridge can use the uniquely discovered local app channel.
 * Never retry an uncertain native write through a different control path.
 */
const { fault } = require("./control-deck-config");
const capabilities = { tidal: "song.tidal.experimental.v1", spotify: "song.spotify.player.v1" };
function projection(player, native, audio, volume) {
  if (!capabilities[player] || !native || !(native.enabled === false || native.connected === false))
    return null;
  const apps = audio?.available
    ? (audio.apps || []).filter((app) =>
        player === "tidal" ? /\btidal(?:player)?\b/i.test(app.name) : /\bspotify\b/i.test(app.name),
      )
    : [];
  const low = volume?.floorPercent,
    high = volume?.ceilingPercent;
  const range =
    Number.isInteger(low) && Number.isInteger(high) && low >= 0 && high <= 100 && low <= high;
  const available = range && apps.length === 1 && Number.isInteger(apps[0].volume);
  return {
    available,
    target: apps.length === 1 ? apps[0].key : "",
    low,
    high,
    level: available
      ? Math.max(
          0,
          Math.min(100, Math.round(((apps[0].volume - low) / Math.max(1, high - low)) * 100)),
        )
      : null,
  };
}
module.exports = function songVolume({ feature, desktop, getState }) {
  return {
    describe() {
      const { players, song } = getState(),
        player = players["song.player.preferences.v1"]?.player;
      return projection(
        player,
        players[capabilities[player]],
        desktop?.audioSnapshot?.(),
        song?.queue?.volume,
      );
    },
    async execute(level, signal) {
      if (!Number.isInteger(level) || level < 0 || level > 100)
        throw fault("control_deck_parameters_invalid");
      const selected = await feature("song.player.preferences.v1", "status", null);
      if (!selected.ok) throw fault("song_player_unavailable");
      const player = selected.value?.player,
        capability = capabilities[player];
      let native = null;
      if (capability) {
        const reply = await feature(capability, "status", null);
        if (reply.ok && reply.value?.ok !== false) native = reply.value;
      }
      if (native && (native.enabled === false || native.connected === false)) {
        const queue = await feature("song.queue.read.v1", "status", {
          limit: 1,
          playlistLimit: 1,
          moderationLimit: 1,
        });
        const audio = await desktop?.audioStatus?.(),
          route = projection(player, native, audio, queue.value?.volume);
        if (!queue.ok || !route?.available) throw fault("song_volume_app_unavailable");
        if (signal?.aborted) throw fault("control_deck_cancelled");
        const output = Math.round(route.low + (level * (route.high - route.low)) / 100);
        const state = await desktop.execute(
          "native.audio.volume:" + route.target,
          { level: output },
          signal,
        );
        if (
          state?.available !== true ||
          state.apps?.find((app) => app.key === route.target)?.volume !== output
        )
          throw fault("song_volume_change_unconfirmed");
        if (signal?.aborted) throw fault("control_deck_cancelled");
        return feature("song.queue.admin.v1", "moderate", { action: "volume", value: level });
      }
      return feature("song.queue.admin.v1", "moderate", {
        action: "volume",
        value: level,
        operatorPlayback: true,
      });
    },
  };
};
module.exports.projection = projection;
