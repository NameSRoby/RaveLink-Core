/**
 * Feature theme script.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#request-security-and-the-feature-ui-relay
 */
function overlayThemeHost() {
  const frame = document.getElementById("surface"),
    channel = "ravelink-feature-ui-v1";
  let theme = null,
    timer = null,
    closed = false;
  function send() {
    if (theme) frame.contentWindow.postMessage({ channel, type: "theme", theme }, "*");
  }
  frame.addEventListener("load", send);
  async function refresh() {
    if (closed) return;
    try {
      const r = await fetch("/api/presentation/theme", { cache: "no-store" }),
        body = await r.json();
      if (body.ok && JSON.stringify(theme) !== JSON.stringify(body.theme)) {
        theme = body.theme;
        send();
      }
    } catch {
    } finally {
      if (!closed) timer = setTimeout(refresh, 3000);
    }
  }
  addEventListener("message", (event) => {
    if (
      event.source !== parent ||
      parent === window ||
      event.origin !== location.origin ||
      event.data?.channel !== channel ||
      event.data.type !== "presentation"
    )
      return;
    const next = event.data.theme || {};
    if (/^#[0-9a-f]{6}$/i.test(next.accent || "")) {
      if (JSON.stringify(theme) !== JSON.stringify(next)) {
        theme = next;
        send();
      }
    }
  });
  addEventListener("pagehide", () => {
    closed = true;
    clearTimeout(timer);
  });
  addEventListener("pageshow", () => {
    if (closed) {
      closed = false;
      void refresh();
    }
  });
  void refresh();
}
module.exports = (featureId, pageId) =>
  featureId === "song-request" && ["obs-overlay", "overlay-editor"].includes(pageId)
    ? `(${overlayThemeHost.toString()})();`
    : "";
