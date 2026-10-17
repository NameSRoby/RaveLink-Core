/**
 * Playlist link imports.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#playlist-transfers-and-uncertain-writes
 */
window.installPlaylistLinkImports = function ({ load, upload, notice, loading }) {
  $("importUrl").placeholder = "YouTube, SoundCloud, TIDAL or Spotify playlist URL";
  $("import").title = "Load this playlist into Transfers for review";
  $("import").textContent = "Load playlist";
  $("importState").textContent =
    "Load a source playlist, then choose where to transfer or export it.";
  const preview = document.createElement("div");
  preview.id = "playlistLinkPreview";
  $("importState").after(preview);
  const providerLabel = document.createElement("div");
  providerLabel.id = "playlistLinkProvider";
  $("importState").before(providerLabel);
  $("importUrl").addEventListener("input", () => {
    let host = "";
    try {
      host = new URL($("importUrl").value.trim()).hostname;
    } catch {}
    const provider =
      host === "open.spotify.com"
        ? "spotify"
        : ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)
          ? "youtube"
          : ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"].includes(host)
            ? "soundcloud"
            : ["tidal.com", "www.tidal.com", "listen.tidal.com"].includes(host)
              ? "tidal"
              : "";
    providerLabel.replaceChildren(...(provider ? [window.PlaylistProviderUI.badge(provider)] : []));
    $("urlSource").style.setProperty(
      "--link-color",
      window.PlaylistProviderUI.colors[provider] || "var(--edge)",
    );
  });
  let sdk,
    generation = 0,
    cancelRead;
  function loadSdk() {
    if (window.SC?.Widget) return Promise.resolve();
    return (sdk ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://w.soundcloud.com/player/api.js";
      const timer = setTimeout(() => {
        script.remove();
        sdk = null;
        reject(Error("SoundCloud did not respond. Try again."));
      }, 12000);
      script.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      script.onerror = () => {
        clearTimeout(timer);
        sdk = null;
        reject(Error("SoundCloud player could not load."));
      };
      document.head.append(script);
    }));
  }
  async function sounds(url, valid) {
    await loadSdk();
    if (!valid()) throw Error("Import canceled.");
    const frame = document.createElement("iframe");
    frame.title = "SoundCloud playlist preview";
    frame.style.cssText = "width:100%;height:166px;border:0";
    frame.src =
      "https://w.soundcloud.com/player/?url=" + encodeURIComponent(url) + "&auto_play=false";
    preview.replaceChildren(frame);
    const widget = SC.Widget(frame);
    return new Promise((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(
        () =>
          finish(
            Error("SoundCloud did not return this playlist. It may be private or unavailable."),
          ),
        15000,
      );
      function finish(error, rows) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cancelRead = null;
        widget.unbind(SC.Widget.Events.READY);
        widget.unbind(SC.Widget.Events.ERROR);
        widget.pause();
        error ? reject(error) : resolve(rows);
      }
      cancelRead = () => finish(Error("Import canceled."));
      widget.bind(SC.Widget.Events.PLAY, () => widget.pause());
      widget.bind(SC.Widget.Events.ERROR, () =>
        finish(Error("SoundCloud could not read this public playlist.")),
      );
      widget.bind(SC.Widget.Events.READY, () => widget.getSounds((rows) => finish(null, rows)));
    });
  }
  $("cancel").disabled = true;
  $("cancel").onclick = () => {
    generation++;
    cancelRead?.();
    preview.replaceChildren();
    $("importState").textContent = "Import canceled.";
  };
  $("import").onclick = async () => {
    let url;
    try {
      url = new URL($("importUrl").value.trim());
    } catch {
      return notice("Use a full HTTPS playlist link.", true);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return notice("Use a full HTTPS playlist link.", true);
    const host = url.hostname,
      name = $("importName").value.trim();
    const provider = ["tidal.com", "www.tidal.com", "listen.tidal.com"].includes(host)
      ? "tidal"
      : host === "open.spotify.com"
        ? "spotify"
        : ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)
          ? "youtube"
          : ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"].includes(host)
            ? "soundcloud"
            : "";
    if (!provider)
      return notice("Use a YouTube, SoundCloud, TIDAL or Spotify playlist link.", true);
    if (provider === "soundcloud" && !/^\/[\w-]+\/sets\/[\w-]+\/?$/.test(url.pathname))
      return notice("Use a public SoundCloud playlist link containing /sets/.", true);
    const active = ++generation;
    const valid = () => generation === active;
    $("import").disabled = true;
    $("cancel").disabled = provider !== "soundcloud";
    loading?.(true);
    $("importState").textContent =
      "Reading " +
      {
        spotify: "Spotify",
        soundcloud: "SoundCloud",
        tidal: "TIDAL",
        youtube: "YouTube",
      }[provider] +
      " playlist...";
    try {
      if (provider === "soundcloud") {
        const rows = await sounds("https://soundcloud.com" + url.pathname, valid);
        if (!valid()) throw Error("Import canceled.");
        if (!Array.isArray(rows) || !rows.length)
          throw Error("This SoundCloud playlist has no readable tracks.");
        await upload(
          rows,
          name ||
            decodeURIComponent(url.pathname.split("/").filter(Boolean).pop()).replaceAll("-", " "),
          valid,
        );
      } else await load(provider, url.href, name);
      if (valid())
        $("importState").textContent = "Source requested. Follow the transfer progress above.";
    } catch (error) {
      notice(error.message, true);
      $("importState").textContent = error.message;
    } finally {
      preview.replaceChildren();
      $("import").disabled = false;
      $("cancel").disabled = true;
      loading?.(false);
    }
  };
};
