/**
 * Tidal native moderation.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#startup-and-shutdown
 */
module.exports = function createNativeModeration({
  receipts,
  commands,
  status,
  finish,
  now,
  timeoutMs,
}) {
  return function remove(input = {}) {
    const selected = [...receipts.values()].filter(
      (row) =>
        ["appended", "playing", "unknown"].includes(row.phase) &&
        (input.entryId
          ? row.entryId === input.entryId
          : input.requesterKey
            ? row.requesterKey === input.requesterKey
            : input.trackId
              ? row.trackId === input.trackId
              : false),
    );
    const state = status(),
      fail = (error) => ({ ok: false, error });
    if (input.currentUid) {
      if (state.current?.uid !== input.currentUid || state.current.trackId !== input.trackId)
        return Promise.resolve(fail("tidal_current_changed"));
      if (!selected.some((row) => row.uid === input.currentUid))
        selected.push({ uid: input.currentUid, trackId: input.trackId });
    }
    if (!selected.length) return Promise.resolve({ ok: true, removed: 0 });
    if (!state.connected || !state.ready)
      return Promise.resolve(fail("tidal_companion_unavailable"));
    if (!state.controlsAvailable) return Promise.resolve(fail("tidal_companion_update_required"));
    if (selected.some((row) => !row.uid))
      return Promise.resolve(fail("tidal_handoff_needs_review"));
    if (commands.size) return Promise.resolve(fail("tidal_bridge_busy"));
    const commandId = require("node:crypto").randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => finish(commandId, fail("tidal_remove_unconfirmed")),
        timeoutMs || 8000,
      );
      timer.unref?.();
      commands.set(commandId, {
        id: commandId,
        kind: "remove",
        trackId: selected[0].trackId,
        targets: selected.map((row) => ({
          uid: row.uid,
          trackId: row.trackId,
        })),
        expiresAt: now() + (timeoutMs || 8000),
        delivered: false,
        resolve,
        timer,
      });
    });
  };
};
