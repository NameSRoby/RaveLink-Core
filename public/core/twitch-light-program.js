import { renderViewerGroups } from "./viewer-fixture-groups.js";
import { initViewerRave } from "./viewer-rave.js";
import "./browser-random-id.js";
/**
 * Twitch light program.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#lighting-and-dynamic-effects
 */
export function initTwitchLightProgram({
  request,
  initialState,
  initialEffectState = null,
  getFixtures,
  changed = () => {},
}) {
  const $ = (id) => document.getElementById(id);
  const viewerRave = initViewerRave({ request, getFixtures });
  let section = "groups";
  for (const button of document.querySelectorAll("[data-viewer-section]")) {
    button.onclick = () => {
      section = button.dataset.viewerSection;
      $("saveTwitchProgram").hidden = ["rave", "preview"].includes(section);
      $("saveTwitchProgram").textContent = section === "effects" ? "Save effects" : "Save changes";
      $("saveTwitchProgram").disabled = section === "effects" ? !effectState?.ok : !state?.ok;
      document
        .querySelectorAll("[data-viewer-section]")
        .forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      document.querySelectorAll("[data-viewer-pane]").forEach((pane) => {
        pane.hidden = pane.dataset.viewerPane !== button.dataset.viewerSection;
      });
    };
  }
  $("viewerColorsEnabled").onchange = () => {
    $("twitchRoutingMode").value = $("viewerColorsEnabled").checked ? "assignments" : "off";
    $("twitchRoutingMode").dispatchEvent(new Event("change", { bubbles: true }));
  };
  $("parserDefaultBrightness").oninput = () => {
    $("viewerBrightnessValue").value = $("parserDefaultBrightness").value + "%";
  };
  let state = initialState,
    draftRules = [],
    busy = false,
    selectedGroup = "active-fixtures",
    effectState = initialEffectState;
  const notice = (text) => {
    $("twitchProgramNotice").textContent = text;
  };
  const markDirty = () => notice("Unsaved changes");

  function normalizedRules(rules = []) {
    const claimed = new Set(),
      activeIds = [],
      groups = [];
    for (const row of rules) {
      const unique = row.fixtureIds.filter((id) => !claimed.has(id) && (claimed.add(id), true));
      if (!row.prefix) activeIds.push(...unique);
      else groups.push({ ...structuredClone(row), fixtureIds: unique });
    }
    const activeRules = rules.filter((row) => !row.prefix);
    return [
      {
        id: "active-fixtures",
        name: "Active Fixtures",
        prefix: "",
        enabled: !activeRules.length || activeRules.some((row) => row.enabled),
        fixtureIds: activeIds,
      },
      ...groups,
    ];
  }
  function allFixtures() {
    const fixtures = getFixtures(),
      known = new Set(fixtures.map((row) => row.id));
    const missing = draftRules
      .flatMap((row) => row.fixtureIds)
      .filter((id) => !known.has(id))
      .map((id) => ({ id, missing: true }));
    return [...fixtures, ...missing];
  }
  function renderEffectRouteSummary() {
    const output = $("twitchEffectRouteSummary");
    if (!output) return;
    const allowed = effectState?.fixtureIds || [],
      prefixes = effectState?.prefixes || {};
    const prefixed = allowed.filter((id) => prefixes[id]);
    output.textContent = `${allowed.length} IN DEFAULT ALL-FIXTURE ROUTE // ${prefixed.length} ALSO HAVE SUBSET PREFIXES // INDEPENDENT FROM NORMAL COLOR ROUTING.`;
    output.className = "notice";
  }
  function renderEffectFixtures() {
    const container = $("twitchEffectFixtures");
    if (!container) return;
    const selected = new Set(effectState?.fixtureIds || []),
      prefixes = effectState?.prefixes || {};
    const rows = getFixtures().filter(
      (row) =>
        row.enabled !== false &&
        row.twitchEnabled === true &&
        ["hue", "wiz", "govee"].includes(String(row.brand).toLowerCase()),
    );
    container.replaceChildren(
      ...rows.map((row) => {
        const card = document.createElement("article");
        card.className = "effectFixtureRoute";
        const label = document.createElement("label");
        label.className = "switchLabel";
        label.title = `Allow ${row.name || row.id} to run dynamic Twitch effects.`;
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = selected.has(row.id);
        input.dataset.effectFixtureId = row.id;
        const slider = document.createElement("span");
        slider.className = "toggleSwitch";
        slider.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.textContent = `${row.name || row.id} // ${String(row.brand).toUpperCase()}`;
        label.append(input, slider, text);
        const prefixLabel = document.createElement("label");
        prefixLabel.className = "switchLabel effectPrefixSwitch";
        prefixLabel.title = "Require this prefix for dynamic commands targeting the fixture.";
        const prefixToggle = document.createElement("input");
        prefixToggle.type = "checkbox";
        prefixToggle.checked = Boolean(prefixes[row.id]);
        prefixToggle.dataset.effectPrefixToggle = row.id;
        const prefixSlider = document.createElement("span");
        prefixSlider.className = "toggleSwitch";
        prefixSlider.setAttribute("aria-hidden", "true");
        const prefixText = document.createElement("span");
        prefixText.textContent = "REQUIRE PREFIX";
        prefixLabel.append(prefixToggle, prefixSlider, prefixText);
        const prefixField = document.createElement("label");
        prefixField.className = "effectPrefixField";
        prefixField.append(document.createTextNode("PREFIX"));
        const prefixInput = document.createElement("input");
        prefixInput.value = prefixes[row.id] || "";
        prefixInput.maxLength = 32;
        prefixInput.placeholder = "desk";
        prefixInput.dataset.effectPrefixInput = row.id;
        prefixInput.setAttribute("aria-label", `${row.name || row.id} dynamic prefix`);
        prefixField.append(prefixInput);
        const dirtyEffect = () => {
          $("twitchEffectsNotice").textContent = "UNSAVED DYNAMIC COMMAND CHANGES";
        };
        const sync = () => {
          prefixToggle.disabled = !input.checked;
          prefixField.hidden = !input.checked || !prefixToggle.checked;
          if (!prefixToggle.checked) prefixInput.value = "";
        };
        input.onchange = () => {
          if (!input.checked) prefixToggle.checked = false;
          sync();
          dirtyEffect();
        };
        prefixToggle.onchange = () => {
          sync();
          if (prefixToggle.checked) prefixInput.focus();
          dirtyEffect();
        };
        prefixInput.oninput = dirtyEffect;
        sync();
        card.append(label, prefixLabel, prefixField);
        return card;
      }),
    );
    if (!rows.length) {
      const empty = document.createElement("span");
      empty.className = "emptyDropZone";
      empty.textContent = "NO TWITCH-ENABLED FIXTURES";
      container.append(empty);
    }
    renderEffectRouteSummary();
  }
  async function loadEffects() {
    try {
      effectState = await request("/twitch/light-effects");
      $("twitchEffectsEnabled").checked = effectState.enabled === true;
      $("twitchEffectsReturn").checked = effectState.returnEffect === true;
      renderEffectFixtures();
    } catch (error) {
      $("twitchEffectsNotice").textContent = error.message;
    }
  }
  async function saveEffects() {
    if (!effectState) return;
    const fixtureIds = [
      ...$("twitchEffectFixtures").querySelectorAll("[data-effect-fixture-id]:checked"),
    ].map((item) => item.dataset.effectFixtureId);
    const prefixes = {};
    for (const id of fixtureIds) {
      const toggle = $("twitchEffectFixtures").querySelector(
        `[data-effect-prefix-toggle="${CSS.escape(id)}"]`,
      );
      if (!toggle?.checked) continue;
      const value =
        $("twitchEffectFixtures")
          .querySelector(`[data-effect-prefix-input="${CSS.escape(id)}"]`)
          ?.value.trim()
          .toLowerCase() || "";
      if (value === "all" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
        $("twitchEffectsNotice").textContent =
          "Every enabled dynamic prefix must begin with a letter and use only letters, numbers, underscores, or hyphens. ALL is reserved for every fixture.";
        return;
      }
      prefixes[id] = value;
    }
    try {
      effectState = await request("/twitch/light-effects", {
        method: "POST",
        body: JSON.stringify({
          revision: effectState.revision,
          enabled: $("twitchEffectsEnabled").checked,
          returnEffect: $("twitchEffectsReturn").checked,
          fixtureIds,
          prefixes,
        }),
      });
      renderEffectFixtures();
      void viewerRave.refresh();
      $("twitchEffectsNotice").textContent = effectState.enabled
        ? `DYNAMIC COMMANDS ENABLED FOR ${effectState.fixtureIds.length} FIXTURE${effectState.fixtureIds.length === 1 ? "" : "S"}.`
        : "DYNAMIC COMMANDS ARE OFF.";
    } catch (error) {
      $("twitchEffectsNotice").textContent =
        error.message === "twitch_effects_conflict"
          ? "Dynamic command settings changed in another window. Refresh the page."
          : error.message;
    }
  }
  function moveFixture(id, destination) {
    if (!id) return;
    draftRules.forEach((row) => {
      row.fixtureIds = row.fixtureIds.filter((value) => value !== id);
    });
    if (destination !== "available")
      draftRules.find((row) => row.id === destination)?.fixtureIds.push(id);
    selectedGroup ||= "active-fixtures";
    renderBoard();
    markDirty();
  }
  function groupControls(rule, active = false) {
    const controls = document.createElement("div");
    controls.className = "fixtureZoneSettings";
    const enabled = document.createElement("label"),
      check = document.createElement("input");
    enabled.className = "checkLabel";
    enabled.title = "Include this fixture group when Twitch color commands are routed.";
    check.type = "checkbox";
    check.checked = rule.enabled;
    check.onchange = () => {
      rule.enabled = check.checked;
      markDirty();
    };
    enabled.append(check, document.createTextNode(" Enabled"));
    controls.append(enabled);
    if (!active) {
      const nameLabel = document.createElement("label");
      nameLabel.className = "fixtureZoneField";
      nameLabel.append(document.createTextNode("Name"));
      const name = document.createElement("input");
      name.value = rule.name;
      name.maxLength = 64;
      name.setAttribute("aria-label", "Group name");
      name.oninput = () => {
        rule.name = name.value;
        markDirty();
      };
      nameLabel.append(name);
      const prefixLabel = document.createElement("label");
      prefixLabel.className = "fixtureZoneField";
      prefixLabel.append(document.createTextNode("Command prefix"));
      const prefix = document.createElement("input");
      prefix.value = rule.prefix;
      prefix.maxLength = 32;
      prefix.placeholder = "prefix";
      prefix.setAttribute("aria-label", "Group prefix");
      prefix.oninput = () => {
        rule.prefix = prefix.value.trim().toLowerCase();
        markDirty();
      };
      prefixLabel.append(prefix);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger iconButton";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Delete group");
      remove.title = "Delete group";
      remove.onclick = (event) => {
        event.stopPropagation();
        if (!confirm(`Delete ${rule.name || "this group"}? Its fixtures will become available.`))
          return;
        draftRules = draftRules.filter((row) => row.id !== rule.id);
        renderBoard();
        markDirty();
      };
      controls.prepend(nameLabel, prefixLabel);
      controls.append(remove);
    }
    controls.onclick = (event) => event.stopPropagation();
    return controls;
  }
  function renderBoard() {
    renderViewerGroups({
      host: $("twitchFixtureBoard"),
      rules: draftRules,
      fixtures: allFixtures(),
      selected: selectedGroup,
      choose: (id) => {
        selectedGroup = id;
        renderBoard();
      },
      controls: groupControls,
      move: moveFixture,
    });
  }
  function accept(value) {
    state = value;
    $("twitchProgramControls").disabled = false;
    if (!busy && section !== "effects") $("saveTwitchProgram").disabled = false;
    draftRules = normalizedRules(state.rules);
    $("twitchRoutingMode").value = state.mode === "off" ? "off" : "assignments";
    $("viewerColorsEnabled").checked = state.mode !== "off";
    $("parserFuzzy").checked = state.parser.allowFuzzy;
    $("parserDescriptors").checked = state.parser.allowDescriptors;
    $("parserDefaultBrightness").value = state.parser.defaultBrightness;
    $("viewerBrightnessValue").value = state.parser.defaultBrightness + "%";
    $("teachColorPreview").checked = state.teaching?.preview !== false;
    $("teachColorChatSuccess").checked = state.teaching?.chatSuccess === true;
    $("teachColorChatFailure").checked = state.teaching?.chatFailure === true;
    selectedGroup ||= "active-fixtures";
    renderBoard();
    changed(structuredClone(state.rules));
  }
  function payloadRules() {
    return draftRules
      .filter((row) => row.id !== "active-fixtures" || row.fixtureIds.length)
      .map((row) => ({
        ...row,
        name: row.id === "active-fixtures" ? "Active Fixtures" : row.name.trim(),
        prefix: row.id === "active-fixtures" ? "" : row.prefix.trim().toLowerCase(),
        fixtureIds: [...row.fixtureIds],
      }));
  }
  function dirty() {
    if (!state?.ok) return false;
    const original = normalizedRules(state.rules).filter(
      (row) => row.id !== "active-fixtures" || row.fixtureIds.length,
    );
    return (
      JSON.stringify(payloadRules()) !== JSON.stringify(original) ||
      $("twitchRoutingMode").value !== state.mode ||
      $("parserFuzzy").checked !== state.parser.allowFuzzy ||
      $("parserDescriptors").checked !== state.parser.allowDescriptors ||
      Number($("parserDefaultBrightness").value) !== state.parser.defaultBrightness ||
      $("teachColorPreview").checked !== (state.teaching?.preview !== false) ||
      $("teachColorChatSuccess").checked !== (state.teaching?.chatSuccess === true) ||
      $("teachColorChatFailure").checked !== (state.teaching?.chatFailure === true)
    );
  }
  async function save() {
    if (!state?.ok) return;
    if (busy) return;
    const rules = payloadRules();
    if (rules.some((row) => !row.name || (row.id !== "active-fixtures" && !row.prefix))) {
      notice("Every created group needs a name and prefix.");
      return;
    }
    const payload = {
      revision: state.revision,
      mode: $("twitchRoutingMode").value,
      parser: {
        allowFuzzy: $("parserFuzzy").checked,
        allowDescriptors: $("parserDescriptors").checked,
        defaultBrightness: Number($("parserDefaultBrightness").value),
      },
      teaching: {
        preview: $("teachColorPreview").checked,
        chatSuccess: $("teachColorChatSuccess").checked,
        chatFailure: $("teachColorChatFailure").checked,
      },
      rules,
    };
    busy = true;
    $("saveTwitchProgram").disabled = true;
    $("twitchProgramControls").disabled = true;
    try {
      const result = await request("/twitch/lights", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      accept(result);
      notice(
        result.mode === "assignments"
          ? "Fixture assignments saved. Redemption colors will be sent only to these active fixtures and prefix groups."
          : "Channel-point lighting is off.",
      );
    } catch (error) {
      notice(
        error.message === "twitch_routing_conflict"
          ? "The program changed in another window. Refresh before saving."
          : error.message,
      );
    } finally {
      busy = false;
      $("saveTwitchProgram").disabled = false;
      $("twitchProgramControls").disabled = false;
    }
  }
  $("addTwitchFixtureGroup").onclick = () => {
    draftRules.push({
      id: globalThis.RaveLinkRandomId(),
      name: "New group",
      prefix: "",
      enabled: true,
      fixtureIds: [],
    });
    selectedGroup = draftRules.at(-1).id;
    renderBoard();
    markDirty();
  };
  for (const id of [
    "twitchRoutingMode",
    "parserFuzzy",
    "parserDescriptors",
    "parserDefaultBrightness",
    "teachColorPreview",
    "teachColorChatSuccess",
    "teachColorChatFailure",
  ])
    $(id).addEventListener("change", markDirty);
  $("saveTwitchProgram").onclick = () => (section === "effects" ? saveEffects() : save());
  for (const id of ["twitchEffectsEnabled", "twitchEffectsReturn"])
    $(id).onchange = () => {
      $("twitchEffectsNotice").textContent = "UNSAVED DYNAMIC COMMAND CHANGES";
    };
  $("refreshTwitchProgram").onclick = async () => {
    if (section === "rave") {
      await viewerRave.refresh();
      return;
    }
    if (section === "effects") {
      if (
        $("twitchEffectsNotice").textContent.startsWith("UNSAVED") &&
        !confirm("Discard unsaved effect changes?")
      )
        return;
      await loadEffects();
      return;
    }
    if (dirty() && !confirm("Discard unsaved Twitch fixture layout edits?")) return;
    try {
      accept(await request("/twitch/lights"));
      notice("Program refreshed.");
    } catch (error) {
      notice(error.message);
    }
  };
  $("previewTwitchColor").onclick = async () => {
    try {
      const result = await request("/twitch/lights/preview", {
        method: "POST",
        body: JSON.stringify({ text: $("twitchColorExample").value }),
      });
      $("twitchPreviewSwatch").style.backgroundColor = /^#[0-9a-f]{6}$/i.test(result.hex)
        ? result.hex
        : "transparent";
      $("twitchPreviewResult").textContent = result.effect
        ? `${String(result.effect).toUpperCase()}${result.speed ? ` // ${String(result.speed).toUpperCase()}` : ""} // ${result.targets.length} effect targets\n${result.targets.join(", ")}`
        : `${result.hex || "Brightness only"} // ${result.brightnessPercent}% // ${result.targets.length} targets, ${result.skippedTargets} skipped\n${result.targets.join(", ")}${dirty() ? "\nSaved program preview; unsaved edits are not applied." : ""}`;
    } catch (error) {
      $("twitchPreviewSwatch").style.backgroundColor = "transparent";
      $("twitchPreviewResult").textContent = error.message;
    }
  };
  if (state?.ok) accept(state);
  else {
    notice("Add a light and enable viewer access in Fixtures to configure color groups.");
    $("twitchProgramControls").disabled = true;
    $("saveTwitchProgram").disabled = true;
  }
  if (effectState?.ok) {
    $("twitchEffectsEnabled").checked = effectState.enabled === true;
    $("twitchEffectsReturn").checked = effectState.returnEffect === true;
    renderEffectFixtures();
  } else void loadEffects();
  return {
    refreshFixtures: () => {
      renderBoard();
      renderEffectFixtures();
    },
  };
}
