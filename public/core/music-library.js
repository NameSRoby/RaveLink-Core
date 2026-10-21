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
    let sourceFingerprint = "",
      lightsFingerprint = "";
    const contrastTargets = new Set();
    let contrastFingerprint = "";
    $("mainTransitions").append($("transitions"));
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
          '.musicContrastPanel input, .musicContrastPanel select, .musicContrastPanel button, .musicHomeHero input, .musicHomeHero button, .musicQuickPanel input, .musicQuickPanel select, .musicSongLibrary input, .musicSongLibrary select, .musicSongLibrary button, .musicViewerSaves select, .musicViewerSaves button, [aria-labelledby="music-quickSourcesTitle"] input, [aria-labelledby="music-quickSourcesTitle"] select, [aria-labelledby="music-quickSourcesTitle"] button',
        )
        .forEach((input) => {
          input.disabled = busy || !available;
        });
      $("contrastAmount").disabled ||= !contrastRows().some(
        (f) => $("contrastScope").value === "all" || contrastTargets.has(f.id),
      );
      $("quickAccent").disabled ||=
        !getView()?.design.behaviors.loudnessBrightness ||
        getView()?.design.behaviors.steadyBrightness;
      $("quickImpact").disabled ||=
        !getView()?.design.behaviors.loudnessBrightness ||
        getView()?.design.behaviors.steadyBrightness;
      $("rememberSong").disabled ||= !library?.current;
      $("startRave").disabled ||=
        !getView()?.design.raveEnabled ||
        !getView()?.status.permissions.capture ||
        !getView()?.status.permissions.output ||
        !getView()?.status.musicFixtureCount;
      $("bookmark").disabled ||=
        !getView()?.status.session ||
        ["idle", "stopped", "failed"].includes(getView()?.status.state);
      $("mainFindApps").disabled ||= !getView()?.status.permissions.capture;
      $("mainSaveSources").disabled ||= !getView()?.status.permissions.capture;
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
        songIntensity: song.intensity === null ? "" : Math.round(song.intensity * 100),
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
              `${song.artist || song.provider} · ${profiles.find((p) => p.id === song.effectId)?.name || (song.effectId ? "Saved effect unavailable" : "Current playback selection")}${song.intensity === null ? "" : " · " + Math.round(song.intensity * 100) + "% intensity"}`,
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
        quickRave: d.raveEnabled,
        quickCeiling: d.maximumBrightness,
        quickBrightness: d.behaviors.steadyBrightness
          ? "steady"
          : d.behaviors.loudnessBrightness
            ? "loudness"
            : "reactive",
        quickColor: d.colorMode,
        quickAccent: Math.round(d.behaviors.accentDepth * 100),
        quickImpact: Math.round(d.behaviors.impactDepth * 100),
        quickRise: d.behaviors.loudnessBrightness
          ? d.behaviors.bodyAttackMs
          : d.behaviors.outputAttackMs,
        quickRelease: d.behaviors.loudnessBrightness
          ? d.behaviors.bodyReleaseMs
          : d.behaviors.outputReleaseMs,
        quickDuration: d.raveDurationMode,
        quickSeconds: d.raveSeconds,
      };
      $("quickBrightnessHint").textContent = (
        getView()?.pipeline?.effective.behaviors || d.behaviors
      ).steadyBrightness
        ? "Steady level is on: audio does not change brightness or create brightness pulses. Choose Loudness foundation, pulse accents for musical brightness."
        : "Brightness mode changes apply immediately; the current color recipe stays locked.";
      $("quickRise").min = d.behaviors.loudnessBrightness ? 20 : 0;
      $("quickRise").max = d.behaviors.loudnessBrightness ? 1000 : 200;
      $("quickRelease").min = d.behaviors.loudnessBrightness ? 50 : 0;
      $("quickRelease").max = d.behaviors.loudnessBrightness ? 1500 : 500;
      $("quickAccent").disabled = !d.behaviors.loudnessBrightness || d.behaviors.steadyBrightness;
      $("quickAccentValue").textContent = `${values.quickAccent}%`;
      $("quickImpactValue").textContent = `${values.quickImpact}%`;
      for (const [id, value] of Object.entries(values)) {
        const input = $(id);
        if (document.activeElement === input) continue;
        if (input.type === "checkbox") input.checked = value;
        else input.value = value;
      }
      const view = getView();
      $("quickRiseValue").textContent = $("quickRise").value + " ms";
      $("quickReleaseValue").textContent = $("quickRelease").value + " ms";
      $("mainCapture").checked = view.status.permissions.capture;
      $("mainOutput").checked = view.status.permissions.output;
      const choices = [...$("source").options].map((o) => [o.value, o.textContent]);
      const sourceKey = JSON.stringify([choices, view.bindings.sources]);
      if (sourceKey !== sourceFingerprint) {
        sourceFingerprint = sourceKey;
        ["mainSource", "mainFallback1", "mainFallback2"].forEach((id, index) => {
          $(id).replaceChildren(...choices.map(([value, label]) => new Option(label, value)));
          $(id).value = view.bindings.sources[index]?.id || "";
        });
      }
      const lightKey = JSON.stringify([view.fixtures, view.bindings.fixtures]);
      if (lightKey !== lightsFingerprint) {
        lightsFingerprint = lightKey;
        $("mainLights").replaceChildren(
          ...view.fixtures.map((fixture) => {
            const selected = view.bindings.fixtures.some((f) => f.id === fixture.id);
            const pick = button(fixture.name, async () => {
              const current = getView().bindings.fixtures;
              const next = selected
                ? current.filter((f) => f.id !== fixture.id)
                : [...current, { id: fixture.id, role: "all", position: 0.5 }];
              renderView(
                await request("/api/music-to-light/fixtures", "PUT", { value: next }),
                true,
              );
            });
            pick.setAttribute("aria-pressed", String(selected));
            return pick;
          }),
        );
      }
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
      rave_disabled: "Enable Rave below to use your saved songs.",
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
          intensity:
            $("songIntensity").value === "" ? null : Number($("songIntensity").value) / 100,
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
    $("mainFindApps").onclick = () => $("refreshSources").click();
    $("mainSaveSources").onclick = () => {
      ["source", "sourceFallback1", "sourceFallback2"].forEach((id, i) => {
        $(id).value = $(["mainSource", "mainFallback1", "mainFallback2"][i]).value;
      });
      $("selectSource").click();
    };
    for (const [id, target] of [
      ["mainCapture", "capturePermission"],
      ["mainOutput", "outputPermission"],
    ])
      $(id).onchange = () => {
        $(target).checked = $(id).checked;
        $(target).dispatchEvent(new Event("change"));
      };
    for (const id of [
      "quickRave",
      "quickCeiling",
      "quickBrightness",
      "quickAccent",
      "quickImpact",
      "quickColor",
      "quickRise",
      "quickRelease",
      "quickDuration",
      "quickSeconds",
    ])
      $(id).onchange = () =>
        run(async () => {
          const d = getView().design,
            ceiling = Number($("quickCeiling").value);
          const loudness = $("quickBrightness").value === "loudness";
          const timing = {};
          if (id === "quickRise")
            timing[loudness ? "bodyAttackMs" : "outputAttackMs"] = Number($("quickRise").value);
          if (id === "quickRelease")
            timing[loudness ? "bodyReleaseMs" : "outputReleaseMs"] = Number(
              $("quickRelease").value,
            );
          const design = {
            ...d,
            raveEnabled: $("quickRave").checked,
            maximumBrightness: ceiling,
            minimumBrightness: Math.min(d.minimumBrightness, ceiling),
            colorMode: $("quickColor").value,
            recipeOptions:
              id === "quickColor"
                ? {
                    ...d.recipeOptions,
                    color: {
                      mode: "configured",
                      value: $("quickColor").value,
                      allowed: [$("quickColor").value],
                    },
                  }
                : d.recipeOptions,
            raveDurationMode: $("quickDuration").value,
            raveSeconds: Number($("quickSeconds").value),
            behaviors: {
              ...d.behaviors,
              steadyBrightness: $("quickBrightness").value === "steady",
              loudnessBrightness: $("quickBrightness").value === "loudness",
              accentDepth: Number($("quickAccent").value) / 100,
              impactDepth: Number($("quickImpact").value) / 100,
              ...timing,
            },
          };
          await call("music.styles.v1", "configure", design);
          renderView(await request("/api/music-to-light/operator"), true);
        }, id === "quickBrightness");
    return { refresh, syncDesign, controls };
  },
};
