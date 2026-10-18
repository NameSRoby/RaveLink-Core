/** Restore observation from the explicit player preference, independently of a
 * possibly older playback snapshot. Starting an observer never launches a music
 * app, resumes playback or redelivers queued requests. Local players stop a
 * previous desktop observer when the feature is restarted without restarting Core.
 */
module.exports = async function restorePlayer({ preferences, queue, context }) {
  const selection = await preferences("status", null);
  if (!selection.ok) return selection;
  const source = selection.player;
  queue.configurePlaybackSource({ source, suspend: true });
  const control = (payload) =>
    context.callCapability("media.windows.now-playing.v1", "control", payload, { timeoutMs: 1000 });
  try {
    if (["tidal", "spotify"].includes(source)) {
      const selected = await control({ action: "select", provider: source });
      return selected?.ok ? await control({ action: "start" }) : selected;
    }
    return await control({ action: "stop" });
  } catch {
    return { ok: false, code: "windows_media_observer_unavailable" };
  }
};
