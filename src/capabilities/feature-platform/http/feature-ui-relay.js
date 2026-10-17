/**
 * Feature iframe relay — browser code serialized into the parent shell.
 * Keep every browser dependency inside this function: require() runs in Node,
 * while this function body executes in the browser after toString().
 * The sandboxed child has an opaque origin, so identify it by event.source;
 * messages from the surrounding HUD additionally require the same origin.
 */
module.exports = function installFeatureRelay(config) {
  const frame = document.getElementById("surface");
  const allowed = new Set(config.capabilities);
  const channel = "ravelink-feature-ui-v1";
  // These budgets match capability work, not HTTP transport defaults. Transfers
  // can page a provider; ordinary display reads should fail promptly. The abort
  // below adds 750 ms so the host can return its own timeout disposition first.
  const callTimeouts = {
    "song.player.preferences.v1": 12000,
    "song.playlist.transfer.v1": 55000,
    "song.soundcloud.player.v1": 30000,
    "song.spotify.player.v1": 30000,
    "song.queue.submit.v1": 30000,
    "song.catalog.admin.v1": 30000,
    "song.tidal.experimental.v1": 30000,
  };
  let preview = null;
  frame.addEventListener("load", () => {
    if (preview) frame.contentWindow.postMessage(preview, "*");
    const launch = new URL(location.href);
    if (
      config.featureId === "song-request" &&
      config.pageId === "player" &&
      launch.searchParams.get("startPlayback") === "1"
    ) {
      frame.contentWindow.postMessage(
        {
          channel,
          type: "playlist-start",
          provider: launch.searchParams.get("provider"),
        },
        "*",
      );
      history.replaceState(null, "", location.pathname);
    }
    if (window.parent !== window)
      window.parent.postMessage({ channel, type: "feature-ready" }, location.origin);
  });
  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (message?.channel !== channel) return;
    if (
      event.source === window.parent &&
      window.parent !== window &&
      event.origin === location.origin &&
      message.type === "playlist-start" &&
      config.featureId === "song-request" &&
      config.pageId === "player" &&
      ["youtube", "soundcloud"].includes(message.provider)
    ) {
      frame.contentWindow.postMessage(
        { channel, type: "playlist-start", provider: message.provider },
        "*",
      );
      return;
    }
    if (
      event.source === window.parent &&
      window.parent !== window &&
      event.origin === location.origin &&
      message.type === "presentation"
    ) {
      if (config.surface === "panel") {
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";
        frame.style.background = "transparent";
        frame.contentWindow.postMessage(message, "*");
      }
      return;
    }
    if (
      event.source === window.parent &&
      config.pageId === "obs-overlay" &&
      message.type === "preview"
    ) {
      preview = { channel, type: "preview", config: message.config };
      frame.contentWindow.postMessage(preview, "*");
      return;
    }
    // Child messages are only trusted from this exact frame. A sandboxed frame
    // may report origin "null", so checking origin alone cannot identify it.
    if (event.source !== frame.contentWindow) return;
    if (message.type === "feature-height") {
      if (
        config.surface === "panel" &&
        message.contentHeight === true &&
        Number.isFinite(message.height) &&
        message.height > 0
      ) {
        const height = Math.max(240, Math.min(16000, Math.ceil(message.height)));
        frame.style.height = height + "px";
        if (window.parent !== window)
          window.parent.postMessage({ channel, type: "feature-height", height }, location.origin);
        else {
          document.body.style.height = "auto";
          document.body.style.overflow = "auto";
        }
      }
      return;
    }
    if (message.type === "open" && config.pageIds.includes(message.pageId)) {
      const startPlayback =
        config.featureId === "song-request" &&
        config.pageId === "server-playlist" &&
        message.pageId === "player" &&
        message.startPlayback === true &&
        ["youtube", "soundcloud"].includes(message.provider);
      if (window.parent !== window) {
        window.parent.postMessage(
          {
            channel,
            type: "feature-open",
            pageId: message.pageId,
            ...(startPlayback ? { startPlayback: true, provider: message.provider } : {}),
          },
          location.origin,
        );
        return;
      }
      if (startPlayback) {
        location.assign(
          "/features-ui/song-request/player?startPlayback=1&provider=" + message.provider,
        );
        return;
      }
      window.open(
        "/features-ui/" + config.featureId + "/" + message.pageId,
        "ravelink-" + config.featureId + "-" + message.pageId,
        "noopener",
      );
      return;
    }
    if (message.type === "action-feedback") {
      if (
        ["working", "success", "error"].includes(message.state) &&
        typeof message.message === "string"
      )
        window.RaveLinkFeedback.show(message.message.slice(0, 240), message.state);
      return;
    }
    if (message.type !== "call" || !allowed.has(message.capability))
      return frame.contentWindow.postMessage(
        {
          channel,
          id: message.id,
          type: "response",
          ok: false,
          error: "capability_denied",
        },
        "*",
      );
    const callTimeoutMs =
      message.capability === "song.queue.admin.v1" && message.method === "moderate"
        ? 20000
        : message.capability === "twitch.redemptions.v1" && message.method === "reconcile"
          ? 30000
          : callTimeouts[message.capability] || 2500;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), callTimeoutMs + 750);
    try {
      const response = await fetch("/api/features/" + config.featureId + "/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability: message.capability,
          method: message.method,
          payload: message.payload,
          timeoutMs: callTimeoutMs,
        }),
        signal: controller.signal,
      });
      const body = await response.json();
      const succeeded = response.ok && body.ok === true;
      frame.contentWindow.postMessage(
        {
          channel,
          id: message.id,
          type: "response",
          ok: succeeded,
          value: body.value,
          error: body.error?.message || body.error || "HTTP " + response.status,
        },
        "*",
      );
      if (succeeded && window.parent !== window)
        window.parent.postMessage(
          {
            channel,
            type: "feature-call-complete",
            featureId: config.featureId,
            capability: message.capability,
            method: String(message.method || ""),
          },
          location.origin,
        );
    } catch (error) {
      frame.contentWindow.postMessage(
        {
          channel,
          id: message.id,
          type: "response",
          ok: false,
          error: String(error?.message || error).slice(0, 160),
        },
        "*",
      );
    } finally {
      clearTimeout(timeout);
    }
  });
  let unsubscribeEvents;
  function connectEvents() {
    if (unsubscribeEvents) return;
    unsubscribeEvents = window.ravelinkFeatureEvents.subscribe(
      { featureId: config.featureId, capabilities: config.capabilities },
      (message) => {
        if (message.type === "feature" && allowed.has(message.value.capability))
          frame.contentWindow.postMessage({ channel, type: "event", message: message.value }, "*");
        if (message.type === "error")
          frame.contentWindow.postMessage({ channel, type: "transport-error" }, "*");
        if (message.type === "resync")
          frame.contentWindow.postMessage({ channel, type: "resync" }, "*");
      },
    );
  }
  connectEvents();
  window.addEventListener("pagehide", () => {
    unsubscribeEvents?.();
    unsubscribeEvents = null;
  });
  window.addEventListener("pageshow", connectEvents);
  // Install message handlers and the shared event subscription before navigation.
  // Fast local documents can call the broker during their first script; assigning
  // src in the HTML used to lose that initial request before the relay existed.
  frame.src = frame.dataset.src;
};
