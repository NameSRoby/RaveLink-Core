/** Main dashboard and editable libraries; one shared poll, no browser-owned audio. */
globalThis.RaveLinkMusicLibrary = {
  create({ $, request, action, call, renderView, getView, savedEffectsUI }) {
    let library = null,
      profiles = [],
      fingerprint = "",
      effectFingerprint = "",
      lastRefresh = 0,
      editing = null;
    let saving = false,
      ready = false;
    const contrastTargets = new Set();
    let contrastFingerprint = "";
    const element = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const run = (fn, immediate = false) =>
      void action(async () => {
        await fn();
        await refresh(true);
      }, immediate);
    const post = (route, body) => request("/api/music-to-light/" + route, "POST", body);
    function controls(busy, available) {
      saving = busy;
      ready = available;
      document
        .querySelectorAll(
          "#music-contrastAmount, #music-contrastScope, #music-contrastLights button, .musicAutoCard input, .musicAutoCard button, .musicSessionActions button, .musicQuickPanel input, .musicQuickPanel select, .musicSongLibrary input, .musicSongLibrary select, .musicSongLibrary button, .musicViewerSaves select, .musicViewerSaves button",
        )
        .forEach((input) => {
          input.disabled = busy || !available;
        });
      $("contrastAmount").disabled ||= !contrastRows().some(
        (f) => $("contrastScope").value === "all" || contrastTargets.has(f.id),
      );
      $("rememberSong").disabled ||= !library?.current;
      $("autoRave").disabled ||= !getView()?.design.raveEnabled && !library?.enabled;
      $("startRave").disabled ||=
        !getView()?.design.raveEnabled ||
        !getView()?.status.permissions.capture ||
        !getView()?.status.permissions.output ||
        !getView()?.status.musicFixtureCount;
      $("bookmark").disabled ||=
        !getView()?.status.session ||
        ["idle", "stopped", "failed"].includes(getView()?.status.state);
      $("saveCurrentEffect").disabled = $("bookmark").disabled;
    }
    function button(label, fn) {
      const node = element("button", label);
      node.type = "button";
      node.onclick = () => run(fn);
      return node;
    }
    function resetForm() {
      $("songForm").reset();
      $("songId").value = "";
      editing = null;
      $("songSubmit").textContent = "Add song";
      $("songCancel").hidden = true;
    }
    function edit(song) {
      editing = song;
      $("songId").value = song.id;
      for (const [id, value] of Object.entries({
        songUrl: song.url,
        songTitle: song.title,
        songArtist: song.artist,
        songEffect: song.effectId,
      }))
        $(id).value = value;
      $("songSubmit").textContent = "Save changes";
      $("songCancel").hidden = false;
      $("songTitle").focus();
    }
    function renderList() {
      if (!library) return;
      const filter = $("songSearch").value.toLowerCase().trim();
      const songs = library.songs.filter((s) =>
        (s.title + " " + s.artist).toLowerCase().includes(filter),
      );
      $("songCount").textContent = `${library.songs.length} / 500 songs`;
      $("songList").replaceChildren(
        ...songs.map((song) => {
          const row = element("div", undefined, "musicLibraryRow");
          const enabled = document.createElement("input");
          enabled.type = "checkbox";
          enabled.checked = song.enabled;
          enabled.setAttribute("aria-label", "Auto-Rave for " + song.title);
          enabled.onchange = () =>
            run(() => post("songs/save", { ...song, enabled: enabled.checked }));
          const info = element("div", undefined, "musicLibraryInfo");
          info.append(
            element("strong", song.title),
            element(
              "span",
              `${song.artist || song.provider} · ${profiles.find((p) => p.id === song.effectId)?.name || (song.effectId ? "Saved effect unavailable" : "Current playback selection")}`,
            ),
          );
          const actions = element("div", undefined, "actions");
          actions.append(
            button("Edit", () => edit(song)),
            button("Remove", async () => {
              await post("songs/delete", { id: song.id });
              if (editing?.id === song.id) resetForm();
            }),
          );
          row.append(enabled, info, actions);
          return row;
        }),
      );
      if (!songs.length)
        $("songList").append(
          element(
            "p",
            filter
              ? "No songs match your search."
              : "Your next favourite belongs here. Add a song above or save Now Playing on Main.",
            "musicEmptyState",
          ),
        );
    }
    function renderPending() {
      $("pendingList").replaceChildren(
        ...library.pending.map((p) => {
          const row = element("div", undefined, "musicLibraryRow");
          row.append(
            element(
              "strong",
              p.kind === "song" ? "Song · " + p.value.title : "Look · " + p.value.name,
            ),
            button("Approve", () => post("songs/review", { id: p.id, accept: true })),
            button("Dismiss", () => post("songs/review", { id: p.id, accept: false })),
          );
          return row;
        }),
      );
      if (!library.pending.length)
        $("pendingList").append(
          element("p", "No submissions waiting for approval.", "musicSmallHint"),
        );
    }
    function contrastRows() {
      const view = getView();
      const rows = new Map((view?.bindings.fixtures || []).map((f) => [f.id, f]));
      for (const f of view?.pipeline?.routing || [])
        if (f.id) rows.set(f.id, { ...f, raveBehavior: f.behavior });
      return [...rows.values()].filter((f) => !f.raveBehavior || f.raveBehavior === "reactive");
    }
    function syncContrast() {
      const rows = contrastRows();
      const key = JSON.stringify([rows, [...contrastTargets], $("contrastScope").value]);
      if (key !== contrastFingerprint) {
        contrastFingerprint = key;
        $("contrastLights").hidden = $("contrastScope").value !== "selected";
        $("contrastLights").replaceChildren(
          ...rows.map((f) => {
            const name = getView().fixtures.find((item) => item.id === f.id)?.name || f.id;
            const pick = element("button", `${name} - ${f.outOfSync || 0}%`);
            pick.type = "button";
            pick.setAttribute("aria-pressed", String(contrastTargets.has(f.id)));
            pick.onclick = () => {
              if (contrastTargets.has(f.id)) contrastTargets.delete(f.id);
              else contrastTargets.add(f.id);
              syncContrast();
              controls(saving, ready);
            };
            return pick;
          }),
        );
      }
      const selected = rows.filter(
        (f) => $("contrastScope").value === "all" || contrastTargets.has(f.id),
      );
      const values = new Set(selected.map((f) => f.outOfSync || 0));
      if (document.activeElement !== $("contrastAmount")) {
        $("contrastAmount").value = selected[0]?.outOfSync || 0;
        $("contrastValue").textContent =
          values.size > 1 ? "Mixed" : `${$("contrastAmount").value}%`;
      }
      $("contrastStatus").textContent = !rows.length
        ? "Choose reactive music lights in Setup first."
        : !selected.length
          ? "Select the lights you want to adjust."
          : values.size > 1
            ? "These lights have different settings. Moving the slider gives them the same percentage."
            : `${selected.length} light${selected.length === 1 ? "" : "s"} - changes apply during playback and are remembered.`;
    }
    $("contrastScope").onchange = () => {
      syncContrast();
      controls(saving, ready);
    };
    $("contrastAmount").oninput = () => {
      $("contrastValue").textContent = `${$("contrastAmount").value}%`;
    };
    $("contrastAmount").onchange = () => {
      const percent = Number($("contrastAmount").value);
      $("contrastValue").textContent = `${percent}%`;
      const fixtures =
        $("contrastScope").value === "all"
          ? null
          : contrastRows()
              .filter((f) => contrastTargets.has(f.id))
              .map((f) => f.id);
      run(async () => {
        renderView(
          await request("/api/music-to-light/contrast", "PUT", { value: { percent, fixtures } }),
          true,
        );
        // The next pipeline poll carries the updated live assignments.
        if (getView().pipeline) delete getView().pipeline;
        syncContrast();
      });
    };
    function syncDesign() {
      const d = getView()?.design;
      if (!d) return;
      const values = {
        quickRise: d.behaviors.literalAttackMs,
        quickRelease: d.behaviors.literalReleaseMs,
      };
      $("quickBrightnessHint").textContent =
        "Brightness follows measured energy across the calibrated range. Rise and fall control its response. Measured hits change color with the same timing in quiet and loud passages.";
      for (const [id, value] of Object.entries(values)) {
        const input = $(id);
        if (document.activeElement === input) continue;
        if (input.type === "checkbox") input.checked = value;
        else input.value = value;
      }
      $("quickRiseValue").textContent = $("quickRise").value + " ms";
      $("quickReleaseValue").textContent = $("quickRelease").value + " ms";
      syncContrast();
      controls(saving, ready);
    }
    const reasons = {
      off: "Off · your song list stays saved.",
      armed: "On · waiting for the next saved song.",
      waiting_metadata: "On · waiting for song information.",
      not_saved: "On · this song is not in your Rave list.",
      playing_saved_song: "Auto-Rave is following this saved song.",
      manual_priority: "Manual or viewer lighting has priority for this playback.",
      stopped_for_this_playback: "Stopped for this playback. The next saved song can trigger.",
      permissions_required: "Allow audio capture and light output in Setup.",
      rave_disabled: "Enable Rave effects above to use song automation.",
      lights_required: "Choose your music lights in Setup.",
      music_source_required:
        "Choose the matching music app in Setup. Game audio is a viewer-Rave fallback.",
      paused: "Playback paused.",
      stopped: "Playback stopped.",
      ended: "Song ended.",
      waiting_next_song: "Ready for the next saved song.",
      song_disabled: "This song was disabled; automatic lighting stopped.",
    };
    async function refresh(force = false) {
      if (!force && Date.now() - lastRefresh < 2000) {
        syncDesign();
        return;
      }
      lastRefresh = Date.now();
      const [next, effects] = await Promise.all([
        request("/api/music-to-light/library"),
        request("/api/music-to-light/effects"),
      ]);
      library = next;
      profiles = effects.profiles;
      $("nowSong").textContent = next.current
        ? `${next.current.title}${next.current.artist ? " · " + next.current.artist : ""}`
        : "Waiting for song information";
      $("rememberSong").disabled = !next.current;
      $("autoRave").checked = next.enabled;
      $("autoStatus").textContent =
        reasons[next.automation.reason] || String(next.automation.reason).replaceAll("_", " ");
      $("autoRave").closest(".musicAutoCard").dataset.enabled = String(next.enabled);
      const rave = next.rave;
      $("raveOrigin").textContent = rave
        ? `Started by ${{ auto: "a saved song", viewer: "a viewer", manual: "you" }[rave.origin] || "you"} · ${rave.effect?.name || "Generated look"} · ${rave.timing.remainingSeconds == null ? "Following song playback" : Math.ceil(rave.timing.remainingSeconds) + "s remaining"}`
        : "No active Rave · manual controls are ready.";
      $("viewerSongs").value = next.viewerSongs;
      $("viewerEffects").value = next.viewerEffects;
      const effectKey = JSON.stringify(profiles.map((p) => [p.id, p.name]));
      if (effectKey !== effectFingerprint) {
        effectFingerprint = effectKey;
        const selected = $("songEffect").value;
        $("songEffect").replaceChildren(
          new Option("Use current playback selection", ""),
          ...profiles.map((p) => new Option(p.name, p.id)),
        );
        $("songEffect").value = selected;
      }
      const key = JSON.stringify([next.songs, next.pending, effectKey]);
      if (key !== fingerprint) {
        fingerprint = key;
        renderList();
        renderPending();
      }
      if (next.recovered)
        $("libraryStatus").textContent =
          "The song library could not be restored. Automation is off; your other settings are retained.";
      syncDesign();
    }
    $("songForm").onsubmit = (event) => {
      event.preventDefault();
      run(async () => {
        const clearIdentity =
          !$("songUrl").value.trim() &&
          (editing?.url ||
            editing?.title !== $("songTitle").value.trim() ||
            editing?.artist !== $("songArtist").value.trim());
        await post("songs/save", {
          ...(editing || {}),
          ...(clearIdentity ? { trackId: "", provider: "any" } : {}),
          id: $("songId").value || undefined,
          url: $("songUrl").value.trim(),
          title: $("songTitle").value.trim(),
          artist: $("songArtist").value.trim(),
          effectId: $("songEffect").value,
          intensity: null,
        });
        resetForm();
        $("libraryStatus").textContent = "Song saved. Edit it here any time.";
      });
    };
    $("songCancel").onclick = resetForm;
    $("songSearch").oninput = renderList;
    $("autoRave").onchange = () =>
      run(() => post("songs/policy", { enabled: $("autoRave").checked }));
    for (const id of ["viewerSongs", "viewerEffects"])
      $(id).onchange = () => run(() => post("songs/policy", { [id]: $(id).value }));
    $("rememberSong").onclick = () =>
      run(async () => {
        if (!library?.current) return;
        await post("songs/save", library.current);
        $("libraryStatus").textContent = "Now Playing saved to your song library.";
      });
    $("bookmark").onclick = () =>
      run(async () => {
        await post("effects/save", {
          name:
            (library?.current?.title || "Favourite").slice(0, 60) +
            " · " +
            new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        });
        await savedEffectsUI.refresh();
      });
    $("renameEffect").onclick = () =>
      run(async () => {
        await post("effects/rename", {
          id: $("savedEffectSingle").value,
          name: $("renameEffectName").value,
        });
        $("renameEffectName").value = "";
        await savedEffectsUI.refresh();
      });
    $("startRave").onclick = () => run(() => post("rave/start", {}));
    for (const [id, output] of [
      ["quickRise", "quickRiseValue"],
      ["quickRelease", "quickReleaseValue"],
    ])
      $(id).oninput = () => {
        $(output).textContent = $(id).value + " ms";
      };
    for (const id of ["quickRise", "quickRelease"])
      $(id).onchange = () =>
        run(async () => {
          const d = getView().design;
          await call("music.styles.v1", "configure", {
            ...d,
            interpretation: "literal",
            behaviors: {
              ...d.behaviors,
              [id === "quickRise" ? "literalAttackMs" : "literalReleaseMs"]: Number($(id).value),
            },
          });
          renderView(await request("/api/music-to-light/operator"), true);
        });
    return { refresh, syncDesign, controls };
  },
};
