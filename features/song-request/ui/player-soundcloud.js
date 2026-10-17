/**
 * Player soundcloud.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
/* exported installSoundCloudPlayer */
function installSoundCloudPlayer() {
  const active = () => $("songPlayerProvider")?.value === "soundcloud";
  const api = (method, payload = {}) => call("song.soundcloud.player.v1", method, payload);
  let widget = null,
    current = null,
    enabled = false,
    pulling = false,
    sdk = null,
    position = 0,
    duration = 0,
    lastProgress = 0,
    page = 0,
    paused = false,
    hasStarted = false;
  let renderedRows = "",
    renderedCurrent = "";
  let generation = 0,
    operation = Promise.resolve(),
    destroyed = false;
  const side = document.createElement("section");
  side.id = "soundcloudPlayer";
  side.hidden = true;
  side.innerHTML =
    '<h2>SoundCloud</h2><p id="soundcloudState" role="status">Add a public track link, then start playback.</p><div id="soundcloudFrame"></div><div class="actions"><button id="soundcloudStart" class="primary">Start playback</button><button id="soundcloudPause">Pause</button><button id="soundcloudSkip">Skip</button></div><div id="soundcloudCurrentActions" class="actions"></div>';
  document.querySelector(".playerSide").prepend(side);
  const setup = document.createElement("section");
  setup.id = "soundcloudSetup";
  setup.hidden = true;
  setup.innerHTML =
    '<h2>SoundCloud setup</h2><p>No API key or sign-in is needed for song-name searches or public links. Keep this player open for playback. SoundCloud controls availability, ads and any preview limits.</p><h3>Import a public playlist</h3><p>Save tracks to Playlists & Transfers for playback, CSV export or transfer matching. This does not change a SoundCloud account.</p><label>Playlist link<input id="soundcloudPlaylistUrl" type="url" placeholder="https://soundcloud.com/artist/sets/playlist"></label><label>Playlist name<input id="soundcloudPlaylistName" maxlength="80" placeholder="SoundCloud playlist"></label><button id="soundcloudImport">Import playlist</button><p id="soundcloudImportState" role="status"></p><div id="soundcloudPlaylistPreview"></div><p>Choose the imported list in Playlists & Transfers and select Play or Shuffle. Requests play first after the current track, then the playlist resumes. Song names use public SoundCloud search, with the shared matching and version filters in Moderation. No API credentials are needed. Account library writes are not available.</p>';
  $("songSetupPage").append(setup);
  const preview = document.createElement("div");
  preview.id = "soundcloudRequestPreview";
  $("requestNotice").after(preview);
  const paging = document.createElement("div");
  paging.id = "soundcloudPaging";
  paging.className = "actions";
  paging.hidden = true;
  paging.innerHTML =
    '<button id="soundcloudPrevious">Previous requests</button><span id="soundcloudPage"></span><button id="soundcloudNext">Next requests</button>';
  $("queue").closest("table").after(paging);
  $("soundcloudPrevious").onclick = () => {
    page = Math.max(0, page - 1);
    void refreshState();
  };
  $("soundcloudNext").onclick = () => {
    page++;
    void refreshState();
  };
  function link(value, playlist = false) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(
        "Paste a public SoundCloud link. Text search is not available in this connection.",
      );
    }
    const pattern = playlist ? /^\/[\w-]+\/sets\/[\w-]+\/?$/ : /^\/[\w-]+\/[\w-]+\/?$/;
    if (
      url.protocol !== "https:" ||
      !["soundcloud.com", "www.soundcloud.com"].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      !pattern.test(url.pathname) ||
      /\/(sets|likes|tracks|albums)\/?$/.test(url.pathname)
    )
      throw new Error(
        "Use a full public SoundCloud " + (playlist ? "playlist" : "track") + " link.",
      );
    return "https://soundcloud.com" + url.pathname;
  }
  function errorMessage(error) {
    return (
      {
        catalog_untrusted_link: "Use a YouTube, Spotify, TIDAL, or public SoundCloud track link.",
        song_link_metadata_unavailable:
          "Could not read this song link. Try the artist and title, or retry shortly.",
        soundcloud_query_invalid: "Enter between 2 and 256 characters for the artist and song.",
        soundcloud_no_eligible_match:
          "No playable match passed your song and version filters. Try a more specific artist/title or a direct SoundCloud link.",
        soundcloud_search_page_changed:
          "SoundCloud changed its public search page. Direct track links still work.",
        soundcloud_search_busy: "Other SoundCloud searches are finishing. Try again in a moment.",
        soundcloud_search_rate_limited: "SoundCloud search is busy. Wait a moment and try again.",
        soundcloud_search_unavailable:
          "SoundCloud search is unavailable. Try again or use a direct track link.",
        soundcloud_search_timeout:
          "SoundCloud search timed out. Try again or use a direct track link.",
        soundcloud_link_invalid: "Use a public SoundCloud track link for this player.",
        soundcloud_track_restricted:
          "SoundCloud restricts this track. Choose another public track.",
        soundcloud_track_invalid: "SoundCloud did not return a valid public track.",
        playlist_track_limit:
          "This playlist exceeds your library capacity. Change Library capacity in Transfers or use a smaller list.",
        item_duplicate:
          "This track is queued or playing, or needs another song to play before it can be requested again.",
        song_timed_out: "This track is temporarily blocked by moderation.",
        song_blocked: "This track is banned from song requests.",
        duration_limit:
          "This track exceeds the song-length limit. You can change that limit in Moderation.",
        intake_paused: "Requests are paused. Resume intake to add this track.",
      }[error.message] || error.message
    );
  }
  function loadSdk() {
    if (window.SC?.Widget) return Promise.resolve();
    if (!sdk)
      sdk = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://w.soundcloud.com/player/api.js";
        const timeout = setTimeout(() => {
          sdk = null;
          script.remove();
          reject(new Error("SoundCloud did not respond. Check your connection and retry."));
        }, 12000);
        script.onload = () => {
          clearTimeout(timeout);
          resolve();
        };
        script.onerror = () => {
          clearTimeout(timeout);
          sdk = null;
          reject(new Error("SoundCloud player could not load."));
        };
        document.head.append(script);
      });
    return sdk;
  }
  function frame(host, url) {
    host.replaceChildren();
    const node = document.createElement("iframe");
    node.title = "SoundCloud player";
    node.allow = "autoplay";
    node.scrolling = "no";
    node.style.cssText = "width:100%;height:166px;border:0;display:block";
    node.src =
      "https://w.soundcloud.com/player/?url=" +
      encodeURIComponent(url) +
      "&auto_play=false&show_artwork=true&single_active=true";
    host.append(node);
    return node;
  }
  const compact = (sound) => ({
    id: String(sound.id),
    title: String(sound.title || "").slice(0, 200),
    album: String(sound.publisher_metadata?.album_title || sound.album || "").slice(0, 200),
    permalink_url: String(sound.permalink_url || "").slice(0, 500),
    artwork_url: String(sound.artwork_url || "").slice(0, 500),
    duration: Math.trunc(Number(sound.duration) || 0),
    policy: sound.policy || "",
    user: { username: String(sound.user?.username || "").slice(0, 100) },
  });
  async function resolve(url, host) {
    await loadSdk();
    const node = frame(host, url),
      resolver = SC.Widget(node);
    return new Promise((accept, reject) => {
      const timeout = setTimeout(
        () =>
          finish(
            new Error("SoundCloud did not return this link. It may be private or unavailable."),
          ),
        12000,
      );
      function finish(error, sounds) {
        clearTimeout(timeout);
        resolver.unbind(SC.Widget.Events.READY);
        resolver.unbind(SC.Widget.Events.ERROR);
        if (error) {
          host.replaceChildren();
          reject(error);
        } else accept(sounds);
      }
      resolver.bind(SC.Widget.Events.PLAY, () => resolver.pause());
      resolver.bind(SC.Widget.Events.ERROR, () =>
        finish(new Error("SoundCloud cannot open this link.")),
      );
      resolver.bind(SC.Widget.Events.READY, () =>
        resolver.getSounds((sounds) => finish(null, sounds.map(compact))),
      );
    });
  }
  async function submit(event) {
    event?.preventDefault?.();
    $("addSong").disabled = true;
    try {
      const query = $("videoInput").value.trim();
      if (!/^https:\/\/(?:www\.|m\.)?soundcloud\.com\//i.test(query)) {
        if (!query) throw new Error("Enter an artist and song, or a public SoundCloud link.");
        setRequestNotice("Searching SoundCloud for a matching track?");
        const result = await api("submit-query", {
          query,
          requestId: crypto.randomUUID(),
        });
        $("videoInput").value = "";
        setRequestNotice(
          "Queued " +
            result.entry.candidate.title +
            " by " +
            result.entry.candidate.artists.join(", ") +
            ". Requests play in order.",
        );
        await refreshState();
        await pull();
        return;
      }
      const url = link(query);
      setRequestNotice("Reading the public SoundCloud track…");
      const sounds = await resolve(url, preview);
      if (sounds.length !== 1)
        throw new Error("Use a single public track link. Import playlists in Setup.");
      const result = await api("submit", {
        sound: sounds[0],
        requestId: crypto.randomUUID(),
      });
      $("videoInput").value = "";
      setRequestNotice("Queued " + result.entry.candidate.title + ". Requests play in order.");
      preview.replaceChildren();
      await refreshState();
      await pull();
    } catch (error) {
      setRequestNotice(errorMessage(error), true);
    } finally {
      preview.replaceChildren();
      $("addSong").disabled = false;
    }
  }
  $("soundcloudImport").onclick = async () => {
    const button = $("soundcloudImport");
    button.disabled = true;
    try {
      const url = link($("soundcloudPlaylistUrl").value.trim(), true);
      $("soundcloudImportState").textContent = "Reading public playlist…";
      const sounds = await resolve(url, $("soundcloudPlaylistPreview"));
      const upload = await api("import-start", {
        name: $("soundcloudPlaylistName").value.trim(),
      });
      for (let offset = 0; offset < sounds.length; offset += 40)
        await api("import-append", {
          uploadId: upload.uploadId,
          offset,
          sounds: sounds.slice(offset, offset + 40),
        });
      await api("import-save", { uploadId: upload.uploadId });
      $("soundcloudImportState").textContent =
        "Saved " +
        sounds.length +
        " tracks. Open Playlists & Transfers to select and play this list.";
      $("soundcloudPlaylistPreview").replaceChildren();
    } catch (error) {
      $("soundcloudImportState").textContent = errorMessage(error);
    } finally {
      button.disabled = false;
    }
  };
  function ack(state) {
    const entry = current;
    if (!entry) return Promise.resolve();
    operation = operation
      .catch(() => {})
      .then(async () => {
        if (entry !== current) return;
        try {
          await call("song.playback.driver.v1", "acknowledge", {
            driverId: DRIVER,
            leaseId: entry.leaseId,
            state,
            positionMs: position,
            durationMs: duration,
          });
        } catch (error) {
          if (error.code === "lease_stale" && entry === current) {
            widget?.pause();
            current = null;
          } else setNotice(error.message, true);
          return;
        }
        if (["ended", "failed", "skipped"].includes(state) && current === entry) {
          clearTimeout(entry.loadTimeout);
          widget?.pause();
          widget = null;
          $("soundcloudFrame").replaceChildren();
          current = null;
          await refreshState();
          void pull();
        }
      });
    return operation;
  }
  async function pull() {
    if (!active() || !enabled || current || pulling || destroyed) return;
    pulling = true;
    try {
      await loadSdk();
      const result = await call("song.playback.driver.v1", "pull", {
        driverId: DRIVER,
        providers: ["soundcloud"],
      });
      if (!result.action) {
        $("soundcloudState").textContent =
          "Ready. Waiting for requests or a SoundCloud server playlist.";
        return;
      }
      if (!active() || !enabled) {
        await api("release", {
          driverId: DRIVER,
          leaseId: result.action.leaseId,
        });
        return;
      }
      current = { ...result.action, revision: result.revision };
      hasStarted = false;
      position = 0;
      duration = current.candidate.durationMs;
      const entry = current;
      const node = frame(
        $("soundcloudFrame"),
        "https://api.soundcloud.com/tracks/" + current.candidate.providerItemId,
      );
      widget = SC.Widget(node);
      const playing = widget;
      $("soundcloudState").textContent =
        "Loading " +
        current.candidate.title +
        ". If playback is blocked, press Play in SoundCloud.";
      const owns = () => current === entry && active() && widget === playing;
      entry.loadTimeout = setTimeout(() => {
        if (owns() && !hasStarted) {
          enabled = false;
          current = null;
          playing.pause();
          $("soundcloudFrame").replaceChildren();
          void api("release", {
            driverId: DRIVER,
            leaseId: entry.leaseId,
          }).catch(() => {});
          $("soundcloudState").textContent =
            "Playback did not start. Press Resume to retry; your request is still queued.";
        }
      }, 12000);
      playing.bind(SC.Widget.Events.READY, () => {
        if (!owns()) return;
        playing.setVolume(outputVolume());
        playing.play();
      });
      playing.bind(SC.Widget.Events.PLAY, () => {
        if (!owns()) {
          playing.pause();
          return;
        }
        paused = false;
        hasStarted = true;
        clearTimeout(entry.loadTimeout);
        $("soundcloudState").textContent = "Playing " + entry.candidate.title;
        void ack("started");
      });
      playing.bind(SC.Widget.Events.PLAY_PROGRESS, (data) => {
        if (!owns() || !hasStarted) return;
        position = Math.max(0, Math.min(86400000, Math.trunc(data.currentPosition || 0)));
        if (Date.now() - lastProgress > 5000) {
          lastProgress = Date.now();
          void ack("progress");
        }
      });
      playing.bind(SC.Widget.Events.PAUSE, () => {
        if (owns() && hasStarted) {
          paused = true;
          $("soundcloudState").textContent = "Paused. Press Resume to continue.";
          void ack("paused");
        }
      });
      playing.bind(SC.Widget.Events.FINISH, () => {
        if (owns() && hasStarted) void ack("ended");
      });
      playing.bind(SC.Widget.Events.ERROR, () => {
        if (owns()) {
          setNotice("SoundCloud could not play this track. Moving to the next request.", true);
          void ack("failed");
        }
      });
    } catch (error) {
      setNotice(error.message, true);
    } finally {
      pulling = false;
    }
  }
  $("soundcloudStart").onclick = async () => {
    try {
      await loadSdk();
      if (lease) {
        const old = lease;
        player?.stopVideo?.();
        lease = null;
        await api("release", { driverId: DRIVER, leaseId: old.leaseId });
      }
      await api("start");
      enabled = true;
      if (current) widget?.play();
      else await pull();
      $("soundcloudStart").textContent = "Resume";
    } catch (error) {
      setNotice(error.message, true);
    }
  };
  $("soundcloudPause").onclick = () => widget?.pause();
  $("soundcloudSkip").onclick = () => void ack("skipped");
  async function select() {
    generation++;
    renderedRows = "";
    renderedCurrent = "";
    const choice = generation;
    document.querySelector(".now").hidden = active();
    side.hidden = !active();
    setup.hidden = !active();
    paging.hidden = !active();
    preview.hidden = !active();
    if (!active()) {
      enabled = false;
      widget?.pause();
      if (current) {
        const old = current;
        current = null;
        await api("release", { driverId: DRIVER, leaseId: old.leaseId }).catch(() => {});
      }
      return;
    }
    if (!enabled) {
      $("soundcloudState").textContent = "Ready. Add a song, then start playback.";
      $("soundcloudStart").textContent = "Start playback";
    }
    player?.pauseVideo?.();
    $("playerFrame").hidden = true;
    startPlayer.hidden = true;
    $("skip").hidden = true;
    $("catalogSettings").hidden = true;
    $("songSearchFilters").hidden = false;
    $("minimumSubscribers").closest("label").hidden = true;
    $("minimumViews").closest("label").hidden = true;
    $("allowNonMusic").parentElement.hidden = true;
    $("titleInput").closest("label").hidden = true;
    $("videoInput").closest("label").firstChild.textContent = "ARTIST AND SONG OR SOUNDCLOUD LINK";
    $("playerProviderHint").textContent = "Public SoundCloud links · playback in RaveLink";
    $("videoInput").placeholder = "Artist and song, YouTube, Spotify, TIDAL, or SoundCloud link";
    $("requestNotice").textContent =
      "Enter an artist and song, or a public track link. Requests play in order.";
    if (choice === generation) await refreshState();
  }
  function render(state, playback, renderOriginal) {
    if (!active()) return;
    const rows = state.queue || [],
      signature = JSON.stringify(rows.map((row) => [row.id, row.requesterKey])),
      keepFocus = signature === renderedRows;
    if (!keepFocus) {
      renderOriginal(state);
      renderedRows = signature;
    }
    if (!rows.length && page > 0) {
      page--;
      void refreshState();
    }
    $("queueHeading").textContent = "SOUNDCLOUD REQUESTS · " + state.counts.queued + " queued";
    $("soundcloudPrevious").disabled = page === 0;
    $("soundcloudNext").disabled = !state.page.hasMore;
    $("soundcloudPage").textContent = "Page " + (page + 1);
    if (!keepFocus) compactQueueModeration($("queue"), rows, moderate);
    const controls = $("soundcloudCurrentActions");
    if (renderedCurrent !== (playback.managed?.entryId || "none")) {
      renderedCurrent = playback.managed?.entryId || "none";
      controls.replaceChildren();
      const playing = playback.managed;
      if (playing?.candidate?.provider === "soundcloud") {
        const item = rows.find((row) => row.id === playing.entryId);
        controls.append(songActions(item || { ...playing, id: playing.entryId }));
      }
    }
    if (
      current &&
      playback.revision >= current.revision &&
      playback.managed?.entryId !== current.entryId
    ) {
      widget?.pause();
      widget = null;
      $("soundcloudFrame").replaceChildren();
      current = null;
      void pull();
    }
    widget?.setVolume(state.volume?.outputPercent ?? 40);
    void pull();
  }
  function songActions(item) {
    return createTrackModeration(item, moderate);
  }
  const heartbeat = setInterval(() => {
    if (active() && enabled && current && hasStarted) void ack(paused ? "paused" : "progress");
  }, 10000);
  window.addEventListener("pagehide", () => {
    clearInterval(heartbeat);
    destroyed = true;
    enabled = false;
    widget?.pause();
  });
  return {
    active,
    select,
    submit,
    pull,
    render,
    offset: () => page * 10,
    setVolume: (value) => widget?.setVolume(value),
  };
}
