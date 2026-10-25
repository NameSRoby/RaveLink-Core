/** Durable playback decisions. Queue handoff is not playback. Persist decisions
 * before calling Twitch; retry delivery without changing the first decision. */
module.exports = function createRewardOutcomes({ context }) {
  const entries = new Map();
  const storage = require("./reward-outcome-storage")(context, "song-reward-outcomes-v1");
  let timer,
    work,
    stopped = false;
  const store = () => storage.store(entries);
  function schedule() {
    if (!stopped && !timer && [...entries.values()].some((row) => row.status && !row.delivered)) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, 5000);
      timer.unref?.();
    }
  }
  async function flush() {
    if (stopped || work) return work;
    work = (async () => {
      await store();
      let sent = 0;
      for (const row of entries.values()) {
        if (stopped || sent >= 8) break;
        if (!row.status || row.delivered) continue;
        sent++;
        try {
          const result = await context.callCapability(
            "twitch.rewards.manage.v1",
            "song-outcome",
            {
              requestId: row.requestId,
              status: row.status,
              requesterName: row.requesterLabel,
            },
            { timeoutMs: 8000 },
          );
          if (result?.ok === true) {
            row.delivered = true;
            await store();
          }
        } catch {}
      }
    })()
      .catch(() => {})
      .finally(() => {
        work = null;
        schedule();
      });
    return work;
  }
  async function load() {
    try {
      for (const row of await storage.load())
        if (
          typeof row.id === "string" &&
          typeof row.requestId === "string" &&
          ["", "FULFILLED", "CANCELED"].includes(row.status)
        )
          entries.set(row.id, row);
    } catch {}
    schedule();
  }
  async function record(entry) {
    if (!entry?.id || !entry.requestId || entries.has(entry.id)) return;
    if (entries.size >= 1000) {
      const old = [...entries.values()].find((row) => row.delivered);
      if (!old) throw Error("reward_outcome_capacity");
      entries.delete(old.id);
    }
    entries.set(entry.id, {
      id: entry.id,
      requestId: entry.requestId,
      requesterLabel: entry.requesterLabel || "",
      status: "",
      delivered: false,
    });
    await store();
  }
  function mark(entry, status) {
    const row = entries.get(entry?.id || entry?.entryId);
    if (!row || row.status) return false;
    row.status = status;
    return true;
  }
  async function commit() {
    try {
      await store();
      void flush();
    } finally {
      schedule();
    }
  }
  async function decide(entry, status) {
    if (mark(entry, status)) await commit();
  }
  function before(request, queue) {
    return ["self", "moderate", "undo", "acknowledge", "settle"].includes(request.method)
      ? queue.exportSnapshot({ includePlaylist: false }).queue
      : [];
  }
  async function capture(request, result, previous, queue) {
    if (!result?.ok || result.nativeError || /_partial$/.test(result.code || "")) return;
    if (request.payload?.rewardRedemption === true && result.entry?.requestId)
      await record(result.entry);
    const payload = request.payload || {};
    if (request.method === "acknowledge" && ["started", "progress"].includes(payload.state)) {
      await decide(
        previous.find((row) => row.id === result.entryId),
        "FULFILLED",
      );
      return;
    }
    if (result.outcome === "handed_off") return;
    const removal =
      ["self", "undo", "settle"].includes(request.method) ||
      (request.method === "moderate" &&
        ["remove", "skip", "clear", "block", "timeout", "block_song", "timeout_song"].includes(
          payload.action,
        )) ||
      (request.method === "acknowledge" && ["ended", "failed", "skipped"].includes(payload.state));
    if (!removal) return;
    const remaining = new Set(
      queue.exportSnapshot({ includePlaylist: false }).queue.map((row) => row.id),
    );
    const removed = previous.filter((row) => {
      if (remaining.has(row.id)) return false;
      if (result.entryId) return row.id === result.entryId;
      if (payload.action === "clear") return true;
      if (["block", "timeout"].includes(payload.action))
        return row.requesterKey === queue.requesterModerationKey(payload);
      if (["block_song", "timeout_song"].includes(payload.action)) {
        const target = previous.find((entry) => entry.id === payload.entryId)?.candidate;
        return (
          row.candidate.provider === (target?.provider || payload.provider) &&
          row.candidate.providerItemId === (target?.providerItemId || payload.providerItemId)
        );
      }
      return false;
    });
    if (result.entry) removed.push(result.entry);
    let changed = false;
    for (const row of removed)
      changed =
        mark(
          row,
          payload.state === "ended" || result.outcome === "played" ? "FULFILLED" : "CANCELED",
        ) || changed;
    if (changed) await commit();
  }
  async function stop() {
    stopped = true;
    clearTimeout(timer);
    timer = null;
    await work;
  }
  return { load, record, decide, before, capture, stop, flush };
};
