/** Recipe editing changes saved intent only; Core draws once at activation. */
(() => {
  let axes = [],
    fields = [];
  const $ = (id) => document.getElementById("music-" + id);
  const names = {
    shape: [
      "Movement",
      {
        unison: "All lights together",
        wave: "Travelling wave",
        bounce: "Bouncing spot",
        handoff: "Call & response",
        swell: "Slow swell",
        mirror: "Mirror pairs",
      },
    ],
    color: [
      "Color motion",
      {
        fixed: "Slow cycle",
        onsets: "On hits",
        travel: "Color sweep",
        energy: "By energy",
        roles: "Offset colors",
      },
    ],
    palette: [
      "Color palette",
      {
        configured: "Your colors",
        generated: "Fresh contrasting colors",
        "electric-pulse": "Electric",
        "ember-pulse": "Ember",
        "aurora-swell": "Aurora",
        "prism-pulse": "Prism",
      },
    ],
    feel: ["Pace", { slow: "Calm", normal: "Balanced", fast: "Lively", aggressive: "Sharp" }],
    task: [
      "Light jobs during Rave",
      { reactive: "React to music", dim: "Dim & hold", steady: "Hold a color", off: "Switch off" },
    ],
    role: ["Audio bands", { all: "Overall", low: "Bass", mid: "Midrange", high: "Treble" }],
    effect: [
      "Effects across lights",
      {
        pulse: "Pulse",

        wave: "Travelling wave",
        bounce: "Bouncing spot",
        handoff: "Call & response",
      },
    ],
    paletteScope: [
      "Palette assignment",
      {
        shared: "One shared palette",
        effects: "Different palettes by effect group",
        fixtures: "Different palettes by fixture",
      },
    ],
  };
  const explanations = {
    unison: "The room follows one brightness envelope. Works with a single light too.",
    wave: "Measured hits travel through the lights in room order. Needs two distinct positions.",
    bounce: "One focus moves across the group and back. Color stays coordinated with it.",
    handoff: "Measured hits pass the lead between opposite sides, using a smooth crossfade.",
    swell: "Slow, energy-driven swells. Random pairs these with a calm or balanced pace.",
    mirror: "Paired lights move together around the center of the room.",
    fixed: "Colors cycle together through the palette at a steady pace.",
    onsets: "Qualified audio hits start a continuous color transition; there are no guessed beats.",
    travel: "Colors sweep through room positions. Random avoids competing travelling movements.",
    energy: "Measured loudness guides the color flow while brightness keeps its own response.",
    roles: "Offset the palette across lights, with one coordinated cycle.",
    slow: "Longer, gentler response and motion.",
    normal: "Balanced response; also keeps mixed effect groups at one pace.",
    fast: "Quicker response, used only where the movement stays readable.",
    aggressive: "Short, sharp response, reserved for the room moving together.",
  };
  function input(type, id) {
    const el = document.createElement("input");
    el.type = type;
    el.id = "music-" + id;
    return el;
  }
  function showMode(axis) {
    const mode = $("recipeMode-" + axis.id).value;
    $("recipePinWrap-" + axis.id).hidden = mode !== "fixed";
    $("recipePool-" + axis.id).hidden = mode !== "random";
    $("recipeHint-" + axis.id).textContent =
      mode === "random"
        ? ["task", "role", "effect"].includes(axis.id)
          ? "Balanced across eligible lights. Travelling groups stay together; saved scene jobs stay fixed."
          : "Allow several choices. Core picks a compatible combination at the next start."
        : mode === "fixed"
          ? "Keep this choice on each start. Random choices on other controls adapt to it."
          : ["task", "role"].includes(axis.id)
            ? "Uses the settings saved for each light in Setup."
            : "Keeps the current look’s setting.";
    globalThis.RaveLinkMusicChoices.sync();
  }
  function build(catalog) {
    $("paletteGrouping").onchange = () => {
      const value = $("paletteGrouping").value;
      $("recipeMode-paletteScope").value = "fixed";
      $("recipePin-paletteScope").value = value;
      $("recipeAllow-paletteScope-" + value).checked = true;
      showMode(axes.find((a) => a.id === "paletteScope"));
      $("applyDesign").click();
    };
    axes = catalog.recipeAxes || [];
    $("recipeAxes").replaceChildren();
    $("extraRecipeAxes").replaceChildren();
    $("randomRanges").replaceChildren();
    for (const axis of axes) {
      const [title, labels] = names[axis.id] || [axis.label, {}];
      const group = document.createElement("fieldset"),
        legend = document.createElement("legend");
      group.className = "musicRecipeCard";
      legend.textContent = title;
      const mode = document.createElement("select");
      mode.id = "music-recipeMode-" + axis.id;
      mode.dataset.musicChoice = "";
      mode.setAttribute("aria-label", title + " choice mode");
      for (const [value, label] of [
        ["configured", "From look"],
        ["fixed", "Choose"],
        ["random", "Random"],
      ])
        mode.add(new Option(label, value));
      const pinned = document.createElement("select");
      pinned.id = "music-recipePin-" + axis.id;
      pinned.dataset.musicChoice = "tiles";
      pinned.setAttribute("aria-label", title + " fixed choice");
      const help = document.createElement("p");
      help.id = "music-recipeHint-" + axis.id;
      help.className = "musicRecipeHint";
      const pool = document.createElement("div");
      pool.id = "music-recipePool-" + axis.id;
      pool.className = "musicRecipeChoices";
      for (const choice of axis.choices) {
        const option = new Option(labels[choice] || choice, choice);
        option.title = explanations[choice] || "";
        pinned.add(option);
        const label = document.createElement("label"),
          allow = input("checkbox", "recipeAllow-" + axis.id + "-" + choice),
          text = document.createElement("span");
        label.className = "musicRecipeChoice";
        label.title = explanations[choice] || "";
        text.textContent = labels[choice] || choice;
        label.append(allow, text);
        pool.append(label);
      }
      const pinnedWrap = document.createElement("div");
      pinnedWrap.id = "music-recipePinWrap-" + axis.id;
      pinnedWrap.append(pinned);
      mode.onchange = () => {
        showMode(axis);
        $("applyRecipe").click();
      };
      pinned.onchange = () => $("applyRecipe").click();
      pool.onchange = (event) => {
        if (!pool.querySelector("input:checked")) event.target.checked = true;
        $("applyRecipe").click();
      };
      group.append(legend, mode, help, pinnedWrap, pool);
      (["shape", "color", "feel"].includes(axis.id)
        ? $("recipeAxes")
        : $("extraRecipeAxes")
      ).append(group);
    }
    fields = catalog.behaviors.filter(
      (f) =>
        f.type === "number" &&
        [
          "pulseDecayMs",
          "pulseBed",
          "colorBlendMs",
          "colorVibrance",
          "waveMs",
          "waveWidth",
          "waveDepth",
          "waveVoices",
          "bounceSeconds",
          "handoffHits",
          "handoffMs",
          "interactionDepth",
          "swellSpan",
          "swellDepth",
          "swellTravelSeconds",
          "spatialAccentShare",
          "accentDepth",
          "impactDepth",
        ].includes(f.id),
    );
    for (const f of fields) {
      const row = document.createElement("div");
      row.className = "musicRandomRange";
      const label = document.createElement("label"),
        enabled = input("checkbox", "random-" + f.id);
      label.className = "musicRecipeChoice";
      label.append(enabled, document.createTextNode(f.label));
      row.append(label);
      for (const end of ["min", "max"]) {
        const value = input("number", "random-" + f.id + "-" + end);
        value.min = f.min;
        value.max = f.max;
        value.step = "any";
        value.setAttribute("aria-label", f.label + (end === "min" ? " minimum" : " maximum"));
        row.append(value);
      }
      enabled.onchange = () => {
        for (const end of ["min", "max"]) $("random-" + f.id + "-" + end).hidden = !enabled.checked;
      };
      $("randomRanges").append(row);
    }
  }
  function render(design) {
    for (const axis of axes) {
      const option = design.recipeOptions?.[axis.id] || {
        mode: "configured",
        value: axis.choices[0],
        allowed: axis.id === "task" ? ["reactive"] : axis.choices,
      };
      $("recipeMode-" + axis.id).value = option.mode;
      $("recipePin-" + axis.id).value = option.value;
      for (const choice of axis.choices)
        $("recipeAllow-" + axis.id + "-" + choice).checked = option.allowed.includes(choice);
      showMode(axis);
    }
    const options = design.recipeOptions || {};
    $("paletteGrouping").value =
      !options.paletteScope || options.paletteScope.mode === "configured"
        ? "shared"
        : options.paletteScope.mode === "fixed"
          ? options.paletteScope.value
          : "custom";
    $("fixtureRandomization").value =
      options.effect?.mode === "random"
        ? "mixed"
        : options.role?.mode === "random" &&
            (!options.effect || options.effect.mode === "configured")
          ? "coordinated"
          : ["task", "role", "effect"].every(
                (id) => !options[id] || options[id].mode === "configured",
              )
            ? "configured"
            : "custom";
    for (const f of fields) {
      const range = design.parameterRanges?.[f.id],
        value = design.behaviors[f.id];
      $("random-" + f.id).checked = !!range;
      $("random-" + f.id + "-min").value =
        range?.min ?? Math.max(f.min, Number((value * 0.8).toFixed(3)));
      $("random-" + f.id + "-max").value =
        range?.max ?? Math.min(f.max, Number((value * 1.2).toFixed(3)));
      for (const end of ["min", "max"]) $("random-" + f.id + "-" + end).hidden = !range;
    }
    const randomized = ["shape", "color", "feel"].filter((id) => options[id]?.mode === "random");
    $("randomSummary").textContent = randomized.length
      ? "Compatible choices · " + randomized.map((id) => names[id][0].toLowerCase()).join(", ")
      : "From your look";
    globalThis.RaveLinkMusicChoices.sync();
  }
  function read() {
    return {
      recipeOptions: Object.fromEntries(
        axes.map((axis) => {
          const mode = $("recipeMode-" + axis.id).value,
            value = $("recipePin-" + axis.id).value;
          const allowed = axis.choices.filter(
            (choice) => $("recipeAllow-" + axis.id + "-" + choice).checked,
          );
          if (mode === "random" && !allowed.length)
            throw Error(
              "Allow at least one choice for " + (names[axis.id]?.[0] || axis.label) + ".",
            );
          if (mode === "fixed" && !allowed.includes(value)) allowed.push(value);
          return [axis.id, { mode, value, allowed }];
        }),
      ),
      parameterRanges: Object.fromEntries(
        fields
          .filter((f) => $("random-" + f.id).checked)
          .map((f) => [
            f.id,
            {
              min: Number($("random-" + f.id + "-min").value),
              max: Number($("random-" + f.id + "-max").value),
            },
          ]),
      ),
    };
  }
  function quickAssignments(mode) {
    if (!["configured", "coordinated", "mixed"].includes(mode)) return;
    for (const id of ["task", "role", "effect"]) {
      $("recipeMode-" + id).value =
        id === "task" || mode === "configured" || (id === "effect" && mode === "coordinated")
          ? "configured"
          : "random";
      const defaults = id === "task" ? ["reactive"] : axes.find((a) => a.id === id).choices;
      for (const choice of axes.find((a) => a.id === id).choices)
        $("recipeAllow-" + id + "-" + choice).checked = defaults.includes(choice);
      showMode(axes.find((a) => a.id === id));
    }
    if (mode === "mixed") {
      $("recipeMode-color").value = "random";
      for (const choice of axes.find((a) => a.id === "color").choices)
        $("recipeAllow-color-" + choice).checked = ["fixed", "onsets"].includes(choice);
      $("recipeMode-feel").value = "fixed";
      $("recipePin-feel").value = "normal";
      $("recipeAllow-feel-normal").checked = true;
      showMode(axes.find((a) => a.id === "color"));
      showMode(axes.find((a) => a.id === "feel"));
    }
  }
  function controls(busy, design) {
    if (!design || !axes.length) return;
    for (const id of ["shape", "color"]) {
      const blocked =
        id === "shape"
          ? design.recipeOptions.effect && design.recipeOptions.effect.mode !== "configured"
          : design.warmCoolColors || !design.behaviors.colorEnabled;
      const card = $("recipeMode-" + id).closest("fieldset");
      card.querySelectorAll("input,select,button").forEach((el) => {
        el.disabled = busy || !!blocked;
      });
      if (blocked)
        $("recipeHint-" + id).textContent =
          id === "shape"
            ? "Movement comes from each effect group. Edit its allowed effects under Advanced color & light pools."
            : design.warmCoolColors
              ? "Warm bass / cool treble takes over color motion. Turn it off in Color temperature & separation to use these choices."
              : "Color movement is disabled in Advanced response controls.";
    }
  }
  globalThis.RaveLinkMusicRecipe = { build, render, read, quickAssignments, controls };
})();
