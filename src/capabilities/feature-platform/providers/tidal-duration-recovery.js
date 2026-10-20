/** Recover metadata omitted by older handoff journals without replaying delivery.
 * At most one read runs at a time, once per distinct track per bridge lifetime.
 * The caller starts recovery only while its command queue is idle. Failed reads
 * leave timing unknown; they must never turn into append or playback commands.
 */
module.exports = function durationRecovery({ entries, resolve, persist, isActive }) {
  const attempted = new Set();
  let busy = false;
  const valid = (value) => Number.isInteger(value) && value > 0 && value <= 86400000;
  return function recover() {
    if (busy || !isActive()) return;
    const row = [...entries.values()].find(
      (entry) =>
        ["appended", "playing"].includes(entry.phase) &&
        !valid(entry.durationMs) &&
        !attempted.has(entry.trackId),
    );
    if (!row) return;
    attempted.add(row.trackId);
    busy = true;
    // Resolve is the companion's existing metadata-only operation. This promise
    // is detached from polling, bounded by the bridge deadline and always caught.
    Promise.resolve()
      .then(() => resolve(row.trackId))
      .then((result) => {
        const candidate = result?.candidate;
        if (
          !isActive() ||
          !result?.ok ||
          candidate?.providerItemId !== row.trackId ||
          !valid(candidate.durationMs)
        )
          return;
        for (const entry of entries.values())
          if (entry.trackId === row.trackId) entry.durationMs = candidate.durationMs;
        persist();
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  };
};
