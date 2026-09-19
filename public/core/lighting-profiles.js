(() => {
  const ui = window.RaveLinkCoreUi;
  if (!ui) return;
  const element = id => document.getElementById(id);
  let profiles = [];
  let selectedId = "";
  let layoutLoader = null;
  let labLoader = null;
  let editorDirty = false;

  const blankTarget = () => ({ on: true, brightness: 100, mode: "color", color: "#ffffff", temperatureKelvin: 3500 });
  const slug = value => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || `profile-${Date.now()}`;

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
      root.querySelector("[data-temperature-output]").value = `${root.querySelector('[data-field="temperatureKelvin"]').value}K`;
      root.querySelector("[data-brightness-output]").value = `${root.querySelector('[data-field="brightness"]').value}%`;
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
      brightness: Number(root.querySelector('[data-field="brightness"]').value)
    };
  }

  function activeProfile() {
    return profiles.find(row => row.id === selectedId) || null;
  }

  function setStrategyVisibility() {
    const shared = element("lightingProfileStrategy").value === "shared";
    element("sharedLightingTarget").hidden = !shared;
    document.querySelectorAll("#lightingProfileFixtures .profileTargetControls").forEach(row => { row.hidden = shared; });
  }

  function render() {
    const profile = activeProfile();
    element("lightingProfileName").value = profile?.name || "";
    element("lightingProfileDefault").checked = profile?.isDefault === true;
    element("lightingProfileStrategy").value = profile?.strategy || "individual";
    element("deleteLightingProfile").disabled = !profile;
    element("applyLightingProfile").disabled = !profile;

    const sharedHost = element("sharedLightingTarget");
    sharedHost.replaceChildren(targetControls(profile?.sharedTarget || blankTarget(), { minimumKelvin: 2000, maximumKelvin: 6500 }, "shared"));
    const grid = element("lightingProfileFixtures");
    grid.replaceChildren();
    const currentFixtures = ui.fixtures();
    if (!currentFixtures.length) {
      const empty = document.createElement("p");
      empty.textContent = "Add a fixture first, then return here to route it into a profile.";
      grid.append(empty);
    }
    for (const fixture of currentFixtures) {
      const target = profile?.fixtureTargets?.[fixture.id] || blankTarget();
      const card = document.createElement("article");
      card.className = `profileFixtureCard${profile?.fixtureTargets?.[fixture.id] ? " routed" : ""}`;
      card.dataset.fixtureId = fixture.id;
      const head = document.createElement("div");
      head.className = "profileFixtureHead";
      const name = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = fixture.name || fixture.id;
      const detail = document.createElement("span");
      detail.className = "sub";
      detail.textContent = `${String(fixture.brand).toUpperCase()} // ${fixture.zone || "NO ZONE"}`;
      name.append(strong, detail);
      const route = document.createElement("label");
      route.className = "checkLabel";
      route.title = "Include this fixture whenever this profile is applied.";
      route.innerHTML = `<input data-route type="checkbox" ${profile?.fixtureTargets?.[fixture.id] ? "checked" : ""}> ROUTED`;
      route.querySelector("input").onchange = event => card.classList.toggle("routed", event.target.checked);
      head.append(name, route);
      card.append(head, targetControls(target, fixture.temperatureRange || { minimumKelvin: 2000, maximumKelvin: 6500 }, fixture.id));
      grid.append(card);
    }
    setStrategyVisibility();
  }

  function populateSelect() {
    const select = element("lightingProfileSelect");
    select.replaceChildren(new Option("NEW PROFILE", ""), ...profiles.map(row => new Option(`${row.name}${row.isDefault ? " // DEFAULT" : ""}`, row.id)));
    select.value = selectedId;
  }

  function renderQuickBar() {
    const host = element("lightingProfileQuickBar");
    host.replaceChildren();
    if (!profiles.length) { const empty = document.createElement("span"); empty.className = "effectHelp"; empty.textContent = "NO SAVED PROFILES"; host.append(empty); return; }
    for (const profile of profiles) {
      const button = document.createElement("button"); button.type = "button"; button.className = "profileQuickButton";
      button.textContent = `${profile.name}${profile.isDefault ? " // DEFAULT" : ""}`;
      button.title = `Apply ${profile.name} and stop active effects on its routed fixtures.`;
      button.onclick = async () => {
        const status = element("lightingProfileQuickStatus"); button.disabled = true; status.textContent = "APPLYING";
        try { const result = await ui.request(`/lighting-profiles/${encodeURIComponent(profile.id)}/apply`, { method: "POST", body: "{}" }); status.textContent = `${profile.name.toUpperCase()} // ${result.sent} APPLIED`; status.className = "statusLine ok"; }
        catch (error) { status.textContent = error.message; status.className = "statusLine bad"; }
        finally { button.disabled = false; }
      };
      host.append(button);
    }
  }

  async function load() {
    const result = await ui.request("/lighting-profiles");
    profiles = result.profiles || [];
    if (selectedId && !profiles.some(row => row.id === selectedId)) selectedId = "";
    populateSelect();
    renderQuickBar();
    if (!editorDirty) render();
  }

  function draft() {
    const existing = activeProfile();
    const name = element("lightingProfileName").value.trim();
    const fixtureTargets = {};
    document.querySelectorAll("#lightingProfileFixtures .profileFixtureCard").forEach(card => {
      if (card.querySelector("[data-route]").checked) fixtureTargets[card.dataset.fixtureId] = readTarget(card.querySelector(".profileTargetControls"));
    });
    return {
      id: existing?.id || slug(name), name, isDefault: element("lightingProfileDefault").checked,
      strategy: element("lightingProfileStrategy").value,
      sharedTarget: readTarget(element("sharedLightingTarget").querySelector(".profileTargetControls")),
      fixtureTargets
    };
  }

  element("lightingProfileSelect").onchange = event => { selectedId = event.target.value; editorDirty = false; render(); };
  element("lightingProfileStrategy").onchange = setStrategyVisibility;
  element("newLightingProfile").onclick = () => { selectedId = ""; editorDirty = false; populateSelect(); render(); };
  const profilePanel = element("lightingProfileName").closest('[data-light-panel="profiles"]');
  profilePanel.addEventListener("input", () => { editorDirty = true; });
  profilePanel.addEventListener("change", () => { editorDirty = true; });
  element("saveLightingProfile").onclick = async () => {
    try {
      const payload = draft();
      if (!payload.name) throw new Error("Give this profile a name first.");
      const result = await ui.request("/lighting-profiles", { method: "POST", body: JSON.stringify(payload) });
      selectedId = result.profile.id;
      editorDirty = false;
      await load();
      ui.showResult("lightingProfileResult", "Profile saved. Its routed fixtures and white/color modes are ready.");
    } catch (error) { ui.showResult("lightingProfileResult", error.message, true); }
  };
  element("applyLightingProfile").onclick = async () => {
    try {
      if (!selectedId) throw new Error("Save or select a profile first.");
      const result = await ui.request(`/lighting-profiles/${encodeURIComponent(selectedId)}/apply`, { method: "POST", body: "{}" });
      ui.showResult("lightingProfileResult", `Applied ${activeProfile()?.name || "profile"}: ${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed.`);
    } catch (error) { ui.showResult("lightingProfileResult", error.message, true); }
  };
  element("applyDefaultLightingProfile").onclick = async () => {
    try {
      const result = await ui.request("/lighting-profiles/default/apply", { method: "POST", body: "{}" });
      ui.showResult("lightingProfileResult", `Default profile applied to ${result.sent} fixture${result.sent === 1 ? "" : "s"}.`);
    } catch (error) { ui.showResult("lightingProfileResult", error.message, true); }
  };
  element("deleteLightingProfile").onclick = async () => {
    const profile = activeProfile();
    if (!profile || !confirm(`Delete lighting profile ${profile.name}?`)) return;
    try {
      await ui.request(`/lighting-profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
      selectedId = "";
      await load();
      ui.showResult("lightingProfileResult", "Profile deleted.");
    } catch (error) { ui.showResult("lightingProfileResult", error.message, true); }
  };

  document.querySelectorAll("[data-light-tab]").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll("[data-light-tab]").forEach(row => row.classList.toggle("active", row === button));
    document.querySelectorAll("[data-light-panel]").forEach(panel => { panel.hidden = panel.dataset.lightPanel !== button.dataset.lightTab; });
    if (button.dataset.lightTab === "profiles") load().catch(error => ui.showResult("lightingProfileResult", error.message, true));
    if (button.dataset.lightTab === "layout") {
      layoutLoader ||= import("/lighting-layout.js").then(module => module.initLightingLayout());
      layoutLoader.catch(error => { element("lightingLayoutResult").textContent = error.message; });
    }
    if (button.dataset.lightTab === "lab") {
      labLoader ||= import("/lighting-lab.js").then(module => module.initLightingLab());
      labLoader.catch(error => { element("lightingLabNotice").textContent = error.message; });
    }
  }));
  populateSelect();
  render();
  void load().catch(error => { element("lightingProfileQuickStatus").textContent = error.message; });
})();
