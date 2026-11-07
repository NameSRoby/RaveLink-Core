/**
 * Lighting profiles.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#lighting-and-dynamic-effects
 */
(() => {
  const ui = window.RaveLinkCoreUi;
  if (!ui) return;
  const element = (id) => document.getElementById(id);
  let profiles = [];
  let selectedId = "";
  let layoutLoader = null;
  let labLoader = null;
  let editorDirty = false;
  let selectedFixture = "";
  const fixtureEditors = new Map();

  const blankTarget = () => ({
    on: true,
    brightness: 100,
    mode: "color",
    color: "#ffffff",
    temperatureKelvin: 3500,
  });
  const slug = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || `profile-${Date.now()}`;

  function targetControls(target, range, prefix) {
    const root = document.createElement("div");
    root.className = "profileTargetControls";
    root.dataset.target = prefix;
    root.innerHTML = `
      <label class="checkLabel" title="Turn this light on when the profile is applied."><input data-field="on" type="checkbox" ${target.on !== false ? "checked" : ""}> POWER ON</label>
      <label>OUTPUT MODE<select data-field="mode"><option value="color">RGB COLOR</option><option value="temperature">WHITE TEMPERATURE</option></select></label>
      <label data-color-field>COLOR<input data-field="color" type="color" value="${target.color || "#ffffff"}"></label>
      <label data-temperature-field>WHITE TEMPERATURE<input data-field="temperatureKelvin" type="range" min="${range.minimumKelvin}" max="${range.maximumKelvin}" step="50" value="${Math.min(range.maximumKelvin, Math.max(range.minimumKelvin, Number(target.temperatureKelvin || 3500)))}"><output data-temperature-output></output></label>
      <label>BRIGHTNESS<input data-field="brightness" type="range" min="1" max="100" value="${Number(target.brightness || 100)}"><output data-brightness-output></output></label>
      <p class="profileTemperatureHelp">White mode: ${range.minimumKelvin}K warm to ${range.maximumKelvin}K cool. The device receives a dedicated color-temperature command.</p>`;
    const mode = root.querySelector('[data-field="mode"]');
    mode.value = target.mode === "temperature" ? "temperature" : "color";
    const sync = () => {
      const temperature = mode.value === "temperature";
      root.querySelector("[data-color-field]").hidden = temperature;
      root.querySelector("[data-temperature-field]").hidden = !temperature;
      root.querySelector("[data-temperature-output]").value =
        `${root.querySelector('[data-field="temperatureKelvin"]').value}K`;
      root.querySelector("[data-brightness-output]").value =
        `${root.querySelector('[data-field="brightness"]').value}%`;
    };
    root.addEventListener("input", sync);
    sync();
    return root;
  }

  function readTarget(root) {
    return {
      on: root.querySelector('[data-field="on"]').checked,
      mode: root.querySelector('[data-field="mode"]').value,
      color: root.querySelector('[data-field="color"]').value,
      temperatureKelvin: Number(root.querySelector('[data-field="temperatureKelvin"]').value),
      brightness: Number(root.querySelector('[data-field="brightness"]').value),
    };
  }

  function activeProfile() {
    return profiles.find((row) => row.id === selectedId) || null;
  }

  function setStrategyVisibility() {
    const shared = element("lightingProfileStrategy").value === "shared";
    const selected = fixtureEditors.get(selectedFixture);
    element("sharedLightingTarget").hidden = !shared || !selected?.route.checked;
    element("lightingProfileFixtureSettings").replaceChildren();
    if (selected?.route.checked) {
      element("lightingProfileFixtureTitle").textContent = shared
        ? "All profile fixtures"
        : selected.name;
      if (!shared) element("lightingProfileFixtureSettings").append(selected.controls);
    } else element("lightingProfileFixtureTitle").textContent = "Select a fixture to edit";
    element("lightingProfileFixtureHint").hidden = !!selected?.route.checked;
    for (const [id, row] of fixtureEditors)
      row.select.setAttribute("aria-pressed", String(id === selectedFixture));
  }

  function render() {
    const profile = activeProfile();
    element("lightingProfileName").value = profile?.name || "";
    element("lightingProfileDefault").checked = profile?.isDefault === true;
    element("lightingProfileStrategy").value = profile?.strategy || "individual";
    element("deleteLightingProfile").disabled = !profile;
    element("applyLightingProfile").disabled = !profile;

    const sharedHost = element("sharedLightingTarget");
    sharedHost.replaceChildren(
      targetControls(
        profile?.sharedTarget || blankTarget(),
        { minimumKelvin: 2000, maximumKelvin: 6500 },
        "shared",
      ),
    );
    const grid = element("lightingProfileFixtures");
    grid.replaceChildren();
    const available = element("lightingProfileAvailableFixtures");
    available.replaceChildren();
    fixtureEditors.clear();
    selectedFixture = "";
    const currentFixtures = ui.fixtures();
    if (!currentFixtures.length) {
      const empty = document.createElement("p");
      empty.textContent = "Add a fixture first, then return here to route it into a profile.";
      available.append(empty);
    }
    for (const fixture of currentFixtures) {
      const target = profile?.fixtureTargets?.[fixture.id] || blankTarget();
      const card = document.createElement("article");
      card.className = `profileFixtureCard${profile?.fixtureTargets?.[fixture.id] ? " routed" : ""}`;
      card.dataset.fixtureId = fixture.id;
      const head = document.createElement("div");
      head.className = "profileFixtureHead";
      const name = document.createElement("button");
      name.type = "button";
      name.className = "profileFixtureSelect";
      name.setAttribute("aria-pressed", "false");
      const strong = document.createElement("strong");
      strong.textContent = fixture.name || fixture.id;
      const detail = document.createElement("span");
      detail.className = "sub";
      detail.textContent = `${String(fixture.brand).toUpperCase()} // ${fixture.zone || "NO ZONE"}`;
      name.append(strong, detail);
      const route = document.createElement("label");
      route.className = "checkLabel";
      route.title = "Include this fixture whenever this profile is applied.";
      route.innerHTML = `<input data-route type="checkbox" ${profile?.fixtureTargets?.[fixture.id] ? "checked" : ""}> Include`;
      const checkbox = route.querySelector("input");
      const controls = targetControls(
        target,
        fixture.temperatureRange || { minimumKelvin: 2000, maximumKelvin: 6500 },
        fixture.id,
      );
      fixtureEditors.set(fixture.id, {
        controls,
        route: checkbox,
        select: name,
        name: fixture.name || fixture.id,
      });
      name.onclick = () => {
        if (!checkbox.checked) {
          checkbox.checked = true;
          checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        }
        selectedFixture = fixture.id;
        setStrategyVisibility();
      };
      checkbox.onchange = () => {
        card.classList.toggle("routed", checkbox.checked);
        (checkbox.checked ? grid : available).append(card);
        if (!checkbox.checked && selectedFixture === fixture.id) selectedFixture = "";
        setStrategyVisibility();
      };
      head.append(name, route);
      card.append(head);
      (checkbox.checked ? grid : available).append(card);
    }
    setStrategyVisibility();
  }

  function populateSelect() {
    const select = element("lightingProfileSelect");
    select.replaceChildren(
      new Option("NEW PROFILE", ""),
      ...profiles.map(
        (row) => new Option(`${row.name}${row.isDefault ? " // DEFAULT" : ""}`, row.id),
      ),
    );
    select.value = selectedId;
    const cards = element("lightingProfileCards");
    cards.replaceChildren();
    for (const profile of profiles) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lightingProfileCard";
      button.setAttribute("aria-pressed", String(profile.id === selectedId));
      const title = document.createElement("strong"),
        detail = document.createElement("small"),
        swatches = document.createElement("span");
      title.textContent = profile.name;
      detail.textContent = `${Object.keys(profile.fixtureTargets || {}).length} fixtures${profile.isDefault ? " · Default" : ""}`;
      swatches.className = "profilePalettePreview";
      for (const target of Object.values(profile.fixtureTargets || {}).slice(0, 6)) {
        const dot = document.createElement("i");
        dot.style.background =
          target.on === false
            ? "#334155"
            : /^#[0-9a-f]{6}$/i.test(target.color)
              ? target.color
              : "#ffffff";
        swatches.append(dot);
      }
      button.append(swatches, title, detail);
      button.onclick = () => {
        selectedId = profile.id;
        editorDirty = false;
        populateSelect();
        render();
      };
      cards.append(button);
    }
  }

  function renderQuickBar() {
    const host = element("lightingProfileQuickBar");
    host.replaceChildren();
    if (!profiles.length) {
      const empty = document.createElement("span");
      empty.className = "effectHelp";
      empty.textContent = "NO SAVED PROFILES";
      host.append(empty);
      return;
    }
    for (const profile of profiles) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "profileQuickButton";
      button.textContent = `${profile.name}${profile.isDefault ? " // DEFAULT" : ""}`;
      button.title = `Apply ${profile.name} and stop active effects on its routed fixtures.`;
      button.onclick = async () => {
        const status = element("lightingProfileQuickStatus");
        button.disabled = true;
        status.textContent = "APPLYING";
        try {
          const result = await ui.request(
            `/lighting-profiles/${encodeURIComponent(profile.id)}/apply`,
            { method: "POST", body: "{}" },
          );
          status.textContent = `${profile.name.toUpperCase()} // ${result.sent} APPLIED`;
          status.className = "statusLine ok";
        } catch (error) {
          status.textContent = error.message;
          status.className = "statusLine bad";
        } finally {
          button.disabled = false;
        }
      };
      host.append(button);
    }
  }

  async function load() {
    const result = await ui.request("/lighting-profiles");
    profiles = result.profiles || [];
    if (selectedId && !profiles.some((row) => row.id === selectedId)) selectedId = "";
    populateSelect();
    renderQuickBar();
    if (!editorDirty) render();
  }

  function draft() {
    const existing = activeProfile();
    const name = element("lightingProfileName").value.trim();
    const fixtureTargets = { ...existing?.fixtureTargets };
    for (const [id, row] of fixtureEditors) {
      if (row.route.checked) fixtureTargets[id] = readTarget(row.controls);
      else delete fixtureTargets[id];
    }
    return {
      id: existing?.id || slug(name),
      name,
      isDefault: element("lightingProfileDefault").checked,
      strategy: element("lightingProfileStrategy").value,
      sharedTarget: readTarget(
        element("sharedLightingTarget").querySelector(".profileTargetControls"),
      ),
      fixtureTargets,
    };
  }

  element("lightingProfileSelect").onchange = (event) => {
    selectedId = event.target.value;
    editorDirty = false;
    render();
  };
  element("lightingProfileStrategy").onchange = setStrategyVisibility;
  element("newLightingProfile").onclick = () => {
    selectedId = "";
    editorDirty = false;
    populateSelect();
    render();
  };
  const profilePanel = element("lightingProfileName").closest('[data-light-panel="profiles"]');
  profilePanel.addEventListener("input", () => {
    editorDirty = true;
  });
  profilePanel.addEventListener("change", () => {
    editorDirty = true;
  });
  element("saveLightingProfile").onclick = async () => {
    try {
      const payload = draft();
      if (!payload.name) throw new Error("Give this profile a name first.");
      if (!Object.keys(payload.fixtureTargets).length)
        throw new Error("Add at least one fixture to this profile.");
      const result = await ui.request("/lighting-profiles", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      selectedId = result.profile.id;
      editorDirty = false;
      await load();
      ui.showResult(
        "lightingProfileResult",
        "Profile saved. Its routed fixtures and white/color modes are ready.",
      );
    } catch (error) {
      ui.showResult("lightingProfileResult", error.message, true);
    }
  };
  element("applyLightingProfile").onclick = async () => {
    try {
      if (!selectedId) throw new Error("Save or select a profile first.");
      const result = await ui.request(
        `/lighting-profiles/${encodeURIComponent(selectedId)}/apply`,
        { method: "POST", body: "{}" },
      );
      ui.showResult(
        "lightingProfileResult",
        `Applied ${activeProfile()?.name || "profile"}: ${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed.`,
      );
    } catch (error) {
      ui.showResult("lightingProfileResult", error.message, true);
    }
  };
  element("applyDefaultLightingProfile").onclick = async () => {
    try {
      const result = await ui.request("/lighting-profiles/default/apply", {
        method: "POST",
        body: "{}",
      });
      ui.showResult(
        "lightingProfileResult",
        `Default profile applied to ${result.sent} fixture${result.sent === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      ui.showResult("lightingProfileResult", error.message, true);
    }
  };
  element("deleteLightingProfile").onclick = async () => {
    const profile = activeProfile();
    if (!profile || !confirm(`Delete lighting profile ${profile.name}?`)) return;
    try {
      await ui.request(`/lighting-profiles/${encodeURIComponent(profile.id)}`, {
        method: "DELETE",
      });
      selectedId = "";
      await load();
      ui.showResult("lightingProfileResult", "Profile deleted.");
    } catch (error) {
      ui.showResult("lightingProfileResult", error.message, true);
    }
  };

  const lightTabs = [...document.querySelectorAll("[data-light-tab]")];
  const workspaceHelp = {
    control:
      "Direct control: set lights yourself or test a saved viewer route. Tests send real light commands.",
    viewer:
      "Viewer controls: enable Rave, choose which lights viewers can use, and set command permissions. Connect the Channel Points reward through Twitch Integration.",
    music:
      "Choose a look in Play. Song triggers live in Automation; calibration and room setup are in Audio & lights.",
    profiles: "Light profiles: save and recall a room's colors, brightness and power states.",
    commands:
      "Light commands: copy instructions for viewers based on your saved routes and permissions.",
    layout: "Place fixtures in your room to direct spatial effects.",
  };
  lightTabs.forEach((button, index) => {
    const key = button.dataset.lightTab;
    button.id = "light-tab-" + key;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "light-panel-" + key);
    button.setAttribute("aria-selected", String(index === 0));
    button.tabIndex = index === 0 ? 0 : -1;
    const panel = document.querySelector(`[data-light-panel="${key}"]`);
    panel.id = "light-panel-" + key;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    button.addEventListener("keydown", (event) => {
      const next = {
        ArrowRight: (index + 1) % lightTabs.length,
        ArrowLeft: (index + lightTabs.length - 1) % lightTabs.length,
        Home: 0,
        End: lightTabs.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      lightTabs[next].focus();
      lightTabs[next].click();
    });
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-light-tab]").forEach((row) => {
        row.classList.toggle("active", row === button);
        row.setAttribute("aria-selected", String(row === button));
        row.tabIndex = row === button ? 0 : -1;
      });
      element("lightWorkspaceHelp").textContent = workspaceHelp[key];
      element("lightWorkspaceHelp").hidden = ["music", "viewer"].includes(key);
      document.querySelectorAll("[data-light-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.lightPanel !== button.dataset.lightTab;
      });
      if (button.dataset.lightTab === "profiles")
        load().catch((error) => ui.showResult("lightingProfileResult", error.message, true));
      if (button.dataset.lightTab === "layout") {
        layoutLoader ||= import("/lighting-layout.js").then((module) =>
          module.initLightingLayout(),
        );
        layoutLoader.catch((error) => {
          element("lightingLayoutResult").textContent = error.message;
        });
      }
      if (["viewer", "commands"].includes(button.dataset.lightTab)) {
        labLoader ||= import("/lighting-lab.js").then((module) => module.initLightingLab());
        labLoader.catch((error) => {
          element("lightingLabNotice").textContent = error.message;
        });
      }
    });
  });
  populateSelect();
  render();
  void load().catch((error) => {
    element("lightingProfileQuickStatus").textContent = error.message;
  });
})();
