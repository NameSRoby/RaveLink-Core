/** TIDAL owns its saved WASAPI gain. Session-only writes are reset at track start.
 * Other apps keep the Windows mixer path; never replay an uncertain native write.
 */
const { fault } = require("./control-deck-config");
module.exports = function nativeAppVolume(getRegistry) {
  return async (row, level, signal) => {
    if (row?.kind !== "app" || !/^tidal(?:player)?(?:\.exe)?$/i.test(row.name)) return false;
    const registry = getRegistry();
    if (
      !registry
        ?.list()
        .features?.some((item) => item.id === "song-request" && item.lifecycle === "active")
    )
      return false;
    const call = (method, payload) =>
      registry.request("song-request", "song.tidal.experimental.v1", method, payload, {
        timeoutMs: 6000,
      });
    const status = await call("status", null);
    if (!status.ok || !status.value?.connected || !status.value?.volumeAvailable) return false;
    if (signal?.aborted) throw fault("control_deck_cancelled");
    const result = await call("volume", { percent: level });
    if (!result.ok || result.value?.ok !== true || result.value.percent !== level)
      throw fault("audio_native_change_unconfirmed");
    return true;
  };
};
