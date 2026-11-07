/** Read-only pipeline presentation. No fetching, timers, capture or output authority.
 * Render authoritative choices and clocks supplied by the operator controller. */
(() => {
  const assignmentCache = new WeakMap();
  function render({ pipeline, view, behaviorCatalog, $ }) {
    if (!behaviorCatalog) return;
    const m = pipeline?.metrics;
    const routing = pipeline?.routing || [];
    const reactive = routing.filter((f) => f.behavior === "reactive");
    const groups = new Set(reactive.map((f) => f.assignedEffect || "shared"));
    const palettes = new Set(
      reactive.map((f) => (f.assignedPalette || pipeline?.effective?.palette || []).join(",")),
    );
    $("assignmentStatus").textContent = routing.length
      ? `${routing.length} ${routing.some((f) => f.id) ? "lights" : "virtual lights"} · ${groups.size} effect group${groups.size === 1 ? "" : "s"} · ${palettes.size} palette${palettes.size === 1 ? "" : "s"}${routing.length > reactive.length ? " · " + (routing.length - reactive.length) + " scene jobs" : ""}. Details are in Diagnostics.`
      : "Chosen at the next start. Saved scene jobs stay fixed.";
    const details = $("assignmentDetails");
    const names = new Map(view.fixtures.map((fixture) => [fixture.id, fixture.name]));
    const assignments = routing.map((f, index) => ({
      name: names.get(f.id) || "Virtual " + (index + 1),
      job:
        f.behavior === "reactive"
          ? ({
              pulse: "Audio attacks",
              wave: "Frequency colors",
              bounce: "Energy colors",
              handoff: "Audio flow",
            }[f.assignedEffect] || "Shared color style") +
            " · " +
            ({ all: "overall", low: "bass", mid: "midrange", high: "treble" }[f.role] || f.role)
          : f.behavior,
      palette: f.assignedPalette,
    }));
    const signature = JSON.stringify(assignments);
    if (assignmentCache.get(details) !== signature) {
      details.replaceChildren(
        ...assignments.map((f) => {
          const row = document.createElement("li");
          row.textContent = `${f.name}: ${f.job}`;
          if (f.palette)
            for (const color of f.palette) {
              const swatch = document.createElement("span");
              swatch.style.backgroundColor = color;
              swatch.title = color;
              swatch.setAttribute("aria-label", color);
              row.append(swatch);
            }
          return row;
        }),
      );
      assignmentCache.set(details, signature);
    }
    const saved = view.design.calibrationVolume;
    const volume = pipeline?.volumeFollow?.current || saved;
    const describe = (v) =>
      `system ${Math.round(v.systemPercent)}% (${v.systemDb.toFixed(1)} dB), app mixer ${v.appGain === null ? "unavailable for mixed output" : Math.round(v.appGain * 100) + "%"}${v.muted ? ", muted" : ""}`;
    const states = {
      off: "Off",
      following: "Following app mixer",
      unavailable: "Fixed reference: matching mixer gain unavailable",
      muted: "Muted: response held quiet",
      out_of_range: "Fixed reference: gain change exceeds 36 dB; recalibrate",
    };
    $("volumeStatus").textContent =
      `${volume ? "Current / last measured: " + describe(volume) + ". " : "Mixer readings unavailable. "}${saved ? "At calibration: " + describe(saved) + ". " : "No saved mixer reference. "}${states[pipeline?.volumeFollow?.state] || (view.design.autoAudioFollow ? "Auto-follow ready for capture." : "Auto-follow off.")}`;
    $("calibrationStatus").textContent =
      m?.referenceSamples >= 100
        ? `Recent input reaching the loud reference: ${Math.round(m.referenceSaturation * 100)}%.${m.referenceSamples >= 250 && m.referenceSaturation > 0.7 ? " Most input is being limited. Calibrate a louder passage or add headroom for more detail." : " The reference stays fixed; occasional peaks are expected."}`
        : "";
    $("recipeValues").textContent = pipeline?.recipe
      ? Object.entries(pipeline.recipe.parameters || {})
          .map(
            ([id, value]) =>
              `${behaviorCatalog.behaviors.find((f) => f.id === id)?.label || id}: ${value}`,
          )
          .join(" · ") || "No numeric parameters randomized in this recipe."
      : "Randomized parameter values appear when a recipe activates.";
    const duration = view?.status.duration;
    const phases = {
      current_then_next: "Current song + following song",
      current_song: "Until this song ends",
      following_song: "Until the following song ends",
      metadata_lost: "Song timing lost · timer fallback",
      timer: "Timed effect",
    };
    $("durationStatus").textContent = duration
      ? `${phases[duration.phase] || duration.phase}${duration.title ? " · " + duration.title : ""} · ${duration.remainingSeconds === null ? "following playback" : duration.remainingSeconds + "s remaining"} · safety limit ${duration.safetyRemainingSeconds}s`
      : "No active Rave effect. Duration is decided when a request starts.";
    if (duration?.reason === "song_timing_unavailable")
      $("durationStatus").textContent +=
        " · Song Request has no fresh matching song clock; using timer.";
    const d = pipeline?.effective || view.design;
    const b = d.behaviors || {};
    const scenarioLabel = behaviorCatalog.scenarios.find(
      (s) => s.id === pipeline?.scenario?.id,
    )?.label;
    const steps = {
      source: view.bindings.source?.label || "Choose an audio app",
      analysis: m
        ? `Level ${Math.round(m.level * 100)}% · Low / Mid / High ${(pipeline.bands || []).map((n) => Math.round(n * 100) + "%").join(" / ")}`
        : "Waiting for verified samples",
      response: `${b.literalAttackMs} ms normal rise · prompt large impacts · ${b.literalReleaseMs} ms fall`,
      scenario:
        scenarioLabel ||
        (pipeline?.mode === "manual" ? "Color-led audio" : "Waiting for color selection"),
      layers: pipeline
        ? b.colorEnabled
          ? "Audio color changes allowed"
          : "Audio color changes blocked"
        : "Color permission applies at the next start",
      shape: `${{ unified: "Together", roles: "Frequency roles", spatial: "Palette positions" }[d.arrangement]} · shared audio brightness`,
      color: `${b.colorEnabled ? { roles: "Frequency colors", fixed: "Static color", onsets: "Audio attacks", energy: "Audio energy", travel: "Audio-driven flow" }[d.colorMode] : "Color movement blocked"} · ${d.palette.length} colors${d.warmCoolColors ? " / warm bass, cool treble" : ""} · ${Math.round(m?.colorIntervalMs || 0)}ms reaction interval · ${Math.round(m?.colorBlendMs || b.colorBlendMs)}ms fade`,
      output: `${d.minimumBrightness}–${d.maximumBrightness}% brightness · full calibrated range · ${pipeline?.outputCadence?.targetHz ?? d.outputHz} Hz · ${d.outputRateMode}`,
    };
    if (b.shuffleChoicesEnabled) steps.scenario += " · explore before repeating";
    if (pipeline?.recipe)
      steps.scenario += ` · ${pipeline.recipe.palette} · ${pipeline.recipe.color} · ${pipeline.recipe.feel} color pace`;
    if (pipeline?.outputCadence?.fixtureHz)
      steps.output +=
        " · " +
        [
          ...new Set(
            pipeline.outputCadence.fixtureHz.map(
              (f) =>
                `${f.brand} cap ${f.hz.toFixed(1)} Hz${f.delivery ? ` / delivered ${f.delivery.completedHz.toFixed(1)} Hz / held ${f.delivery.held ?? 0} / refreshes ${f.delivery.refreshed ?? 0} / ${f.delivery.lastLatencyMs === null ? "waiting" : Math.round(f.delivery.lastLatencyMs) + "ms"}` : ""}`,
            ),
          ),
        ].join(" / ");
    if (pipeline?.routing?.length) {
      const counts = {};
      for (const r of pipeline.routing) counts[r.behavior] = (counts[r.behavior] || 0) + 1;
      steps.output +=
        " · " +
        Object.entries(counts)
          .map(([k, n]) => n + " " + k)
          .join(" / ");
    }
    if (pipeline?.sceneOnly) {
      steps.layers = "Audio layers bypassed · scene-only fixture roles";
      steps.shape = "Dim / steady / off roles";
      steps.color = "Scene colors held independently of music";
    }
    for (const [id, text] of Object.entries(steps)) {
      $("pipe-" + id).textContent = text;
      $("pipe-" + id).closest("button").dataset.active = String(!!pipeline?.fresh);
    }
    $("metrics").textContent = m
      ? `Calibrated energy ${Math.round(m.level * 100)}% · new rise ${Math.round(m.rise * 100)}% · band contrast ${Math.round(m.spread * 100)}% · ${m.attack ? "recent measured attack" : "no recent attack"}`
      : "Waiting for fresh audio measurements.";
    $("pipelineTitle").textContent = !pipeline
      ? "Idle · choose colors and assignments, then Preview."
      : !pipeline.fresh
        ? "No fresh audio · no active behaviors"
        : pipeline.mode === "manual"
          ? "Color-led audio"
          : pipeline.scenario
            ? "Locked recipe: " +
              (behaviorCatalog.scenarios.find((s) => s.id === pipeline.scenario.id)?.label ||
                "scenario blocked — using manual response")
            : "Recipe is chosen at activation";
    if (pipeline?.savedEffect)
      $("pipelineTitle").textContent =
        `Saved effect: ${pipeline.savedEffect.name} · ${pipeline.fresh ? "responding to audio" : "waiting for fresh audio"} · combination stays fixed`;
    if (pipeline?.recipeLocked)
      $("pipelineTitle").textContent +=
        " · #" + pipeline.recipeId + " · colors locked; brightness smoothing applies live";
    if (pipeline?.sceneOnly)
      $("pipelineTitle").textContent += " · scene-only routes; music response bypassed";
    for (const f of behaviorCatalog.behaviors.filter(
      (f) => f.type === "boolean" && f.stage !== "profileSelection",
    )) {
      const layer = pipeline?.layers.find((l) => l.id === f.id);
      const enabled = $("behavior-" + f.id).checked;
      $("active-" + f.id).textContent = !enabled
        ? "Blocked"
        : layer?.selected === false
          ? "Not in this recipe"
          : pipeline?.sceneOnly
            ? "Bypassed · scene-only routes"
            : layer?.active
              ? "In recipe · responding now"
              : pipeline?.recipeLocked
                ? "In recipe · awaiting signal"
                : "Allowed · waiting";
      $("active-" + f.id).closest("label").dataset.active = String(!!layer?.active && enabled);
    }
    for (const s of behaviorCatalog.scenarios) {
      const candidate = (pipeline?.scenario?.candidates || pipeline?.candidates || []).find(
        (c) => c.id === s.id,
      );
      $("chance-" + s.id).textContent = !$("allow-" + s.id).checked
        ? "Blocked"
        : candidate
          ? Math.round(candidate.chance * 100) + "% at this draw"
          : "Applies at next activation";
    }
  }

  globalThis.RaveLinkMusicPipeline = Object.freeze({ render });
})();
