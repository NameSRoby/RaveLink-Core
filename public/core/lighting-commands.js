(() => {
  const ui = window.RaveLinkCoreUi;
  if (!ui) return;
  const element = id => document.getElementById(id);
  let loading = null;

  const fixtureNames = ids => {
    const names = new Map(ui.fixtures().map(row => [row.id, row.name || row.id]));
    return ids.map(id => names.get(id) || "Saved fixture");
  };
  const unique = values => [...new Set(values)];
  const describeRoute = (label, ids) => `${label} (${ids.length}): ${fixtureNames(ids).join(", ") || "no fixtures"}`;
  const effectDescriptions = Object.freeze({
    cycle: "Hard synchronized steps through two to twelve colors.",
    fade: "Smoothly blends the whole selected route between two to twelve colors.",
    breathe: "Pulses the brightness of one color.",
    rainbow: "Moves a spread rainbow across saved fixture positions.",
    wave: "Moves a color gradient across saved fixture positions; without colors it uses a rainbow.",
    sweep: "Sends a directional bright pulse across saved fixture positions.",
    ripple: "Expands a bright pulse from the saved room origin.",
    chase: "Uses hard color steps with a configurable gap between fixtures.",
    stop: "Stops the effect on the selected dynamic route."
  });

  function buildGuides(routing, effects, colorResult) {
    const staticEnabled = routing.ok && routing.mode !== "off";
    const staticRules = (routing.rules || []).filter(row => row.enabled && row.fixtureIds?.length);
    const baseRules = staticRules.filter(row => !row.prefix);
    const prefixedRules = staticRules.filter(row => row.prefix);
    const allStaticIds = unique(staticRules.flatMap(row => row.fixtureIds));
    const dynamicEnabled = effects.ok && effects.enabled && effects.fixtureIds?.length;
    const dynamicPrefixes = Object.entries(effects.prefixes || {}).reduce((groups, [id, prefix]) => {
      (groups[prefix] ||= []).push(id); return groups;
    }, {});
    const colorNames = Object.keys(colorResult.colors || {}).sort((a, b) => a.localeCompare(b));
    const descriptors = routing.parser?.allowDescriptors
      ? "light, lighter, pale, pastel, soft, dark, darker, deep, muted, dusty, desaturated, vivid, saturated, intense, warm, cool"
      : "disabled";
    const typo = routing.parser?.allowFuzzy ? "on" : "off";
    const defaultBrightness = routing.parser?.defaultBrightness || 100;
    const compact = ["RAVELINK LIGHT COMMANDS"];
    if (staticEnabled && allStaticIds.length) {
      compact.push("Color: <color> [1%-100%]", "Brightness only: <1%-100%>", "Random: random [1%-100%]", "Every routed light: all <color> [1%-100%]");
      for (const rule of prefixedRules) compact.push(`${rule.name}: ${rule.prefix} <color> [1%-100%]`);
      compact.push("Examples: red | deep blue 60% | all warm white | random 40%");
    } else compact.push("Static viewer color commands are currently off or have no routed fixtures.");
    if (dynamicEnabled) {
      compact.push("", "EFFECTS (unprefixed = every dynamic-routed fixture)", "cycle <colors> | fade <colors> | breathe <color>", "rainbow | wave [colors] | sweep <colors> | ripple <colors> | chase <colors>", "Add fast, normal, or slow at the end. Separate colors with commas. Use stop to end effects.");
      for (const prefix of Object.keys(dynamicPrefixes)) compact.push(`Dynamic subset: ${prefix} <effect>`);
      compact.push("Examples: cycle red, green, blue | fade purple, cyan slow | breathe deep blue | rainbow | stop");
    } else compact.push("", "Dynamic viewer effects are currently off or have no routed fixtures.");

    const detailed = [
      "RAVELINK LIGHT COMMANDS — ACTIVE GUIDE", "", "ROUTING RULE",
      "Commands can control only fixtures in the relevant saved route. Available, disabled, or unrouted fixtures remain unchanged.", ""
    ];
    if (staticEnabled && allStaticIds.length) {
      detailed.push("STATIC COLORS AND BRIGHTNESS", "<color>                         Set the default no-prefix route.", "<color> <1%-100%>               Set a color and brightness.", "<1%-100%>                       Change brightness without changing color.", "random [1%-100%]                Pick a random RGB color.", "all <color> [1%-100%]           Set the union of every enabled static route.", "bright                           Set the default route to 100% brightness.", "dim                              Set the default route to 70% brightness.", "", "ACTIVE STATIC ROUTES");
      for (const rule of baseRules) detailed.push(describeRoute("No prefix / default route", rule.fixtureIds));
      for (const rule of prefixedRules) detailed.push(describeRoute(`Prefix “${rule.prefix}” / ${rule.name}`, rule.fixtureIds), `  Example: ${rule.prefix} deep blue 60%`);
      detailed.push(describeRoute("ALL static route", allStaticIds), "", `Default brightness when omitted: ${defaultBrightness}%`, `Typo matching: ${typo}`, `Color descriptors: ${descriptors}`, "", "STATIC EXAMPLES", "red", "deep blue 60%", "all warm white 80%", "random 40%", "50%", "");
    } else detailed.push("STATIC COLORS", "Static viewer color commands are currently off or have no routed fixtures.", "");
    if (dynamicEnabled) {
      detailed.push("DYNAMIC EFFECTS", describeRoute("No prefix / ALL dynamic route", effects.fixtureIds), "Commands without a prefix affect every fixture above. A configured prefix selects only its subset.", "Colors must be separated with commas. Add fast, normal, or slow at the end; normal is used when omitted.", "");
      for (const [prefix, ids] of Object.entries(dynamicPrefixes)) detailed.push(describeRoute(`Dynamic prefix “${prefix}”`, ids));
      detailed.push("");
      for (const name of effects.supportedCommands || Object.keys(effectDescriptions)) if (effectDescriptions[name]) detailed.push(`${name.toUpperCase()}: ${effectDescriptions[name]}`);
      detailed.push("", "DYNAMIC SYNTAX", "cycle red, green, blue [fast|normal|slow]", "fade purple, cyan [fast|normal|slow]", "breathe deep blue [fast|normal|slow]", "rainbow [fast|normal|slow]", "wave [red, green, blue] [fast|normal|slow]", "sweep cyan, purple [fast|normal|slow]", "ripple white, blue [fast|normal|slow]", "chase red, green, blue [fast|normal|slow]", "stop", "all <effect>                    Explicitly select the entire dynamic route.", "");
    } else detailed.push("DYNAMIC EFFECTS", "Dynamic viewer effects are currently off or have no routed fixtures.", "");
    detailed.push("AVAILABLE COLOR NAMES", colorNames.join(", ") || "No colors available.", "", "Hex values are available in direct operator controls. Viewer commands use saved color names, including colors taught through the configured Teach Color reward.");
    return { compact: compact.join("\n"), detailed: detailed.join("\n") };
  }

  async function load() {
    if (loading) return loading;
    element("lightCommandsStatus").textContent = "BUILDING GUIDE FROM SAVED SETTINGS";
    loading = Promise.all([ui.request("/twitch/lights"), ui.request("/twitch/light-effects"), ui.request("/colors")])
      .then(([routing, effects, colors]) => {
        const guide = buildGuides(routing, effects, colors);
        element("compactLightCommands").textContent = guide.compact;
        element("detailedLightCommands").textContent = guide.detailed;
        element("lightCommandsStatus").textContent = "GUIDE READY // REFRESH AFTER CHANGING ROUTES OR COMMAND SETTINGS";
      })
      .catch(error => { element("lightCommandsStatus").textContent = error.message; })
      .finally(() => { loading = null; });
    return loading;
  }
  async function copy(id, button) {
    if (!element(id).textContent) await load();
    try {
      await navigator.clipboard.writeText(element(id).textContent);
      const original = button.textContent; button.textContent = "COPIED";
      setTimeout(() => { button.textContent = original; }, 1400);
    } catch { element("lightCommandsStatus").textContent = "COPY FAILED // SELECT THE LIST AND COPY IT MANUALLY"; }
  }
  element("refreshLightCommands").onclick = load;
  element("copyCompactLightCommands").onclick = event => copy("compactLightCommands", event.currentTarget);
  element("copyDetailedLightCommands").onclick = event => copy("detailedLightCommands", event.currentTarget);
  document.querySelector('[data-light-tab="commands"]').addEventListener("click", load);
})();
