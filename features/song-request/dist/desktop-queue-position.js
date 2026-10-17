/**
 * Desktop queue position.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
module.exports = async function desktopQueuePosition(queue, provider, submitted, readStatus) {
  if (!submitted.ok || !submitted.entry) return submitted;
  try {
    const status = await readStatus();
    if (!status?.ok) return { ...submitted, position: undefined };
    const first = queue.status({ provider, limit: 25 }),
      waiting = [...first.queue];
    for (let offset = 25; offset < Math.min(200, first.counts.queued); offset += 25)
      waiting.push(...queue.status({ provider, offset, limit: 25 }).queue);
    const localIds = new Set(waiting.map((row) => row.id)),
      id = submitted.entry.id;
    const native = (status.handoffs || []).filter(
      (row) =>
        ["appended", "pending", "unknown"].includes(row.phase) &&
        (!row.uid || row.uid !== status.current?.uid),
    );
    const ownNative = native.findIndex((row) => row.entryId === id),
      ownLocal = waiting.findIndex((row) => row.id === id);
    if (ownNative < 0 && ownLocal < 0) return { ...submitted, position: undefined };
    const ahead = (ownNative < 0 ? native : native.slice(0, ownNative)).filter(
      (row) => row.entryId !== id && !localIds.has(row.entryId),
    );
    return {
      ...submitted,
      position: new Set(ahead.map((row) => row.entryId)).size + Math.max(0, ownLocal) + 1,
    };
  } catch {
    return { ...submitted, position: undefined };
  }
};
