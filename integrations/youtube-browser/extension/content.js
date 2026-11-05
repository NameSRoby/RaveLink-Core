/** Page-driven polling wakes both Firefox event pages and Chromium service workers.
 * There is no background interval whose lifetime depends on one browser's worker.
 * Credentials stay in the extension background; this isolated script gets commands
 * only. A lost acknowledgement is retried, but the playback action is not replayed.
 */
(() => {
  const api = globalThis.browser || globalThis.chrome;
  const site = globalThis.RaveLinkYouTubeSite.create(document, location);
  let running = false,
    timer,
    result = null,
    stopped = false;
  async function tick() {
    if (running || stopped) return;
    clearTimeout(timer);
    running = true;
    let delay = 1500;
    try {
      const response = await api.runtime.sendMessage({
        type: "tick",
        snapshot: site.read(),
        result,
      });
      if (response?.ack === result?.id) result = null;
      // Pairing a new bridge retires the old result. Otherwise an unacknowledged
      // result from the previous session swallows the new session's first lease.
      if (result && response?.sessionId && result.sessionId !== response.sessionId) result = null;
      if (response?.paired && response.commandResult && !result) result = response.commandResult;
      if (
        response?.paired &&
        response.command &&
        response.command.sessionId === response.sessionId &&
        !result
      ) {
        const command = response.command;
        result = { id: command.id, sessionId: command.sessionId, ...(await site.execute(command)) };
      }
      if (!response?.paired) delay = 10000;
    } catch {
      delay = 10000;
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, delay);
    }
  }
  api.runtime.onMessage.addListener((message) => {
    if (message?.type === "wake") void tick();
  });
  window.addEventListener("pagehide", () => {
    stopped = true;
    clearTimeout(timer);
  });
  window.addEventListener("pageshow", () => {
    stopped = false;
    void tick();
  });
  void tick();
})();
