/** Restore the independent overlay selection. Observation never starts playback
 * or redelivers queued requests; Automatic can follow any supported active player.
 */
module.exports = async function restorePlayer({ preferences, queue, context }) {
  const selection = await preferences("status", null);
  if (!selection.ok) return selection;
  const source = queue.playbackStatus().playbackSource;
  queue.configurePlaybackSource({ source, suspend: true });
  const control = (payload) =>
    context.callCapability("media.windows.now-playing.v1", "control", payload, { timeoutMs: 1000 });
  try {
    if (["auto", "tidal", "spotify", "apple-music"].includes(source)) {
      const selected = await control({ action: "select", provider: source });
      return selected?.ok ? await control({ action: "start" }) : selected;
    }
    return await control({ action: "stop" });
  } catch {
    return { ok: false, code: "windows_media_observer_unavailable" };
  }
};
