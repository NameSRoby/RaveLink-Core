/** Selected native session commands; no global media-key fallback or write replay. */
const { fault } = require("./control-deck-config");
const providers = ["tidal", "spotify", "apple-music"];
module.exports = function playerTransport({ feature, getController, getState }) {
  const handles = (id) => /^native\.player\.(next|previous|playPause)$/.test(id);
  function providerFor(preferences, playback) {
    const source = playback?.playbackSource;
    if (providers.includes(source)) return source;
    if (source === "auto") {
      const current = playback.primary;
      return current &&
        Number.isFinite(current.observedAt) &&
        Date.now() - current.observedAt < 15000 &&
        providers.includes(current.provider)
        ? current.provider
        : null;
    }
    return source && !providers.includes(source) ? null : preferences?.player;
  }
  const selection = () =>
    providerFor(getState().players["song.player.preferences.v1"], getState().song?.playback);
  function paused(provider) {
    const current = getState().song?.playback?.primary;
    return current?.provider === provider &&
      ["playing", "paused"].includes(current.status) &&
      Number.isFinite(current.observedAt) &&
      Date.now() - current.observedAt < 15000
      ? current.status === "paused"
      : null;
  }
  return {
    handles,
    catalog() {
      const provider = selection();
      return [
        ["next", "Next song", "⏭"],
        ["previous", "Previous song", "⏮"],
        ["playPause", "Media player play / pause", "⏯"],
      ].map(([key, label, symbol]) => ({
        id: "native.player." + key,
        label,
        symbol,
        group: "Media player",
        available:
          providers.includes(provider) &&
          !!getController()?.control &&
          (key !== "playPause" || paused(provider) !== null),
        parameters: { type: "object", properties: {}, additionalProperties: false },
        defaults: {},
        description:
          "Controls the selected native music player directly on the RaveLink PC. Embedded players use their request controls.",
      }));
    },
    async execute(id, signal) {
      if (signal?.aborted) throw fault("control_deck_cancelled");
      const [selected, playback] = await Promise.all([
          feature("song.player.preferences.v1", "status", null),
          feature("song.playback.read.v1", "status", null),
        ]),
        provider = providerFor(selected.value, playback.value);
      if (
        !selected.ok ||
        !playback.ok ||
        !providers.includes(provider) ||
        !getController()?.control
      )
        throw fault("media_player_unavailable");
      let action = id.slice("native.player.".length);
      if (action === "playPause") {
        const current = playback.value?.primary;
        if (
          current?.provider !== provider ||
          !["playing", "paused"].includes(current.status) ||
          !Number.isFinite(current.observedAt) ||
          Date.now() - current.observedAt >= 15000
        )
          throw fault("media_playback_state_unknown");
        action = current.status === "paused" ? "resume" : "pause";
      }
      if (!["pause", "resume", "next", "previous"].includes(action))
        throw fault("desktop_media_invalid");
      if (signal?.aborted) throw fault("control_deck_cancelled");
      const reply = await getController().control({ provider, action });
      if (!reply.ok) throw fault(reply.error || "media_control_rejected");
      return reply;
    },
  };
};
