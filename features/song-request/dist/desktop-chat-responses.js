/**
 * Desktop chat responses.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
// A desktop handoff confirms queue insertion, not playback. Announce only when
// the companion identifies that exact request as the current native occurrence.
module.exports = function createDesktopChatResponses({ context, send, started = async () => {} }) {
  const key = "desktop-chat-state-v1",
    entries = new Map();
  let checking = false;
  const supported = (entry) => ["tidal", "spotify"].includes(entry?.candidate?.provider);
  const store = async () => {
    try {
      await context.callCapability(
        "ravelink.storage.v1",
        "set",
        { key, value: [...entries.values()] },
        { timeoutMs: 1000 },
      );
    } catch {}
  };
  async function load() {
    try {
      const saved = await context.callCapability(
        "ravelink.storage.v1",
        "get",
        { key },
        { timeoutMs: 1000 },
      );
      if (saved?.ok && Array.isArray(saved.value))
        for (const entry of saved.value.slice(-100)) {
          if (
            supported(entry) &&
            typeof entry.id === "string" &&
            typeof entry.candidate.title === "string"
          )
            entries.set(entry.id, entry);
        }
    } catch {}
  }
  async function record(entry) {
    if (!supported(entry) || !entry.chatNotify || entries.has(entry.id)) return;
    entries.set(entry.id, {
      id: entry.id,
      requesterLabel: entry.requesterLabel,
      candidate: {
        provider: entry.candidate.provider,
        title: entry.candidate.title,
        artists: entry.candidate.artists || [],
      },
      announced: false,
    });
    while (entries.size > 100) entries.delete(entries.keys().next().value);
    await store();
  }
  async function observe(observation) {
    const provider = observation?.provider;
    if (
      checking ||
      observation?.available === false ||
      observation?.status !== "playing" ||
      ![...entries.values()].some(
        (entry) => !entry.announced && entry.candidate.provider === provider,
      )
    )
      return;
    checking = true;
    try {
      const capability =
        provider === "tidal" ? "tidal.desktop.experimental.v1" : "spotify.desktop.host.v1";
      const status = await context.callCapability(capability, "status", null, {
        timeoutMs: 1000,
      });
      const current = status?.current;
      if (!status?.ok || !current || current.paused === true) return;
      const receipt = (status.handoffs || []).find(
        (row) => row.phase === "playing" && row.uid && row.uid === current.uid,
      );
      const entry = entries.get(current.entryId || receipt?.entryId);
      if (!entry || entry.announced || entry.candidate.provider !== provider) return;
      await started(entry);
      entry.announced = true;
      await store();
      send(
        { method: "acknowledge", payload: {} },
        { ok: true, code: "started", notifyChat: true, entry },
      );
    } catch {
    } finally {
      checking = false;
    }
  }
  return { load, record, observe };
};
