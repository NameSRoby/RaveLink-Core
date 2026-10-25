/** Workspace presentation only: navigation, source choices and look cards.
 * Capture and configuration remain owned by the host controller.
 */
(() => {
  function create(workspace, $) {
    // Navigation changes presentation only. Hidden editors keep their existing
    // controls and bindings; switching views never starts capture or stops a run.
    function showWorkspace(name) {
      if (!["play", "library", "customize", "setup"].includes(name)) return;
      $("workspaceHelp").textContent = {
        play: "Main: live playback, looks and everyday controls. Changes are saved as you use them.",
        library:
          "Library: edit songs, manage saved looks and review viewer submissions. Playback selection needs Apply.",
        customize:
          "Advanced: build movement recipes and inspect the live pipeline. Use Main for everyday adjustments.",
        setup:
          "Setup: choose capture apps, light roles and output limits. Sources and light selection need Save; calibration runs only when requested.",
      }[name];
      workspace.querySelectorAll("[data-music-view]").forEach((panel) => {
        panel.hidden = panel.dataset.musicView !== name;
      });
      workspace.querySelectorAll(".musicNavigation [data-music-view-target]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.musicViewTarget === name));
      });
      if (name === "setup") $("setup").open = true;
      if (name === "customize") $("catalogPanel").open = true;
    }
    workspace.querySelectorAll("[data-music-view-target]").forEach((button) => {
      button.onclick = () => showWorkspace(button.dataset.musicViewTarget);
    });
    // Enumeration lists currently available audio producers; the saved app is a
    // separate preference and must stay selected even while that app is silent.
    function renderSources(sourceChoices, saved, preferred, reset = false) {
      const choices = [...sourceChoices];
      for (const source of saved.filter(Boolean))
        if (!choices.some((row) => row.id === source.id))
          choices.unshift({ ...source, label: source.label + " · remembered" });
      ["source", "sourceFallback1", "sourceFallback2"].forEach((id, index) => {
        const selected = reset
          ? saved[index]?.id || ""
          : index === 0 && preferred !== undefined
            ? preferred
            : $(id).value || saved[index]?.id || "";
        $(id).replaceChildren(new Option("None", ""));
        for (const source of choices)
          $(id).add(
            new Option(
              source.label + (source.scope === "entire_endpoint" ? " · ALL OUTPUT AUDIO" : ""),
              source.id,
            ),
          );
        $(id).value = selected;
      });
    }

    function paletteControls(design, busy, ready) {
      if (!busy) $("warmCoolColors").checked = !!design?.warmCoolColors;
      const option = design?.recipeOptions.palette;
      const generated =
        option &&
        ((option.mode === "random" &&
          option.allowed.length === 1 &&
          option.allowed[0] === "generated") ||
          (option.mode === "fixed" && option.value === "generated"));
      const custom =
        !option ||
        option.mode === "configured" ||
        (option.mode === "fixed" && option.value === "configured");
      if (!busy)
        $("paletteSource").value = generated ? "generated" : custom ? "custom" : "advanced";
      $("palette").hidden = !custom;
      $("addColor").disabled = busy || !ready || !custom || $("palette").children.length >= 8;
      $("paletteHint").textContent = generated
        ? "A fresh palette of 3-7 distinct colors at each start. Balanced color strength, no near-duplicate stops. Your custom colors stay saved."
        : custom
          ? "Choose 2-8 colors, or let Random build a contrasting palette."
          : "The look or Advanced settings choose the palette. Select Your colors to edit it yourself.";
    }
    function renderRandomPalette(pipeline) {
      const colors = pipeline?.effective?.palette || [];
      const random = pipeline?.recipe?.palette === "generated";
      $("randomPalette").hidden = !random;
      $("randomPalette").replaceChildren(
        ...(random ? colors : []).map((color, i) => {
          const swatch = document.createElement("span");
          swatch.style.backgroundColor = color;
          swatch.title = `Session color ${i + 1}: ${color}`;
          swatch.setAttribute("role", "img");
          swatch.setAttribute("aria-label", swatch.title);
          return swatch;
        }),
      );
    }

    function renderPalette(colors, save) {
      colors = [...new Set(colors)];
      if (colors.length === 1) colors.push(colors[0] === "#ff075b" ? "#008cff" : "#ff075b");
      $("palette").replaceChildren(
        ...colors.map((color, index) => {
          const row = document.createElement("div"),
            input = document.createElement("input"),
            remove = document.createElement("button");
          input.type = "color";
          input.value = color;
          input.onchange = save;
          input.setAttribute("aria-label", `Palette color ${index + 1}`);
          remove.type = "button";
          remove.textContent = "×";
          remove.setAttribute("aria-label", `Remove color ${index + 1}`);
          remove.onclick = () => {
            if ($("palette").children.length > 2) {
              row.remove();
              save();
            }
          };
          row.append(input, remove);
          return row;
        }),
      );
    }

    function addLook(look) {
      const card = document.createElement("button"),
        title = document.createElement("strong"),
        colors = document.createElement("span");
      card.type = "button";
      card.dataset.look = look.id;
      card.setAttribute("aria-pressed", "false");
      title.textContent = look.id === "smooth-reference" ? "Smooth Pulse" : look.label;
      colors.className = "musicLookColors";
      colors.setAttribute("aria-hidden", "true");
      for (const color of look.design.palette || []) {
        const dot = document.createElement("span");
        dot.style.backgroundColor = color;
        colors.append(dot);
      }
      card.append(colors, title);
      card.onclick = () => {
        $("look").value = look.id;
        $("look").dispatchEvent(new Event("change"));
      };
      if (["smooth-reference", "expressive-mix", "electric-pulse", "neon-relay"].includes(look.id))
        $("lookCards").insertBefore(card, $("moreLooks"));
      else $("extraLookCards").append(card);
    }
    function controls(busy, ready) {
      $("transitions")
        .querySelectorAll("input,select,button")
        .forEach((input) => {
          input.disabled = busy || !ready;
        });
      $("lookCards")
        .querySelectorAll("button")
        .forEach((button) => {
          button.disabled = busy || !ready;
          button.setAttribute("aria-pressed", String(button.dataset.look === $("look").value));
        });
      $("palette")
        .querySelectorAll("input,button")
        .forEach((input) => {
          input.disabled =
            busy || !ready || (input.tagName === "BUTTON" && $("palette").children.length <= 2);
        });
      $("addColor").disabled = busy || !ready || $("palette").children.length >= 8;
    }
    function status(source, state) {
      const transition = state.session?.transition;
      $("animationStatus").textContent =
        transition && transition.phase !== "none"
          ? `${transition.phase === "opening" ? "Opening" : "Returning to previous state"} · ${Math.round(transition.progress * 100)}%`
          : "";
      $("readySummary").textContent =
        !state.sourceSelected || !state.permissions.capture
          ? "Setup needed · choose your music source and allow capture"
          : `${state.sourceLabel || source?.label || "No music source"}${state.sourcePriority > 0 ? " · Fallback " + state.sourcePriority : ""} · ${state.musicFixtureCount || 0} lights${state.permissions.output ? "" : " · Preview only"}`;
    }
    function sourceStatus(view) {
      if (view.installed === false) {
        notice(
          "Music-to-Light was not selected during setup. Run the installer again and select Music-to-Light and Rave.",
        );
        $("sourceStatus").textContent = "Audio capture and light output are disabled.";
        return;
      }
      $("sourceStatus").textContent = view.status.sourceSelected
        ? view.bindings.source?.id === "fullscreen-app"
          ? "Start, then focus the fullscreen or borderless app within five seconds. Capture stays with that app when you Alt+Tab away, until you stop it or the app exits."
          : "Saved. Each new lighting session uses the first available app in this order. Running sessions keep their source."
        : "Choose a main app or a fallback. Unused slots can stay None.";
    }
    function recovered() {
      if ($("notice").dataset.origin === "poll") {
        $("notice").textContent = "Connection restored. Lighting controls are up to date.";
        $("notice").dataset.error = "false";
        delete $("notice").dataset.origin;
      }
    }
    function loadError(error) {
      const message =
        error.message === "music_restart_required"
          ? "Core is running older music code. Use the tray's Restart server, then refresh this page."
          : "Music controls could not load. Retrying automatically; check that Core is running.";
      $("pipelineTitle").textContent = message;
      $("notice").textContent = message;
      $("notice").dataset.error = "true";
    }
    function editorInput(field) {
      const input = document.createElement(field.choices ? "select" : "input");
      input.id = "music-behavior-" + field.id;
      if (field.choices) {
        for (const [value, label] of Object.entries(field.choices))
          input.add(new Option(label, value));
      } else {
        input.type = field.type === "boolean" ? "checkbox" : "number";
        if (field.type === "number") {
          input.min = field.min;
          input.max = field.max;
          input.step = field.step;
        }
      }
      return input;
    }
    function placeEditor(field, row, group) {
      (/^(opening|ending)/.test(field.id) ? $("transitionControls") : group).append(row);
    }
    const labels = { all: "Overall", low: "Low", mid: "Mid", high: "High" };
    const presetHelp = {
      ambient: "Loudness and swells, with a gentle sustained glow.",
      pulse: "Distinct measured attacks and decay; held notes settle to a dimmer bed.",
      bands: "Each role follows energy and new rises within its own frequency band.",
    };
    const errors = {
      ...window.RaveLinkSavedEffects.errors,
      invalid_music_contract_response:
        "Lighting status could not update. Your lights may still be running; retrying the connection.",
      invalid_music_source_priorities:
        "Choose each app only once. Leave unused source slots set to None.",
      invalid_music_recipe_options:
        "Check recipe choices: pinned values must be among the allowed choices.",
      invalid_music_parameter_ranges:
        "Check randomized ranges against the displayed parameter limits and steps.",
      music_no_recipe_choices: "Allow at least one choice for each randomized recipe axis.",
      music_calibration_superseded:
        "Calibration stopped or settings changed; the previous reference was kept.",
      music_calibration_insufficient_audio:
        "Not enough fresh audio to calibrate. Play music in the selected source and try again.",
      music_calibration_too_quiet:
        "The measured audio is too quiet for a useful reference. Keep a comfortable listening level and check the selected source.",
      music_selected_app_not_running:
        "No saved source is available. Open one of your selected apps and try again. Your choices are still saved.",
      music_selected_app_multiple_roots:
        "This app has multiple independent audio processes. Close extra app instances and try again. Core has not switched to desktop audio.",
      music_operator_save_failed:
        "The change could not be saved on this computer. Check Core's runtime folder access before restarting.",
      audio_probe_not_built:
        "The audio helper is not built. Build it in the developer checkout first.",
      music_source_not_in_current_catalog:
        "That source list expired. Refresh sources, then select again.",
      invalid_music_settings:
        "Check the response values: quiet/loud levels need at least 12 dB separation and minimum brightness cannot exceed maximum.",
      music_brightness_limits_unrepresentable:
        "The chosen brightness range cannot be represented by these lights. WiZ needs a minimum of 10%.",
      music_feature_inactive: "Music lighting has stopped. Restart Core to start a new session.",
      music_response_too_large:
        "The source list exceeds this preview’s display limit. Close unused audio applications or endpoints, then refresh.",
    };
    function notice(text, error = false, origin = "action") {
      $("notice").textContent = text;
      $("notice").dataset.error = String(error);
      $("notice").dataset.origin = origin;
    }
    return {
      sessionStates: {
        idle: "Ready",
        waiting: "Waiting for verified audio",
        preview: "Preview running · lights untouched",
        preheating: "Connecting Hue Entertainment",
        acquiring: "Reading prior light states",
        running: "Live lighting",
        stopping: "Stopping & restoring",
        stopped: "Stopped",
        failed: "Stopped after a session error",
      },
      errors,
      paletteControls,
      palette: renderPalette,
      randomPalette: renderRandomPalette,
      notice,
      labels,
      presetHelp,
      responseRanges: { normal: [-42, -18], quiet: [-48, -24], loud: [-36, -12] },
      show: showWorkspace,
      sources: renderSources,
      addLook,
      controls,
      status,
      loadError,
      editorInput,
      placeEditor,
      sourceStatus,
      recovered,
    };
  }
  globalThis.RaveLinkMusicWorkspace = { create };
})();
