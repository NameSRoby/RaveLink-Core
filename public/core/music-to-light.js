/** Core-owned operator controls. Feature-contributed code never runs here.
 * Poll only the visible view, one request at a time; render authoritative mapped
 * frames instead of inventing a separate browser animation/audio model.
 */
(() => {
  const workspace = document.querySelector("[data-music-controls]");
  if (!workspace) return;
  const $ = (id) => document.getElementById("music-" + id);
  const workspaceUI = globalThis.RaveLinkMusicWorkspace.create(workspace, $);
  const showWorkspace = workspaceUI.show;
  let view,
    busy = false,
    timer,
    closed = false,
    polling = false,
    visible = false,
    lastSequence = null;
  let behaviorCatalog = null;
  let sourceChoices = [];
  function renderSourceChoices(preferred, reset = false) {
    workspaceUI.sources(
      sourceChoices,
      view?.bindings.sources || [view?.bindings.source, null, null],
      preferred,
      reset,
    );
  }
  const editorFields = [
    "outputHz",
    "outputRateMode",
    "interpretation",
    "arrangement",
    "feel",
    "colorMode",
    "minimumBrightness",
    "maximumBrightness",
    "colorSeconds",
    "floorDb",
    "ceilingDb",
  ];
  const numeric = new Set([
    "outputHz",
    "minimumBrightness",
    "maximumBrightness",
    "colorSeconds",
    "floorDb",
    "ceilingDb",
  ]);
  const labels = { all: "Overall", low: "Low", mid: "Mid", high: "High" };
  const histories = new Map();
  const ranges = workspaceUI.responseRanges;
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
  async function request(url, method = "GET", body) {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      let code = result.error?.code || result.error || "music_request_failed";
      // The shared worker boundary deliberately uses a generic failure code.
      // Decode only our bounded symbolic errors, never arbitrary provider text.
      const message = result.error?.message;
      if (
        code === "workload_request_failed" &&
        typeof message === "string" &&
        /^(?:music_|invalid_music_|audio_probe_|source_query_|fullscreen_)[a-z_]{1,65}$/.test(
          message,
        )
      )
        code = message;
      throw Object.assign(Error(errors[code] || String(code).replaceAll("_", " ")), { code });
    }
    return result.value;
  }
  const savedEffectsUI = window.RaveLinkSavedEffects.create({ $, request });
  const call = (capability, method, payload = null) =>
    request("/api/music-to-light/call", "POST", {
      capability,
      method,
      payload,
    });
  async function action(fn) {
    if (busy) return;
    busy = true;
    controls();
    try {
      await fn();
      notice(
        view?.pipeline?.recipeLocked
          ? "Saved for the next activation. Current recipe stays locked."
          : "Changes applied.",
      );
    } catch (error) {
      notice(error.message, true);
    } finally {
      busy = false;
      controls();
    }
  }
  function controls() {
    workspaceUI.controls(busy, !!view && !!behaviorCatalog);
    $("catalogPanel")
      .querySelectorAll("input,select,button")
      .forEach((el) => {
        el.disabled = busy || !behaviorCatalog;
      });
    const status = view?.status,
      running = status && !["idle", "closed", "inactive"].includes(status.state);
    const ready = status?.permissions.capture && status?.sourceSelected && view?.captureAvailable;
    $("preview").disabled = busy || !ready || running || !behaviorCatalog;
    $("calibrate").disabled = busy || !ready || running || !behaviorCatalog;
    for (const id of ["calibrationSeconds", "calibrationHeadroom"])
      $(id).disabled = busy || running || !behaviorCatalog;
    $("live").disabled =
      busy ||
      !ready ||
      running ||
      !behaviorCatalog ||
      !status?.permissions.output ||
      !status?.musicFixtureCount;
    $("stop").disabled = !running;
    $("refreshSources").disabled = busy || !status?.permissions.capture || !view?.captureAvailable;
    $("selectSource").disabled = busy || !status?.permissions.capture;
    for (const id of ["source", "sourceFallback1", "sourceFallback2"])
      $(id).disabled = busy || !status?.permissions.capture;
    for (const id of [
      "capturePermission",
      "outputPermission",
      "saveFixtures",
      "applyDesign",
      "preset",
      "intensity",
      "outputCeiling",
      "outputHz",
      "outputRateMode",
      "look",
      "applyRecipe",
    ])
      $(id).disabled = busy || !view || (id === "saveFixtures" && !behaviorCatalog);
    $("fixtureChoices")
      .querySelectorAll("input,select")
      .forEach((input) => {
        input.disabled = busy || !behaviorCatalog;
      });
  }
  function renderStatus(status) {
    if (!view) return;
    view.status = status;
    workspaceUI.status(view.bindings?.source, status);
    const session = status.session;
    const inputDb = session?.inputDb;
    $("inputLevel").value = Number.isFinite(inputDb) ? inputDb : -80;
    $("inputDb").textContent = Number.isFinite(inputDb)
      ? inputDb.toFixed(1) + " dBFS"
      : session && !["idle", "stopped", "failed"].includes(session.state)
        ? "Waiting / silent"
        : "No capture";
    const states = {
      idle: "Ready",
      waiting: "Waiting for verified audio",
      preview: "Preview running · lights untouched",
      acquiring: "Reading prior light states",
      running: "Live lighting",
      stopping: "Stopping & restoring",
      stopped: "Stopped",
      failed: "Stopped after a session error",
    };
    $("sessionStatus").textContent =
      `${states[session?.state === "failed" ? "failed" : status.state] || status.state}${session?.reason ? " · " + session.reason.replaceAll("_", " ") : ""}${session?.pausedFixtures ? " · " + session.pausedFixtures + " lights released after takeover" : ""}${session?.failedOperations ? " · " + session.failedOperations + " output/restoration failures" : ""}`;
    const frame = session?.lastPreview;
    $("responseSummary").textContent = !frame
      ? "Waiting for verified audio"
      : `${session.frames} mapped frames · ${session.output === "broker" ? status.musicFixtureCount + " lights" : "Preview only"}`;
    if (frame && lastSequence !== frame.sequence) {
      if (lastSequence !== null && frame.sequence < lastSequence) histories.clear();
      // Four explicitly virtual routes make spatial interaction visible during
      // Preview. They acquire no fixture leases and are not physical feedback.
      const frames = frame.frames;
      $("mappedPreview").style.gridTemplateColumns =
        `repeat(${Math.min(frames.length, 4)}, minmax(0, 1fr))`;
      $("mappedPreview").replaceChildren(
        ...frames.map((light, index) => {
          const card = document.createElement("div");
          card.className = "musicSwatch";
          const name = document.createElement("strong");
          const route = view.pipeline?.routing?.[index];
          const binding = route?.id
            ? view.bindings.fixtures.find((f) => f.id === route.id)
            : view.bindings.fixtures[index];
          name.textContent =
            session.output === "broker" && binding
              ? view.fixtures.find((f) => f.id === binding.id)?.name || labels[light.role]
              : `Virtual ${index + 1} · ${labels[light.role] || light.role}`;
          const color = document.createElement("div");
          color.className = "musicSwatchColor";
          color.style.backgroundColor = `rgb(${light.rgb.r},${light.rgb.g},${light.rgb.b})`;
          color.style.opacity = String(Math.max(0.12, light.brightness / 100));
          color.title = "Palette color; visual opacity approximates brightness, not measured nits";
          if (route?.behavior === "dim") {
            color.style.background =
              "repeating-linear-gradient(45deg,#283044,#283044 8px,#171d2b 8px,#171d2b 16px)";
            color.title = "Existing fixture color is preserved; brightness dims independently.";
          }
          if (route?.behavior === "off") color.style.opacity = "0";
          const value = document.createElement("p");
          value.textContent = `${Math.round(light.brightness * 10) / 10}%${light.quiet ? " · quiet" : ""}`;
          if (route?.behavior && route.behavior !== "reactive")
            value.textContent +=
              " · " + { dim: "Theatre dim", steady: "Steady palette", off: "Off" }[route.behavior];
          const meter = document.createElement("meter");
          meter.min = 0;
          meter.max = 100;
          meter.value = light.brightness;
          meter.setAttribute("aria-label", `${name.textContent} brightness`);
          const key = session.output + ":" + index + ":" + light.role;
          const history = [
            ...(histories.get(key) || []),
            { sequence: frame.sequence, brightness: light.brightness },
          ]
            .filter((sample) => sample.sequence >= frame.sequence - 48)
            .slice(-49);
          histories.set(key, history);
          const chart = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          chart.setAttribute("viewBox", "0 0 320 56");
          chart.setAttribute("role", "img");
          chart.setAttribute(
            "aria-label",
            `Recent mapped brightness, ${view.design.minimumBrightness} to ${view.design.maximumBrightness} percent`,
          );
          chart.classList.add("musicResponseTrace");
          const line = document.createElementNS(chart.namespaceURI, "polyline");
          const span = Math.max(1, view.design.maximumBrightness - view.design.minimumBrightness);
          line.setAttribute(
            "points",
            history
              .map(
                (sample) =>
                  `${(320 * (sample.sequence - (frame.sequence - 48))) / 48},${52 - (48 * (sample.brightness - view.design.minimumBrightness)) / span}`,
              )
              .join(" "),
          );
          chart.append(line);
          const scale = document.createElement("small");
          scale.className = "muted";
          scale.textContent = `${view.design.minimumBrightness}-${view.design.maximumBrightness}% range · last 12 seconds`;
          card.append(name, color, value, meter, chart, scale);
          return card;
        }),
      );
      lastSequence = frame.sequence;
    }
    controls();
  }
  function renderPalette(colors) {
    colors = [...new Set(colors)];
    if (colors.length === 1) colors.push(colors[0] === "#ff075b" ? "#008cff" : "#ff075b");
    $("palette").replaceChildren(
      ...colors.map((color, index) => {
        const row = document.createElement("div"),
          input = document.createElement("input"),
          remove = document.createElement("button");
        input.type = "color";
        input.value = color;
        input.onchange = () => void action(saveDesign);
        input.setAttribute("aria-label", `Palette color ${index + 1}`);
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove color ${index + 1}`);
        remove.onclick = () => {
          if ($("palette").children.length > 2) {
            row.remove();
            void action(saveDesign);
          }
        };
        row.append(input, remove);
        return row;
      }),
    );
  }
  function renderFixtures() {
    globalThis.RaveLinkMusicFixtures.render({ view, $, labels });
  }
  function renderView(next, edit = false) {
    const sourceChanged =
      !view ||
      JSON.stringify(view.bindings.sources) !== JSON.stringify(next.bindings.sources) ||
      view.bindings.source?.id !== next.bindings.source?.id;
    if (!view) $("setup").open = !(next.status.sourceSelected && next.status.musicFixtureCount);
    view = next;
    if (sourceChanged) renderSourceChoices(undefined, true);
    $("capturePermission").checked = next.status.permissions.capture;
    $("outputPermission").checked = next.status.permissions.output;
    workspaceUI.sourceStatus(next);
    $("helperStatus").textContent = next.captureAvailable
      ? "Audio helper ready."
      : "Audio helper unavailable. In the developer checkout, run: node scripts/build-music-to-light-probe.js";
    if (edit) {
      renderBehaviorValues(next.design);
      $("responseRange").value =
        Object.keys(ranges).find(
          (key) =>
            ranges[key][0] === next.design.floorDb && ranges[key][1] === next.design.ceilingDb,
        ) || "custom";
      $("preset").value = next.design.preset;
      $("intensity").value = Math.round(next.design.intensity * 100);
      $("intensityValue").value = $("intensity").value + "%";
      editorFields.forEach((id) => {
        $(id).value = next.design[id];
      });
      renderPalette(next.design.palette);
      renderFixtures();
    }
    $("presetHelp").textContent = presetHelp[next.design.preset];
    document.querySelectorAll("[data-music-preset]").forEach((button) => {
      const selected = button.dataset.musicPreset === next.design.preset;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    renderStatus(next.status);
  }
  async function saveDesign() {
    if (new Set([...$("palette").querySelectorAll("input")].map((input) => input.value)).size < 2)
      throw Error("Choose at least two different palette colors.");
    const design = {
      ...view.design,
      preset: $("preset").value,
      intensity: Number($("intensity").value) / 100,
      palette: [...$("palette").querySelectorAll("input")].map((input) => input.value),
    };
    editorFields.forEach((id) => {
      design[id] = numeric.has(id) ? Number($(id).value) : $(id).value;
    });
    if (behaviorCatalog) {
      Object.assign(design, globalThis.RaveLinkMusicRecipe.read());
      design.scenarioMode = $("scenarioMode").value;
      design.raveEnabled = $("raveEnabled").checked;
      design.raveSeconds = Number($("raveSeconds").value);
      for (const id of ["raveScenario", "raveLayerMode", "raveDurationMode", "raveColorPlan"])
        design[id] = $(id).value;
      design.behaviors = Object.fromEntries(
        behaviorCatalog.behaviors.map((f) => [
          f.id,
          f.id === "smoothing"
            ? Number($("smoothing").value) / 100
            : f.type === "boolean"
              ? $("behavior-" + f.id).checked
              : Number($("behavior-" + f.id).value),
        ]),
      );
      design.scenarioWeights = Object.fromEntries(
        behaviorCatalog.scenarios.map((s) => [
          s.id,
          $("allow-" + s.id).checked ? Number($("weight-" + s.id).value) : 0,
        ]),
      );
    }
    view.design = await call("music.styles.v1", "configure", design);
    renderBehaviorValues(view.design);
    histories.clear();
    lastSequence = null;
    $("presetHelp").textContent = presetHelp[view.design.preset];
    document.querySelectorAll("[data-music-preset]").forEach((button) => {
      const selected = button.dataset.musicPreset === view.design.preset;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }
  function renderBehaviorValues(design) {
    $("outputCeiling").min = design.minimumBrightness;
    $("outputCeiling").value = design.maximumBrightness;
    $("outputCeilingValue").value = design.maximumBrightness + "%";
    if (!behaviorCatalog) return;
    globalThis.RaveLinkMusicRecipe.render(design);
    $("scenarioMode").value = design.scenarioMode || "manual";
    $("raveEnabled").checked = design.raveEnabled === true;
    $("raveSeconds").value = design.raveSeconds || 30;
    $("raveScenario").value = design.raveScenario || "random";
    $("raveLayerMode").value = design.raveLayerMode || "random";
    $("raveColorPlan").value = design.raveColorPlan || "configured";
    $("raveDurationMode").value = design.raveDurationMode || "song";
    $("smoothing").value = Math.round(100 * (design.behaviors?.smoothing ?? 0.3));
    $("smoothingValue").value = $("smoothing").value + "%";
    for (const f of behaviorCatalog.behaviors) {
      if (f.id === "smoothing") continue;
      const el = $("behavior-" + f.id);
      if (f.type === "boolean") el.checked = design.behaviors?.[f.id] ?? f.value;
      else el.value = design.behaviors?.[f.id] ?? f.value;
    }
    for (const s of behaviorCatalog.scenarios) {
      const weight = design.scenarioWeights?.[s.id] ?? 1;
      $("allow-" + s.id).checked = weight > 0;
      $("weight-" + s.id).value = weight || 1;
    }
  }
  function buildBehaviorControls(catalog) {
    behaviorCatalog = catalog;
    globalThis.RaveLinkMusicRecipe.build(catalog);
    const stages = {
      choice: "Recipe variety",
      analysis: "Analysis & band balance",
      response: "Response envelope",
      layers: "Responsive layers",
      shape: "Spatial shape",
      color: "Color movement",
      output: "Output pacing",
    };
    for (const [id, label] of Object.entries(stages)) {
      const detail = document.createElement("details");
      detail.id = "music-stage-" + id;
      const summary = document.createElement("summary");
      summary.textContent = label;
      detail.append(summary);
      const group = document.createElement("div");
      group.className = "musicEditor";
      detail.append(group);
      $("behaviorControls").append(detail);
      for (const f of catalog.behaviors.filter((f) => f.stage === id && f.id !== "smoothing")) {
        const row = document.createElement("label");
        const title = document.createElement("span");
        title.textContent =
          f.label +
          (f.id.endsWith("Ms") ? " (ms)" : "") +
          (f.type === "boolean" ? " · " + stages[f.stage] : "");
        const input = workspaceUI.editorInput(f);
        const help = document.createElement("small");
        help.textContent = f.help;
        help.className = "muted";
        row.append(title, input, help);
        if (f.type === "boolean") {
          row.className = "musicLayerControl";
          row.dataset.behavior = f.id;
          const active = document.createElement("output");
          active.id = "music-active-" + f.id;
          active.textContent = "Allowed · waiting";
          row.append(active);
          input.onchange = () => void action(saveDesign);
          $("layerControls").append(row);
        } else workspaceUI.placeEditor(f, row, group);
      }
    }
    for (const s of catalog.scenarios) {
      const row = document.createElement("div");
      row.className = "musicScenario";
      const label = document.createElement("label");
      label.className = "musicCheck";
      const allow = document.createElement("input");
      allow.type = "checkbox";
      allow.id = "music-allow-" + s.id;
      allow.onchange = () => void action(saveDesign);
      label.append(allow, document.createTextNode(s.label));
      const help = document.createElement("p");
      help.textContent = s.help;
      help.className = "muted";
      const weightLabel = document.createElement("label");
      weightLabel.textContent = "Chance weight";
      const weight = document.createElement("input");
      weight.type = "number";
      weight.id = "music-weight-" + s.id;
      weight.min = 0;
      weight.max = 10;
      weight.step = 0.25;
      weight.onchange = () => void action(saveDesign);
      weightLabel.append(weight);
      const chance = document.createElement("output");
      chance.id = "music-chance-" + s.id;
      chance.textContent = "Waiting for audio";
      row.append(label, help, weightLabel, chance);
      $("scenarioChoices").append(row);
    }
    for (const [id, label] of [
      ["source", "Source"],
      ["analysis", "Analysis"],
      ["response", "Envelope"],
      ["scenario", "Scenario draw"],
      ["layers", "Layers"],
      ["shape", "Shape"],
      ["color", "Color"],
      ["output", "Limits & ownership"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.stage = id;
      const title = document.createElement("strong");
      title.textContent = String($("pipeline").children.length + 1) + ". " + label;
      const value = document.createElement("output");
      value.id = "music-pipe-" + id;
      value.textContent = "Waiting";
      const help = document.createElement("small");
      help.textContent = "Click to edit this stage";
      button.append(title, value, help);
      button.onclick = () => {
        if (id === "scenario") {
          $("recipeEditor").open = true;
          $("scenarioEditor").open = true;
          $("recipeEditor").scrollIntoView({ block: "nearest" });
          return;
        }
        if (id === "layers") {
          $("layerControls").scrollIntoView({ block: "nearest" });
          return;
        }
        if (id === "color") {
          $("responseEditor").open = true;
          $("colorMode").scrollIntoView({ block: "nearest" });
          return;
        }
        if (id === "output") {
          showWorkspace("setup");
          $("tuning").open = true;
          $("outputCeiling").scrollIntoView({ block: "nearest" });
          return;
        }
        if (id === "source") {
          showWorkspace("setup");
          $("setup").open = true;
          $("setup").scrollIntoView({ block: "nearest" });
          return;
        }
        $("fineControls").open = true;
        $("stage-" + id).open = true;
        $("stage-" + id).scrollIntoView({ block: "nearest" });
      };
      $("pipeline").append(button);
    }
    renderBehaviorValues(view.design);
  }
  function renderPipeline(pipeline) {
    view.pipeline = pipeline;
    globalThis.RaveLinkMusicPipeline.render({ pipeline, view, behaviorCatalog, $ });
  }
  $("smoothing").oninput = () => {
    $("smoothingValue").value = $("smoothing").value + "%";
  };
  for (const id of [
    "smoothing",
    "scenarioMode",
    "raveEnabled",
    "raveSeconds",
    "raveScenario",
    "raveLayerMode",
    "raveColorPlan",
    "raveDurationMode",
  ])
    $(id).onchange = () => void action(saveDesign);
  $("applyBehaviors").onclick = () => void action(saveDesign);
  $("applyTransitions").onclick = () => void action(saveDesign);
  $("baseline").onclick = () =>
    void action(async () => {
      if (!behaviorCatalog) return;
      view.design = await call("music.styles.v1", "configure", behaviorCatalog.baseline);
      renderView({ ...view, design: view.design }, true);
      histories.clear();
      lastSequence = null;
    });
  for (const [id, key] of [
    ["capturePermission", "capture"],
    ["outputPermission", "output"],
  ]) {
    $(id).onchange = () =>
      void action(async () => {
        try {
          renderView(
            await request("/api/music-to-light/permissions", "PUT", {
              value: { ...view.status.permissions, [key]: $(id).checked },
            }),
          );
        } finally {
          $(id).checked = view.status.permissions[key];
        }
      });
  }
  $("refreshSources").onclick = () =>
    void action(async () => {
      const preferred = $("source").value;
      sourceChoices = await call("music.sources.v1", "list");
      renderSourceChoices(preferred);
    });
  $("source").onchange = controls;
  $("forgetSource").onclick = () =>
    void action(async () => {
      renderView(await request("/api/music-to-light/source", "PUT", { value: null }));
    });
  $("selectSource").onclick = () =>
    void action(async () => {
      const ids = ["source", "sourceFallback1", "sourceFallback2"].map((id) => $(id).value || null);
      try {
        if (
          JSON.stringify(ids) ===
          JSON.stringify(
            (view.bindings.sources || [view.bindings.source, null, null]).map(
              (row) => row?.id || null,
            ),
          )
        ) {
          $("sourceStatus").textContent =
            "This app is already remembered. Start lights or Preview when ready.";
          return;
        }
        // Refresh the expiring discovery grant only for a different selection.
        await call("music.sources.v1", "list");
        renderView(await request("/api/music-to-light/sources", "PUT", { value: ids }));
      } catch (error) {
        $("sourceStatus").textContent = error.message;
        throw error;
      }
    });
  $("saveFixtures").onclick = () =>
    void action(async () => {
      const selected = globalThis.RaveLinkMusicFixtures.read($);
      renderView(await request("/api/music-to-light/fixtures", "PUT", { value: selected }));
    });
  $("intensity").oninput = () => {
    $("intensityValue").value = $("intensity").value + "%";
  };
  $("outputCeiling").oninput = () => {
    $("outputCeilingValue").value = $("outputCeiling").value + "%";
    $("maximumBrightness").value = $("outputCeiling").value;
  };
  $("outputCeiling").onchange = () => void action(saveDesign);
  for (const id of ["calibrationSeconds", "calibrationHeadroom"])
    $(id).onchange = () => {
      $("calibrationSummary").textContent =
        `Calibration options · ${$("calibrationSeconds").value} seconds with ${$("calibrationHeadroom").value} dB headroom`;
    };
  $("calibrate").onclick = () =>
    void action(async () => {
      const seconds = Number($("calibrationSeconds").value),
        headroomDb = Number($("calibrationHeadroom").value);
      notice(
        `Measuring the selected source for ${seconds} seconds with ${headroomDb} dB headroom. Playback volume stays unchanged.`,
      );
      await call("music.styles.v1", "calibrate", { seconds, headroomDb });
      renderView(await request("/api/music-to-light/operator"), true);
    });
  $("responseRange").onchange = () =>
    void action(async () => {
      const range = ranges[$("responseRange").value];
      if (range) {
        $("floorDb").value = range[0];
        $("ceilingDb").value = range[1];
        await saveDesign();
      }
    });
  async function selectResponse(preset) {
    view.design = await call("music.styles.v1", "configure", {
      ...view.design,
      preset,
      scenarioMode: "manual",
      layerMode: "fixed",
      recipeOptions: {},
      parameterRanges: {},
      arrangement: preset === "bands" ? "roles" : preset === "ambient" ? "spatial" : "unified",
      colorMode: preset === "ambient" ? "travel" : preset === "pulse" ? "onsets" : "fixed",
    });
    renderView(await request("/api/music-to-light/operator"), true);
    $("look").value = "";
    $("lookHelp").textContent =
      "Custom response. Your palette, calibration and output settings are preserved.";
  }
  $("preset").onchange = () => void action(() => selectResponse($("preset").value));
  $("intensity").onchange =
    $("outputHz").onchange =
    $("outputRateMode").onchange =
    $("applyRecipe").onclick =
    $("applyDesign").onclick =
      () => void action(saveDesign);
  document.querySelectorAll("[data-music-preset]").forEach((button) => {
    button.onclick = () => void action(() => selectResponse(button.dataset.musicPreset));
  });
  $("addColor").onclick = () => {
    const colors = [...$("palette").querySelectorAll("input")].map((input) => input.value);
    const next = ["#ff075b", "#008cff", "#7024ff", "#00e6a8", "#ffae00"].find(
      (color) => !colors.includes(color),
    );
    if (colors.length < 5 && next) {
      renderPalette([...colors, next]);
      void action(saveDesign);
    }
  };
  for (const mode of ["preview", "live"])
    $(mode).onclick = () =>
      void action(async () => {
        await saveDesign();
        lastSequence = null;
        renderStatus(await call("music.session.v1", "start", { mode }));
      });
  // Stop remains available during slow enumeration/operator requests.
  $("stop").onclick = async () => {
    try {
      const stopped = await call("music.session.v1", "stop");
      renderStatus(stopped);
      const failed = stopped.session?.state === "failed" || stopped.session?.failedOperations > 0;
      notice(
        failed
          ? "Stopped with an output or cleanup failure; check session status."
          : "Stopped; prior light state restored where still owned.",
        failed,
      );
    } catch (error) {
      notice(error.message, true);
    }
  };
  async function poll() {
    if (closed || !visible || document.hidden || polling) return;
    polling = true;
    try {
      if (!view) {
        renderView(await request("/api/music-to-light/operator"), true);
        try {
          const catalog = await request("/api/music-to-light/catalog");
          if (catalog.revision !== 15) throw Error("music_restart_required");
          for (const look of catalog.looks || []) {
            const option = document.createElement("option");
            option.value = look.id;
            option.textContent = look.label;
            $("look").append(option);
            workspaceUI.addLook(look);
          }
          $("look").onchange = () =>
            void action(async () => {
              const look = catalog.looks.find((l) => l.id === $("look").value);
              if (!look) return;
              await call("music.styles.v1", "configure", {
                ...view.design,
                scenarioMode: "manual",
                recipeOptions: {},
                parameterRanges: {},
                ...look.design,
                behaviors: { ...view.design.behaviors, ...look.design.behaviors },
              });
              $("lookHelp").textContent = look.help;
              renderView(await request("/api/music-to-light/operator"), true);
            });
          buildBehaviorControls(catalog);
          await savedEffectsUI.refresh();
        } catch (error) {
          workspaceUI.loadError(error);
          return;
        }
        notice(
          view.status.sourceSelected
            ? "Ready when you are."
            : "Open Setup to choose your music and lights.",
        );
      } else {
        renderStatus(await call("music.session.v1", "status"));
        if (behaviorCatalog) renderPipeline(await request("/api/music-to-light/pipeline"));
      }
      workspaceUI.recovered();
    } catch (error) {
      notice(error.message, true, "poll");
    } finally {
      polling = false;
      if (!closed && visible && !document.hidden) timer = setTimeout(poll, 500);
    }
  }
  function theme(value) {
    if (workspace !== document.body) return;
    for (const key of ["accent", "bg", "surface", "text"])
      if (/^#[0-9a-f]{6}$/i.test(value?.[key] || ""))
        document.documentElement.style.setProperty("--" + key, value[key]);
  }
  addEventListener("message", (event) => {
    if (
      event.source === parent &&
      event.origin === location.origin &&
      event.data?.channel === "ravelink-feature-ui-v1" &&
      event.data.type === "presentation"
    )
      theme(event.data.theme);
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (!document.hidden) void poll();
  });
  // The native view starts hidden. Observe actual intersection before its first
  // request, so unrelated Core tabs do not initialize or poll this workspace.
  const visibility = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    clearTimeout(timer);
    if (visible) void poll();
  });
  visibility.observe(workspace);
  addEventListener("pagehide", () => {
    closed = true;
    clearTimeout(timer);
    visibility.disconnect();
  });
  addEventListener("pageshow", () => {
    if (closed) {
      closed = false;
      visibility.observe(workspace);
      void poll();
    }
  });
  if (workspace === document.body)
    void fetch("/api/presentation/theme", { cache: "no-store" })
      .then((r) => r.json())
      .then((body) => theme(body.theme))
      .catch(() => {});
  controls();
  void poll();
})();
