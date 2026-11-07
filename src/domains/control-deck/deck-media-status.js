/** Public music information only; never forward leases, requester keys or drivers. */
const text = (v, n = 200) =>
  typeof v === "string" ? v.replace(/[\x00-\x1f]/g, " ").slice(0, n) : "";
function track(row) {
  if (!row) return null;
  const item = row.candidate || row;
  if (!item.title) return null;
  const artwork = text(item.artworkUrl, 12288);
  return {
    title: text(item.title),
    artists: (item.artists || []).slice(0, 8).map((v) => text(v, 100)),
    provider: text(item.provider || row.provider, 40),
    artwork:
      /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(artwork) ||
      /^https:\/\/(?:i\.ytimg\.com|i\.scdn\.co|(?:[a-z0-9-]+\.)*sndcdn\.com|resources\.tidal\.com)\//.test(
        artwork,
      )
        ? artwork
        : "",
    requester: text(row.requesterLabel, 80),
    status: row.status,
    positionMs: Math.max(0, Number(row.positionMs) || 0),
    durationMs: Math.max(0, Number(row.durationMs || item.durationMs) || 0),
    observedAt: Number(row.observedAt) || 0,
  };
}
module.exports = function mediaStatus(state) {
  if (!state) return { available: false, current: null, next: [], queued: null };
  const playback = state.playback || {},
    primary = playback.primary;
  const native = state.nativeStatus?.current,
    receipts = state.nativeStatus?.handoffs || [];
  let current = track(primary);
  // Attribute a request only when the current playback owner supplies it.
  const receipt = receipts.find((row) => row.entryId === native?.entryId);
  if (
    current &&
    !current.requester &&
    native?.requesterLabel &&
    state.selectedPlayer === current.provider &&
    receipt?.title === current.title
  )
    current.requester = text(native.requesterLabel, 80);
  const queue = (state.queue?.queue || []).filter(
    (row) => row.id !== playback.managed?.entryId && row.id !== native?.entryId,
  );
  const nativeNext = (state.nativeStatus?.queueOrder || [])
    .filter((id) => id !== native?.entryId)
    .map((id) => receipts.find((row) => row.entryId === id))
    .filter(Boolean)
    .map((row) => ({ ...row, provider: state.selectedPlayer }));
  const managedIncluded = (state.queue?.queue || []).some(
    (row) => row.id === playback.managed?.entryId,
  );
  const reported = state.nativeStatus?.capacity?.queued,
    incomplete =
      Number.isInteger(reported) && reported > (state.nativeStatus?.queueOrder || []).length;
  return {
    available: true,
    current,
    next: [...nativeNext, ...queue].slice(0, 5).map(track).filter(Boolean),
    nativeQueueIncomplete: incomplete,
    queued:
      Math.max(0, (state.queue?.counts?.queued ?? queue.length) - (managedIncluded ? 1 : 0)) +
      (Number.isInteger(reported) ? reported : nativeNext.length),
    paused: state.queue?.paused === true,
  };
};
