/** Recipe editing changes saved intent only; Core draws once at activation. */
(() => {
  let axes = [],
    fields = [];
  const $ = (id) => document.getElementById("music-" + id);
  const names = {
    color: [
      "Color motion",
      {
        fixed: "Static color",
        onsets: "Audio attacks",
        travel: "Audio flow",
        energy: "By energy",
        roles: "Frequency colors",
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
    feel: [
      "Color pace",
      { slow: "Calm", normal: "Balanced", fast: "Lively", aggressive: "Intense" },
    ],
    task: [
      "Light jobs during Rave",
      { reactive: "React to music", dim: "Dim & hold", steady: "Hold a color", off: "Switch off" },
    ],
    role: [
      "Color frequency focus",
      { all: "Overall", low: "Bass", mid: "Midrange", high: "Treble" },
    ],
    effect: [
      "Color styles across lights",
      {
        pulse: "Audio attacks",

        wave: "Frequency colors",
        bounce: "Energy colors",
        handoff: "Audio flow",
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
    pulse:
      "Measured audio attacks change palette colors. Brightness keeps the shared sustained-audio envelope.",
    wave: "Frequency balance moves through palette colors. Brightness stays on the shared audio envelope.",
    bounce: "Color follows measured audio intensity; brightness is independent.",
    handoff: "Audio energy carries color through fixture positions; quiet passages slow the flow.",
    fixed: "Keep a selected palette color while brightness follows sustained audio.",
    onsets: "Qualified audio hits start a continuous color transition; there are no guessed beats.",
    travel:
      "Audio-driven color flow across fixture positions. It stops advancing below the calibrated audio floor.",
    energy: "Measured loudness guides the color flow while brightness keeps its own response.",
    roles:
      "Changing frequency balance chooses colors, with optional bass/mid/treble focus per light.",
    slow: "Slower color gestures. Brightness timing stays unchanged.",
    normal:
      "The selected color fade, with equal hit timing in quiet and loud passages. Brightness timing stays unchanged.",
    fast: "Quicker color gestures. Brightness timing stays unchanged.",
    aggressive: "Fast color response, within the output cap. Brightness timing stays unchanged.",
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
          ? "Balanced across eligible lights. Saved dim, steady and off jobs stay fixed."
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
      (["color", "feel"].includes(axis.id) ? $("recipeAxes") : $("extraRecipeAxes")).append(group);
    }
    fields = catalog.behaviors.filter(
      (f) => f.type === "number" && ["colorBlendMs", "colorVibrance"].includes(f.id),
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
    const randomized = ["color", "palette", "feel"].filter((id) => options[id]?.mode === "random");
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
  }
  function controls(busy, design) {
    if (!design || !axes.length) return;
    for (const id of ["color"]) {
      if (!axes.some((axis) => axis.id === id)) continue;
      const blocked =
        design.warmCoolColors ||
        !design.behaviors.colorEnabled ||
        (design.recipeOptions.effect && design.recipeOptions.effect.mode !== "configured");
      const card = $("recipeMode-" + id).closest("fieldset");
      card.querySelectorAll("input,select,button").forEach((el) => {
        el.disabled = busy || !!blocked;
      });
      if (blocked)
        $("recipeHint-" + id).textContent =
          design.recipeOptions.effect && design.recipeOptions.effect.mode !== "configured"
            ? "Assigned color styles provide their own audio mapping. Edit them under Advanced color & light pools."
            : design.warmCoolColors
              ? "Warm bass / cool treble takes over color motion. Turn it off in Color temperature & separation to use these choices."
              : "Color movement is disabled in Advanced response controls.";
    }
  }
  globalThis.RaveLinkMusicRecipe = { build, render, read, quickAssignments, controls };
})();
