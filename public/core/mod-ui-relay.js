/** Only the currently opened opaque sandbox can call its own approved host API. */
import "./browser-random-id.js";

export function initModUiRelay(frame) {
  const flights = new Set();
  let nonce = "",
    modId = "";
  function close() {
    nonce = "";
    modId = "";
    for (const controller of flights) controller.abort();
    flights.clear();
    frame.src = "about:blank";
  }
  window.addEventListener("message", async (event) => {
    const value = event.data;
    if (
      event.source !== frame.contentWindow ||
      event.origin !== "null" ||
      !nonce ||
      value?.nonce !== nonce ||
      value.type !== "ravelink.mod.call"
    )
      return;
    if (!Number.isSafeInteger(value.id) || value.id < 1 || flights.size >= 8) return;
    try {
      if (JSON.stringify(value).length > 32768) return;
    } catch {
      return;
    }
    const current = nonce,
      owner = modId,
      controller = new AbortController();
    flights.add(controller);
    let result;
    try {
      const response = await fetch(`/api/mod-platform/${encodeURIComponent(owner)}/ui-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          capability: value.capability,
          method: value.method,
          payload: value.payload,
        }),
      });
      result = await response.json();
    } catch {
      result = { ok: false, error: "mod_ui_call_failed" };
    } finally {
      flights.delete(controller);
    }
    if (nonce === current)
      frame.contentWindow.postMessage(
        { type: "ravelink.mod.result", nonce, id: value.id, result },
        "*",
      );
  });
  return {
    open(id, panel) {
      close();
      nonce = globalThis.RaveLinkRandomId();
      modId = id;
      frame.src = `/mods-ui/${encodeURIComponent(id)}/${encodeURIComponent(panel)}#ravelinkRelay=${encodeURIComponent(nonce)}`;
    },
    close,
  };
}
