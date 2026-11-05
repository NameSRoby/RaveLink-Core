/** Optional playback in one explicitly paired tab. Never transfer cookies or stream URLs. */
/* exported installYoutubeBrowserPlayer */
function installYoutubeBrowserPlayer({
  selected,
  view,
  setupPage,
  playbackPage,
  choosePlayer,
  warning,
}) {
  let mode = "embed",
    state = null,
    timer = null,
    stopped = false,
    busy = false,
    refreshing = false;
  const setup = document.createElement("section");
  setup.id = "youtubeBrowserSetup";
  setup.innerHTML = `<h2>YouTube playback</h2><label>Playback connection<select id="youtubePlaybackMode"><option value="embed">Embedded player</option><option value="browser">YouTube Music browser extension (experimental)</option></select></label>
    <div id="youtubeBrowserInstructions" hidden>
      <p>Play requests in your YouTube Music tab. Your personal queue stays in place; requests are inserted after the current song in request order.</p>
      <section class="youtube-connection-step"><h3>1. Load the Firefox extension</h3>
      <p>Open the extension folder, then paste <strong>about:debugging#/runtime/this-firefox</strong> into Firefox's address bar. Choose <strong>Load Temporary Add-on</strong> and select <strong>manifest.json</strong> in that folder.</p>
      <button id="youtubeOpenFolder" type="button">Open Firefox extension folder</button> <button id="youtubeCopySetup" type="button">Copy Firefox setup address</button>
      <p>You only repeat this step after restarting Firefox while the extension is unsigned.</p></section>
      <section class="youtube-connection-step"><h3>2. Connect your music tab</h3>
      <p>Open <a href="https://music.youtube.com/" target="_blank" rel="noopener noreferrer">YouTube Music</a> in Firefox and play a song once. Then connect below and select that tab. Keep it open while using requests.</p>
      <button id="enableYoutubeBrowser" type="button">Connect YouTube Music</button> <button id="disableYoutubeBrowser" type="button">Disconnect</button>
      <p id="youtubeSetupStatus" role="status"></p><a id="youtubeConnectLink" hidden target="_blank" rel="noopener noreferrer">Open connection page</a></section>
      <p>Account, region, ads and subscription restrictions still apply. Reloading the music tab can require a delivery review.</p>
      <details><summary>Advanced / other browsers</summary><p>Chromium: load the Chromium folder using Load unpacked in your browser's extensions manager with Developer mode enabled.</p><button id="youtubeOpenChromiumFolder" type="button">Open Chromium extension folder</button><pre id="youtubeExtensionFolders"></pre>
      <div id="youtubePairing" hidden><label>Port<input id="youtubeBrowserPort" readonly></label><label>Private pairing code ? do not share<input id="youtubeBrowserCode" type="password" readonly autocomplete="off" spellcheck="false"></label></div></details>
    </div>`;
  setupPage.prepend(setup);
  const panel = document.createElement("section");
  panel.id = "youtubeBrowserPlayback";
  panel.innerHTML = `<h2>YouTube Music browser</h2><p id="youtubeBrowserStatus" role="status"></p><div class="actions"><button id="youtubeBrowserPlay" type="button">Play / resume</button><button id="youtubeBrowserPause" type="button">Pause</button><button id="youtubeBrowserSkip" type="button">Skip current</button><button id="youtubeBrowserRefresh" type="button">Refresh connection</button></div><p id="youtubeBrowserSong"></p><h3>Delivered requests</h3><div id="youtubeBrowserRequests"></div>`;
  playbackPage.prepend(panel);
  const active = () => selected() === "youtube" && mode === "browser";
  window.ravelinkYouTubeBrowserActive = active;
  const originalActive = window.ravelinkPlayerActive;
  window.ravelinkPlayerActive = (provider) =>
    originalActive(provider) && !(provider === "youtube" && active());
  async function request(method, payload) {
    const result = await call("song.youtube.browser.v1", method, payload || {});
    if (!result.ok)
      throw Error(
        result.error || result.reason || result.code || "Browser action could not be confirmed.",
      );
    return result;
  }
  async function action(method, payload) {
    if (busy) return;
    busy = true;
    try {
      await request(method, payload);
      await refreshState();
    } catch (error) {
      setNotice(error.message, true);
    } finally {
      busy = false;
      await refresh();
    }
  }
  function render() {
    const current = state?.current;
    $("youtubeBrowserStatus").textContent = state?.ready
      ? "Connected. Requests are delivered automatically in order."
      : state?.connected
        ? "Connected; queue editing is unavailable. Check the music tab and disable shuffle before retrying."
        : state?.enabled
          ? "Waiting for your music tab. Choose Connect YouTube Music under Setup."
          : "Connect the YouTube Music extension under Setup.";
    $("youtubeBrowserSong").textContent = current
      ? `${current.title} — ${(current.artists || []).join(", ")}${current.paused ? " (paused)" : ""}`
      : "No confirmed browser playback.";
    for (const id of ["youtubeBrowserPlay", "youtubeBrowserPause", "youtubeBrowserSkip"])
      $(id).disabled = !state?.connected || !current;
    const rows = (state?.handoffs || []).filter((row) =>
      ["appended", "playing", "unknown", "pending"].includes(row.phase),
    );
    const list = $("youtubeBrowserRequests");
    list.replaceChildren();
    if (!rows.length)
      list.textContent =
        "No delivered requests. Pending requests appear in the normal request queue.";
    for (const row of rows) {
      const item = document.createElement("div"),
        label = document.createElement("p");
      label.textContent = `${row.title || "Requested song"}${row.requesterLabel ? " · " + row.requesterLabel : ""} · ${{ appended: "Queued in YouTube Music", playing: "Playing", unknown: "Needs delivery review", pending: "Sending" }[row.phase]}`;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent =
        row.phase === "unknown"
          ? (state.queue || []).some((item) => item.id === row.entryId)
            ? "Checked absent: allow one retry"
            : "Checked absent: clear held record"
          : row.phase === "playing"
            ? "Skip this request"
            : "Remove this request";
      button.title =
        row.phase === "unknown"
          ? "Check the music queue and playback history first. Use only if this request was not delivered."
          : "Remove only this verified request occurrence";
      button.disabled = busy || row.phase === "pending";
      button.onclick = () =>
        action(row.phase === "unknown" ? "review" : "moderate", {
          entryId: row.entryId,
          ...(row.phase === "unknown"
            ? { confirmAbsent: true }
            : { action: row.phase === "playing" ? "skip" : "remove" }),
        });
      item.append(label, button);
      list.append(item);
    }
    if (state?.delivery?.lastError)
      $("youtubeBrowserStatus").textContent +=
        " Delivery is held: " + state.delivery.lastError.replaceAll("_", " ") + ".";
  }
  async function refresh() {
    if (refreshing) return;
    clearTimeout(timer);
    timer = null;
    if (stopped || !active()) return;
    refreshing = true;
    try {
      state = await request("status");
      render();
    } catch {
      $("youtubeBrowserStatus").textContent =
        "Connection status is unavailable. Refresh or check Core.";
    } finally {
      refreshing = false;
      if (!stopped && active()) timer = setTimeout(() => void refresh(), 4000);
    }
  }
  function update() {
    setup.hidden = selected() !== "youtube" || view() !== "setup";
    panel.hidden = !active() || view() !== "player";
    $("youtubeBrowserInstructions").hidden = mode !== "browser";
    if (selected() === "youtube") {
      $("playerFrame").hidden = active();
      startPlayer.hidden = active();
      $("skip").hidden = active();
      warning.hidden = active() || view() !== "player";
      if (active()) {
        player?.pauseVideo?.();
        $("playerProviderHint").textContent = "Requests play in your paired YouTube Music tab";
      }
    }
    if (active()) void refresh();
    else {
      clearTimeout(timer);
      timer = null;
    }
  }
  $("youtubePlaybackMode").onchange = async () => {
    const picker = $("youtubePlaybackMode");
    picker.disabled = true;
    try {
      const result = await call("song.player.preferences.v1", "select", {
        player: "youtube",
        youtubePlayback: picker.value,
      });
      if (!result.ok) throw Error("Could not save YouTube playback connection.");
      mode = result.youtubePlayback;
      choosePlayer();
      update();
    } catch (error) {
      picker.value = mode;
      setNotice(error.message, true);
    } finally {
      picker.disabled = false;
    }
  };
  $("youtubeOpenFolder").onclick = () =>
    action("setup", { action: "open-folder", browser: "firefox" });
  $("youtubeOpenChromiumFolder").onclick = () =>
    action("setup", { action: "open-folder", browser: "chromium" });
  $("youtubeCopySetup").onclick = async () => {
    try {
      await navigator.clipboard.writeText("about:debugging#/runtime/this-firefox");
      $("youtubeSetupStatus").textContent = "Copied. Paste the address into Firefox's address bar.";
    } catch {
      $("youtubeSetupStatus").textContent =
        "Paste about:debugging#/runtime/this-firefox into Firefox's address bar.";
    }
  };
  $("enableYoutubeBrowser").onclick = async () => {
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    $("enableYoutubeBrowser").disabled = true;
    try {
      const result = await request("setup", { action: "start", port: 0 });
      const url = new URL(result.pairingUrl);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.pathname !== "/connect.html" ||
        !/^#[a-f0-9]{64}$/.test(url.hash)
      )
        throw Error("Invalid connection address. Check Core and try again.");
      $("youtubeExtensionFolders").textContent = (result.extensionFolders || []).join("\n");
      $("youtubeBrowserPort").value = result.port || "";
      $("youtubeBrowserCode").value = result.pairingCode || "";
      $("youtubePairing").hidden = false;
      $("youtubeConnectLink").href = url.href;
      $("youtubeConnectLink").hidden = false;
      $("youtubeSetupStatus").textContent =
        "Choose your music tab on the connection page. Open that page in Firefox if another browser opened it.";
      if (popup) popup.location.replace(url.href);
      await refresh();
    } catch (error) {
      popup?.close();
      setNotice(error.message, true);
    } finally {
      $("enableYoutubeBrowser").disabled = false;
    }
  };
  $("disableYoutubeBrowser").onclick = async () => {
    await action("setup", { action: "stop" });
    $("youtubeBrowserCode").value = "";
    $("youtubeConnectLink").removeAttribute("href");
    $("youtubeConnectLink").hidden = true;
    $("youtubePairing").hidden = true;
  };
  $("youtubeBrowserPlay").onclick = async () => {
    await action("monitor", {});
    await action("control", { action: "resume" });
  };
  $("youtubeBrowserPause").onclick = () => action("control", { action: "pause" });
  $("youtubeBrowserSkip").onclick = () =>
    state?.current?.entryId
      ? action("moderate", {
          action: "skip",
          entryId: state.current.entryId,
          currentUid: state.current.uid,
        })
      : action("control", { action: "skip", currentUid: state?.current?.uid });
  $("youtubeBrowserRefresh").onclick = () => void refresh();
  window.addEventListener("pagehide", () => {
    $("youtubeConnectLink").removeAttribute("href");
    stopped = true;
    clearTimeout(timer);
    $("youtubeBrowserCode").value = "";
  });
  return {
    update,
    restore(saved) {
      mode = saved.youtubePlayback || "embed";
      $("youtubePlaybackMode").value = mode;
    },
    active,
  };
}
