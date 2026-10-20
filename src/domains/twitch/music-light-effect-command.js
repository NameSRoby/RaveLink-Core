/** Trusted handoff after dynamic route/cooldown admission. This adapter carries
 * only palette, timing and target intent; it cannot grant capture or select an
 * audio source. Preflight must succeed before an older effect is disturbed.
 */
module.exports = async function runMusicEffect({
  handler,
  command,
  fixtures,
  settings,
  isCurrent,
  stopFixtures,
  setCooldown,
  now,
}) {
  if (!handler) return { matched: true, ok: false, error: "music_rave_unavailable" };
  try {
    const request = {
      fixtureIds: fixtures.map((f) => f.id),
      palette: command.colors.map(
        (c) => "#" + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join(""),
      ),
      feel: command.speed,
      brightnessLimit: settings.brightnessLimit,
      ...(settings.durationSeconds > 0
        ? { seconds: Math.min(3600, Math.max(1, Math.round(settings.durationSeconds))) }
        : {}),
    };
    await handler.check?.(request);
    if (!isCurrent()) return { matched: true, ok: false, error: "music_request_superseded" };
    stopFixtures(request.fixtureIds, { force: true, animate: false });
    const result = await handler.start(request);
    if (settings.cooldownSeconds > 0)
      for (const id of result.targets) setCooldown(id, now() + settings.cooldownSeconds * 1000);
    return { matched: true, effect: "rave", ...result, sent: 0, failed: 0 };
  } catch (error) {
    return {
      matched: true,
      ok: false,
      error: /^[a-z_]{1,80}$/.test(error.code || error.message || "")
        ? error.code || error.message
        : "music_rave_failed",
    };
  }
};
module.exports.stopRouted = async function stopRouted(handler, ids, preview) {
  const selected = (handler?.ids() || []).filter((id) => ids.includes(id));
  if (!preview) await handler?.stop(ids);
  return selected;
};
module.exports.cancelRemoved = function cancelRemoved(handler, next, supervise) {
  const removed = (handler?.ids() || []).filter(
    (id) => !next.enabled || !next.fixtureIds.includes(id),
  );
  if (removed.length) supervise(() => handler.stop(removed), "music-policy", "");
};
