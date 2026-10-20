/** Saved combinations are local operator choices; playback policy changes next Start. */
window.RaveLinkSavedEffects = {
  errors: {
    fullscreen_app_unavailable:
      "Waiting for a fullscreen or borderless app. Start again, then focus the app within five seconds. Alt-tabbing away stops its capture.",
    music_effect_not_running: "Start a preview or live effect before saving its combination.",
    invalid_music_effect_policy:
      "Choose one saved effect, or at least one effect for the random pool.",
    music_effect_profile_in_use:
      "Remove this effect from the playback selection before deleting it.",
    invalid_music_effect_name: "Enter a name of up to 80 characters.",
  },
  create({ $, request }) {
    let state,
      busy = false;
    const status = (text, error = false) => {
      $("savedEffectsStatus").textContent = text;
      $("savedEffectsStatus").dataset.error = String(error);
    };
    const modeNames = {
      "full-random": "Full random",
      single: "One saved effect",
      "saved-random": "Random from saved effects",
    };
    function render() {
      $("savedEffectMode").value = state.policy.mode;
      $("savedEffectSingle").replaceChildren(
        ...(state.profiles.length
          ? state.profiles.map((p) => new Option(p.name, p.id))
          : [new Option("No saved effects yet", "")]),
      );
      $("savedEffectSingle").value = state.policy.ids[0] || state.profiles[0]?.id || "";
      $("savedEffectPool").replaceChildren(
        ...state.profiles.map((p) => {
          const label = document.createElement("label"),
            input = document.createElement("input"),
            name = document.createElement("span");
          label.className = "musicRecipeChoice";
          input.type = "checkbox";
          input.value = p.id;
          input.checked = state.policy.ids.includes(p.id);
          name.textContent = p.name;
          label.append(input, name);
          return label;
        }),
      );
      visibility();
      status(
        state.recovered
          ? "Saved effects could not be loaded. Choose a playback mode to recover."
          : `${state.profiles.length} saved ${state.profiles.length === 1 ? "combination" : "combinations"}. Applied: ${modeNames[state.policy.mode]}${state.policy.mode === "single" ? ` · ${state.profiles.find((p) => p.id === state.policy.ids[0])?.name || "Unavailable effect"}` : state.policy.mode === "saved-random" ? ` · ${state.policy.ids.length} selected` : ""}. Changes apply on the next start, including channel-points Rave.`,
        state.recovered,
      );
    }
    function visibility() {
      const mode = $("savedEffectMode").value;
      $("savedEffectSingleField").hidden = false;
      $("savedEffectSingleLabel").textContent =
        mode === "single" ? "Saved effect to play" : "Browse saved effects";
      $("savedEffectPool").hidden = mode !== "saved-random";
      const count = $("savedEffectPool").querySelectorAll("input:checked").length;
      $("savedEffectModeHelp").textContent =
        mode === "full-random"
          ? "Draw a combination using your current recipe and randomness controls."
          : mode === "single"
            ? "Replay the saved effect selected below on every start."
            : `${count} selected for random playback. Choose one or more effects below; one is picked per start.`;
      const selected = $("savedEffectSingle").value;
      const inUse =
        state && state.policy.mode !== "full-random" && state.policy.ids.includes(selected);
      $("savedEffectSingle").disabled = busy || !state?.profiles.length;
      $("deleteSavedEffect").disabled = busy || !selected || inUse;
      $("savedEffectDeleteHelp").textContent = inUse
        ? "This effect is in the applied playback selection. Apply a selection without it before deleting."
        : selected
          ? "Deletes the effect selected in the Saved effect list above."
          : "Save a playing combination to build your library.";
      $("applySavedEffectPolicy").disabled =
        busy || (mode === "single" ? !selected : mode === "saved-random" && count === 0);
    }
    async function refresh() {
      state = await request("/api/music-to-light/effects");
      render();
    }
    async function run(fn) {
      if (busy) return;
      busy = true;
      document
        .getElementById("music-savedEffectsTitle")
        .closest("section")
        .querySelectorAll("input,select,button")
        .forEach((el) => {
          el.disabled = true;
        });
      try {
        await fn();
        await refresh();
      } catch (e) {
        status(e.message, true);
      } finally {
        busy = false;
        document
          .getElementById("music-savedEffectsTitle")
          .closest("section")
          .querySelectorAll("input,select,button")
          .forEach((el) => {
            el.disabled = false;
          });
        visibility();
      }
    }
    $("saveCurrentEffect").onclick = () =>
      void run(async () => {
        await request("/api/music-to-light/effects/save", "POST", {
          name: $("savedEffectName").value,
        });
        $("savedEffectName").value = "";
      });
    $("savedEffectMode").onchange = visibility;
    $("savedEffectSingle").onchange = visibility;
    $("savedEffectPool").onchange = visibility;
    $("applySavedEffectPolicy").onclick = () =>
      void run(async () => {
        const mode = $("savedEffectMode").value;
        const ids =
          mode === "single"
            ? [$("savedEffectSingle").value]
            : mode === "saved-random"
              ? [...$("savedEffectPool").querySelectorAll("input:checked")].map((i) => i.value)
              : [];
        await request("/api/music-to-light/effects/policy", "POST", { mode, ids });
      });
    $("deleteSavedEffect").onclick = () =>
      void run(async () => {
        await request("/api/music-to-light/effects/delete", "POST", {
          id: $("savedEffectSingle").value,
        });
      });
    return { refresh };
  },
};
