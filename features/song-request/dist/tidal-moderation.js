/**
 * Tidal moderation.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
module.exports = function createTidalModeration({
  queue,
  provider,
  changed,
  waitForDelivery,
  providerName = "tidal",
}) {
  return async function moderate(payload, waiting) {
    let status;
    try {
      status = await provider("status", null);
    } catch {
      status = {};
    }
    if (payload.currentUid && payload.currentUid !== status?.current?.uid)
      return {
        ok: false,
        code: "rejected",
        reason: providerName + "_current_changed",
      };
    const entry =
      waiting.find((row) => row.id === payload.entryId) ||
      status?.handoffs?.find((row) => row.entryId === payload.entryId) ||
      (payload.currentUid ? status?.current : null);
    const action = payload.action,
      trackId = entry?.candidate?.providerItemId || entry?.trackId || payload.providerItemId;
    let result;
    if (["remove", "skip"].includes(action) && !waiting.some((row) => row.id === payload.entryId)) {
      result = entry
        ? { ok: true, code: "removed", entryId: payload.entryId }
        : { ok: false, code: "rejected", reason: "entry_not_found" };
    } else
      result = queue.moderate({
        ...payload,
        ...(["block_song", "timeout_song"].includes(action) && trackId
          ? { provider: providerName, providerItemId: trackId }
          : {}),
      });
    if (!result.ok) return result;
    changed(result);
    if (!["remove", "skip", "block_song", "timeout_song", "block", "timeout"].includes(action))
      return result;
    // Block admission locally first, drain an already dispatched insertion, then
    // remove only matching recorded native UIDs. Never clear the user's playlist.
    await waitForDelivery();
    const selection = ["block", "timeout"].includes(action)
      ? { requesterKey: payload.requesterKey }
      : ["block_song", "timeout_song"].includes(action)
        ? {
            trackId,
            ...(payload.currentUid ? { currentUid: payload.currentUid } : {}),
          }
        : { entryId: payload.entryId };
    if (!Object.values(selection).some(Boolean)) return result;
    let removal;
    try {
      removal = await provider("remove", selection);
    } catch {
      removal = { ok: false, error: providerName + "_companion_unavailable" };
    }
    const native = status?.handoffs?.some(
      (row) =>
        ["appended", "playing", "unknown", "pending"].includes(row.phase) &&
        (selection.entryId
          ? row.entryId === selection.entryId
          : selection.trackId
            ? row.trackId === selection.trackId
            : row.requesterKey === selection.requesterKey),
    );
    if (
      !removal?.ok &&
      (native ||
        payload.currentUid ||
        (entry && !waiting.some((row) => row.id === payload.entryId)))
    )
      return {
        ...result,
        code: providerName + "_moderation_partial",
        nativeError: removal?.error || providerName + "_remove_unconfirmed",
      };
    changed(result);
    return { ...result, nativeRemoved: removal?.removed || 0 };
  };
};
