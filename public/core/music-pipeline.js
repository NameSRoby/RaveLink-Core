/** Read-only pipeline presentation. No fetching, timers, capture or output authority.
 * Render authoritative choices and clocks supplied by the operator controller. */
(() => {
  function render({ pipeline, view, behaviorCatalog, $ }) {
    if (!behaviorCatalog) return;
    const m = pipeline?.metrics;
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
    const activeLayers = (pipeline?.layers || []).filter((l) => l.active);
    const selectedLayers = (pipeline?.layers || []).filter((l) => l.selected ?? l.enabled);
    const scenarioLabel = behaviorCatalog.scenarios.find(
      (s) => s.id === pipeline?.scenario?.id,
    )?.label;
    const shape = pipeline?.recipe?.shape;
    const shapeDetail = {
      wave: `${b.waveVoices} measured fronts · ${b.waveMs}ms · depth ${Math.round(b.waveDepth * 100)}%`,
      bounce: `${b.bounceSeconds}s travel at full energy · depth ${Math.round(b.interactionDepth * 100)}%`,
      mirror: `Paired inner / outer motion · ${b.bounceSeconds}s · depth ${Math.round(b.interactionDepth * 100)}%`,
      handoff: `${b.handoffHits} attacks per side · ${b.handoffMs}ms continuous crossfade`,
      swell: `${b.swellTravelSeconds}s at full energy · depth ${Math.round(b.swellDepth * 100)}% · span ${Math.round(b.swellSpan * 100)}%`,
    }[shape];
    const steps = {
      source: view.bindings.source?.label || "Choose an audio app",
      analysis: m
        ? `Level ${Math.round(m.level * 100)}% · Low / Mid / High ${(pipeline.bands || []).map((n) => Math.round(n * 100) + "%").join(" / ")}`
        : "Waiting for verified samples",
      response: `${d.feel} · smoothing ${Math.round((b.smoothing || 0) * 100)}% · ${pipeline?.preset || d.preset}`,
      scenario:
        scenarioLabel ||
        (pipeline?.mode === "manual" ? "Manual: " + pipeline.preset : "Waiting to draw once"),
      layers: pipeline
        ? `${selectedLayers.length} selected · ${activeLayers.length} acting now`
        : "Allowed layers await a request",
      shape: shapeDetail
        ? `${shape} · ${shapeDetail}`
        : pipeline?.scenario?.id === "wave"
          ? `Attack front · ${b.waveMs}ms · depth ${Math.round(b.waveDepth * 100)}%`
          : pipeline?.preset === "ambient" && b.spatialEnabled
            ? `Swell · depth ${Math.round(b.swellDepth * 100)}% · travel ${b.swellTravelSeconds}s · span ${Math.round(b.swellSpan * 100)}%`
            : pipeline?.preset === "bands"
              ? `Frequency zones · separation ${b.bandSeparation} · sensitivity ${b.bandSensitivity}`
              : d.arrangement + " fixture response",
      color: `${b.colorEnabled ? { roles: "Role-offset cycling", fixed: "Together cycling", onsets: "Attacks + gentle cycling", energy: "Energy + cycling", travel: "Travelling palette" }[d.colorMode] : "Color movement blocked"} · ${d.palette.length} colors · blend ${b.colorBlendMs}ms · vibrance ${Math.round((b.colorVibrance || 0) * 100)}%`,
      output: `${d.minimumBrightness}–${d.maximumBrightness}% brightness · intensity ${Math.round(d.intensity * 100)}% · ${pipeline?.outputCadence?.targetHz ?? d.outputHz} Hz · ${d.outputRateMode}`,
    };
    if (b.expressiveEnabled) {
      if (b.smoothShapesEnabled)
        steps.shape += ` · bounded mix · companion ${Math.round(b.spatialAccentShare * 100)}%`;
      if (b.perceptualColorsEnabled) steps.color += " · OKLCH";
      if (b.shuffleChoicesEnabled) steps.scenario += " · shuffle when randomized";
      if (b.logAttacksEnabled)
        steps.analysis +=
          " · " +
          (pipeline?.layers?.find((row) => row.id === "attacksEnabled")?.reason ||
            "log-spectral attacks awaiting audio");
    }
    if (pipeline?.recipe)
      steps.scenario += ` + ${pipeline.recipe.shape} + ${pipeline.recipe.palette} + ${pipeline.recipe.color} + ${pipeline.recipe.feel}`;
    if (pipeline?.outputCadence?.fixtureHz)
      steps.output +=
        " · " +
        [
          ...new Set(
            pipeline.outputCadence.fixtureHz.map(
              (f) =>
                `${f.brand} cap ${f.hz.toFixed(1)} Hz${f.delivery ? ` / completed ${f.delivery.completedHz.toFixed(1)} Hz / ${f.delivery.lastLatencyMs === null ? "waiting" : Math.round(f.delivery.lastLatencyMs) + "ms"}` : ""}`,
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
      ? `Calibrated loudness ${Math.round(m.level * 100)}% · new rise ${Math.round(m.rise * 100)}% · band contrast ${Math.round(m.spread * 100)}% · ${m.attack ? "recent measured attack" : "no recent attack"}`
      : "Waiting for fresh audio measurements.";
    $("pipelineTitle").textContent = !pipeline
      ? "Idle · choose a preset or enable a scenario draw, then Preview."
      : !pipeline.fresh
        ? "No fresh audio · no active behaviors"
        : pipeline.mode === "manual"
          ? "Manual preset · " + pipeline.preset
          : pipeline.scenario
            ? "Locked recipe: " +
              (behaviorCatalog.scenarios.find((s) => s.id === pipeline.scenario.id)?.label ||
                "scenario blocked — using manual response")
            : "Recipe is chosen at activation";
    if (pipeline?.savedEffect)
      $("pipelineTitle").textContent =
        `Saved effect: ${pipeline.savedEffect.name} ? ${pipeline.fresh ? "responding to audio" : "waiting for fresh audio"} ? combination stays fixed`;
    if (pipeline?.recipeLocked)
      $("pipelineTitle").textContent +=
        " · #" + pipeline.recipeId + " · changes apply next activation";
    if (pipeline?.sceneOnly)
      $("pipelineTitle").textContent += " · scene-only routes; music response bypassed";
    for (const f of behaviorCatalog.behaviors.filter((f) => f.type === "boolean")) {
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
