/** Workspace presentation only: navigation, source choices and look cards.
 * Capture and configuration remain owned by the host controller.
 */
(() => {
  function create(workspace, $) {
    // Navigation changes presentation only. Hidden editors keep their existing
    // controls and bindings; switching views never starts capture or stops a run.
    function showWorkspace(name) {
      if (!["play", "customize", "setup"].includes(name)) return;
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
      $("addColor").disabled = busy || !ready || $("palette").children.length >= 5;
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
          : "Music controls could not load. Refresh this page to retry.";
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
    return {
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
