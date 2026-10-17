/**
 * Player preferences.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
module.exports = function playerPreferences(context) {
  let player = "youtube",
    loaded = false,
    serial = Promise.resolve();
  async function handle(method, input) {
    try {
      if (!loaded) {
        let saved;
        try {
          saved = await context.callCapability(
            "ravelink.storage.v1",
            "get",
            { key: "player-preferences-v1" },
            { timeoutMs: 5000 },
          );
        } catch (error) {
          if (error.code !== "provider_unavailable") throw error;
        }
        if (saved?.ok === false) throw new Error("player_preferences_unavailable");
        if (["youtube", "tidal", "soundcloud", "spotify"].includes(saved?.value?.player))
          player = saved.value.player;
        loaded = true;
      }
      if (method === "select") {
        if (!["youtube", "tidal", "soundcloud", "spotify"].includes(input?.player))
          return { ok: false, code: "player_invalid" };
        const saved = await context.callCapability(
          "ravelink.storage.v1",
          "set",
          {
            key: "player-preferences-v1",
            value: { version: 1, player: input.player },
          },
          { timeoutMs: 5000 },
        );
        if (saved?.ok === false) throw new Error("player_preferences_unavailable");
        player = input.player;
      } else if (method !== "status")
        return { ok: false, code: "player_preferences_method_invalid" };
      return { ok: true, player };
    } catch {
      return { ok: false, code: "player_preferences_unavailable" };
    }
  }
  return (method, input) => {
    const operation = serial.then(() => handle(method, input));
    serial = operation.catch(() => {});
    return operation;
  };
};
