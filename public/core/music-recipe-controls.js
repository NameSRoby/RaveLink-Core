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
      "Color changes",
      {
        fixed: "Cycle together",
        onsets: "Follow attacks",
        travel: "Travel across lights",
        energy: "Follow energy",
        roles: "Offset each light",
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
        "prism-bands": "Prism",
      },
    ],
    feel: [
      "Response feel",
      { slow: "Slow", normal: "Normal", fast: "Fast", aggressive: "Aggressive" },
    ],
    task: [
      "Light jobs during Rave",
      { reactive: "React to music", dim: "Dim & hold", steady: "Hold a color", off: "Switch off" },
    ],
    role: ["Audio bands", { all: "Overall", low: "Bass", mid: "Midrange", high: "Treble" }],
  };
  function input(type, id) {
    const el = document.createElement("input");
    el.type = type;
    el.id = "music-" + id;
    return el;
  }
  function showMode(axis) {
    const mode = $("recipeMode-" + axis.id).value;
    $("recipePin-" + axis.id).hidden = mode !== "fixed";
    $("recipePool-" + axis.id).hidden = mode !== "random";
    $("recipeHint-" + axis.id).textContent =
      mode === "random"
        ? "Allow the choices Random may use. One is picked at the next start."
        : mode === "fixed"
          ? "This choice stays the same on every start."
          : ["task", "role"].includes(axis.id)
            ? "Uses the settings saved for each light in Setup."
            : "Uses the current look’s setting.";
  }
  function build(catalog) {
    axes = catalog.recipeAxes || [];
    $("recipeAxes").replaceChildren();
    $("randomRanges").replaceChildren();
    for (const axis of axes) {
      const [title, labels] = names[axis.id] || [axis.label, {}];
      const group = document.createElement("fieldset"),
        legend = document.createElement("legend");
      group.className = "musicRecipeCard";
      legend.textContent = title;
      const mode = document.createElement("select");
      mode.id = "music-recipeMode-" + axis.id;
      mode.setAttribute("aria-label", title + " choice mode");
      for (const [value, label] of [
        ["configured", "Use saved setting"],
        ["fixed", "Choose one"],
        ["random", "Random each start"],
      ])
        mode.add(new Option(label, value));
      const pinned = document.createElement("select");
      pinned.id = "music-recipePin-" + axis.id;
      pinned.setAttribute("aria-label", title + " fixed choice");
      const help = document.createElement("p");
      help.id = "music-recipeHint-" + axis.id;
      help.className = "musicRecipeHint";
      const pool = document.createElement("div");
      pool.id = "music-recipePool-" + axis.id;
      pool.className = "musicRecipeChoices";
      for (const choice of axis.choices) {
        pinned.add(new Option(labels[choice] || choice, choice));
        const label = document.createElement("label"),
          allow = input("checkbox", "recipeAllow-" + axis.id + "-" + choice),
          text = document.createElement("span");
        label.className = "musicRecipeChoice";
        text.textContent = labels[choice] || choice;
        label.append(allow, text);
        pool.append(label);
      }
      mode.onchange = () => showMode(axis);
      group.append(legend, mode, pinned, help, pool);
      $("recipeAxes").append(group);
    }
    fields = catalog.behaviors.filter((f) => f.type === "number" && f.stage !== "output");
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
  globalThis.RaveLinkMusicRecipe = { build, render, read };
})();
