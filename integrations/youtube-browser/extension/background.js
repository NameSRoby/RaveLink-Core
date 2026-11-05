/** Shared Firefox/Chromium background. Only the extension popup or authenticated local connect page may pair a tab;
 * only that tab's top frame may exchange state. Page scripts never see the token.
 * Owner identity uses session storage so browser restart cannot select a reused
 * tab ID silently. Local storage holds pairing configuration until Disconnect.
 */
if (typeof importScripts === "function") importScripts("native-service.js");
(() => {
  const api = globalThis.browser || globalThis.chrome;
  let exchanging = false,
    generation = 0;
  let configuration = Promise.resolve();
  async function nativeCall(sender, command) {
    if (!api.scripting?.executeScript || typeof globalThis.RaveLinkYouTubeNative !== "function")
      return null;
    try {
      const results = await api.scripting.executeScript({
        target: { tabId: sender.tab.id, frameIds: [0] },
        world: "MAIN",
        func: globalThis.RaveLinkYouTubeNative,
        args: [command],
      });
      return results[0]?.result || null;
    } catch {
      return null;
    }
  }
  function isPairingPage(message, sender) {
    let valid = false;
    try {
      const url = new URL(sender.url);
      valid =
        sender.frameId === 0 &&
        Boolean(sender.tab) &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.pathname === "/connect.html" &&
        Number(url.port) === message.port &&
        /^[a-f0-9]{64}$/.test(message.token || "");
    } catch {}
    return valid;
  }
  async function handle(message, sender) {
    if (sender.id !== api.runtime.id) return { paired: false };
    const pairingPage = isPairingPage(message, sender);
    if (pairingPage && message.type === "pairing-tabs") {
      const response = await fetch(`http://127.0.0.1:${message.port}/api/status`, {
        headers: { Authorization: `Bearer ${message.token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        return {
          error: "This connection has expired. Return to RaveLink Setup and connect again.",
        };
      const state = await response.json();
      if (state.prototype !== true || state.protocolVersion !== 1)
        return { error: "Update the companion and reconnect from RaveLink." };
      if (state.paired)
        return {
          error: "A music tab is already connected. Use Disconnect in RaveLink before changing it.",
        };
      const tabs = await api.tabs.query({ url: "https://music.youtube.com/*" });
      return {
        tabs: tabs
          .filter(
            (tab) => Number.isInteger(tab.id) && tab.url?.startsWith("https://music.youtube.com/"),
          )
          .map((tab) => ({
            id: tab.id,
            title: String(tab.title || "YouTube Music").slice(0, 160),
          })),
      };
    }
    if (pairingPage && message.type === "pairing-connect")
      message = { ...message, type: "connect" };
    if (
      (sender.url === api.runtime.getURL("popup.html") && !sender.tab) ||
      (pairingPage && message.type === "connect")
    ) {
      if (message.type === "disconnect") {
        // Invalidate already-running fetches before awaiting any remote work.
        generation++;
        const { connection } = await api.storage.local.get("connection");
        const { owner } = await api.storage.session.get("owner");
        if (connection && owner) {
          await nativeCall({ tab: { id: owner.tabId } }, { action: "retire" });
          try {
            await fetch(`${connection.base}/api/disconnect`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${connection.token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ clientId: owner.clientId }),
              signal: AbortSignal.timeout(5000),
            });
          } catch {
            /* Always stop local exchanges, even if the console is gone. */
          }
        }
        await api.storage.local.remove("connection");
        await api.storage.session.remove("owner");
        return { paired: false };
      }
      if (message.type === "connect") {
        if (
          !Number.isInteger(message.port) ||
          message.port < 1024 ||
          message.port > 65535 ||
          !/^[a-f0-9]{64}$/.test(message.token || "")
        )
          return { error: "Return to RaveLink Setup and connect again." };
        if (pairingPage && !Number.isInteger(message.tabId))
          return { error: "Select a music tab first." };
        const tab =
          pairingPage && Number.isInteger(message.tabId)
            ? await api.tabs.get(message.tabId)
            : (await api.tabs.query({ active: true, currentWindow: true }))[0];
        if (!tab?.id || !tab.url?.startsWith("https://music.youtube.com/"))
          return { error: "Open YouTube Music, then connect from that tab." };
        const connection = { base: `http://127.0.0.1:${message.port}`, token: message.token };
        const check = await fetch(`${connection.base}/api/status`, {
          headers: { Authorization: `Bearer ${connection.token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!check.ok)
          return { error: "Connection expired. Return to RaveLink Setup and connect again." };
        const state = await check.json();
        if (state.prototype !== true || state.protocolVersion !== 1)
          return {
            error:
              "Console and extension versions differ. Restart the console and reload the extension.",
          };
        if (state.paired)
          return {
            error:
              "A music tab is already connected. Disconnect it in RaveLink before changing it.",
          };
        const owner = { tabId: tab.id, clientId: crypto.randomUUID() };
        const paired = await fetch(`${connection.base}/api/pair`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ clientId: owner.clientId }),
          signal: AbortSignal.timeout(5000),
        });
        if (!paired.ok)
          return { error: "Another tab acquired the console. Disconnect it before pairing." };
        generation++;
        await api.storage.local.set({ connection });
        await api.storage.session.set({ owner });
        try {
          await api.tabs.sendMessage(tab.id, { type: "wake" });
        } catch {
          // A tab opened before installation/reload has no controller yet.
          // Install our isolated scripts without reloading the site or its queue.
          if (api.scripting?.executeScript) {
            await api.scripting.executeScript({
              target: { tabId: tab.id, frameIds: [0] },
              files: ["site-adapter.js", "content.js"],
            });
          }
        }
        return { paired: true };
      }
      if (message.type === "status")
        return { paired: Boolean((await api.storage.session.get("owner")).owner) };
      return { paired: false };
    }
    if (
      message.type !== "tick" ||
      sender.frameId !== 0 ||
      !sender.url?.startsWith("https://music.youtube.com/")
    )
      return { paired: false };
    const startedGeneration = generation;
    const { owner } = await api.storage.session.get("owner");
    const { connection } = await api.storage.local.get("connection");
    if (!owner || owner.tabId !== sender.tab?.id || !connection) return { paired: false };
    if (exchanging) return { paired: true };
    exchanging = true;
    try {
      const native = await nativeCall(sender, { action: "inspect" });
      const snapshot = { ...message.snapshot };
      if (native?.ok && native.native?.available) {
        const observed = native.snapshot || {};
        if (native.native.queueRead) {
          snapshot.queue = observed.queue;
          snapshot.queueComplete = observed.queueComplete;
        }
        for (const field of [
          "current",
          "paused",
          "position",
          "duration",
          "volume",
          "mediaReady",
          "ad",
        ])
          if (observed[field] !== undefined) snapshot[field] = observed[field];
        snapshot.native = native.native;
      }
      const response = await fetch(`${connection.base}/api/exchange`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientId: owner.clientId,
          snapshot,
          result: message.result,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { paired: false };
      const result = await response.json();
      const current = (await api.storage.session.get("owner")).owner;
      if (
        generation !== startedGeneration ||
        current?.clientId !== owner.clientId ||
        current?.tabId !== owner.tabId
      )
        return { paired: false };
      if (
        result.command &&
        (native?.native?.available || ["append", "remove"].includes(result.command.action))
      ) {
        const command = {
          ...result.command,
          nativeDocumentId: result.command.nativeDocumentId || native?.native?.documentId,
        };
        const executed = await nativeCall(sender, command);
        result.commandResult = {
          id: command.id,
          sessionId: command.sessionId,
          ...(executed || { ok: false, error: "control_unconfirmed" }),
        };
        result.command = null;
        if (generation !== startedGeneration) return { paired: false };
      }
      return { paired: true, ...result };
    } finally {
      exchanging = false;
    }
  }
  // Returning a Promise from onMessage is not consistent across Chromium
  // versions. The explicit response callback is supported by both browser families.
  api.runtime.onMessage.addListener((message, sender, respond) => {
    const configRequest =
      sender.id === api.runtime.id &&
      ((sender.url === api.runtime.getURL("popup.html") &&
        !sender.tab &&
        ["connect", "disconnect"].includes(message?.type)) ||
        (message?.type === "pairing-connect" && isPairingPage(message, sender)));
    // Serialize configuration changes: a slow Connect must finish before a
    // following Disconnect clears it. Invalidate old responses immediately,
    // even when Disconnect is waiting for the in-flight pairing handshake.
    if (configRequest && message.type === "disconnect") generation++;
    const operation = configRequest
      ? configuration.then(() => handle(message, sender))
      : handle(message, sender);
    if (configRequest) configuration = operation.catch(() => {});
    operation.then(respond, () =>
      respond({
        error: "Connection unavailable. Check that RaveLink is running.",
        paired: false,
      }),
    );
    return true;
  });
})();
