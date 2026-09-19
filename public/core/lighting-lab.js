export function initLightingLab() {
  const ui = window.RaveLinkCoreUi;
  if (!ui) return null;
  const element = id => document.getElementById(id);
  let state = null, layout = null, loaded = false;
  const fixtureName = id => ui.fixtures().find(row => row.id === id)?.name || id;

  function payload() {
    const excludedFixtureIds = [...document.querySelectorAll('[data-lab-excluded]:checked')].map(row => row.dataset.labExcluded);
    const latencyOffsets = Object.fromEntries([...document.querySelectorAll('[data-lab-latency]')].map(row => [row.dataset.labLatency, Number(row.value || 0)]).filter(([, value]) => value !== 0));
    return { revision: state.revision, excludedFixtureIds, latencyOffsets, brightnessLimit: Number(element("labBrightnessLimit").value),
      durationSeconds: Number(element("labDurationSeconds").value), repeatCount: Number(element("labRepeatCount").value), cooldownSeconds: Number(element("labCooldownSeconds").value),
      restorePrevious: element("labRestorePrevious").checked, spatialDirection: element("labSpatialDirection").value,
      spatialOriginFixtureId: element("labSpatialOrigin").value, chaseGapMs: Number(element("labChaseGap").value), chaseRoutes: state.chaseRoutes, presets: state.presets };
  }
  function notice(text, bad = false) { element("lightingLabNotice").textContent = text; element("lightingLabNotice").className = `notice${bad ? " bad" : ""}`; }
  function renderFixtures() {
    const host = element("lightingLabFixtures"); host.replaceChildren();
    for (const row of state.capabilities || []) {
      const card = document.createElement("article"); card.className = `labFixtureCard${row.excluded ? " excluded" : ""}`;
      card.innerHTML = `<div class="labFixtureHead"><div><strong></strong><span></span></div><button type="button" data-health-test>TEST</button></div>
        <div class="labCapabilityRow"><span>RGB ${row.rgb ? "YES" : "NO"}</span><span>WHITE ${row.tunableWhite ? "YES" : "NO"}</span><span>POSITION ${row.spatial ? "SET" : "MISSING"}</span><span>SEGMENTS ${row.segments ? "YES" : "NO"}</span></div>
        <label class="switchLabel"><input type="checkbox" data-lab-excluded="${row.id}" ${row.excluded ? "checked" : ""}><span class="toggleSwitch" aria-hidden="true"></span><span>TEMPORARILY EXCLUDE</span></label>
        <label>MANUAL VISUAL ADJUSTMENT MS<input type="number" min="-2000" max="2000" step="25" value="${row.latencyOffsetMs}" data-lab-latency="${row.id}" title="This is a visual correction, not measured network latency. Use a negative value to delay a fixture that consistently changes first, or a positive value to advance one that consistently changes late."></label>
        <p class="effectHelp"></p>`;
      card.querySelector("strong").textContent = row.name;
      card.querySelector(".labFixtureHead span").textContent = `${String(row.brand).toUpperCase()} // ${String(row.connectivity).replaceAll("_", " ").toUpperCase()}`;
      card.querySelector(".effectHelp").textContent = row.segments ? "Independent segments available." : row.segmentReason;
      card.querySelector("[data-health-test]").onclick = async event => {
        const button = event.currentTarget, startedAt = performance.now(); button.disabled = true; button.textContent = "TESTING";
        try { const result = await ui.request(`/fixtures/${encodeURIComponent(row.id)}/test`, { method: "POST", body: "{}" }); const latency = Math.round(performance.now() - startedAt); button.textContent = result.reachable ? `REACHABLE // ${latency}MS` : `NO RESPONSE // ${latency}MS`; }
        catch { button.textContent = "FAILED"; }
        button.disabled = false;
      };
      card.querySelector("[data-lab-excluded]").onchange = event => card.classList.toggle("excluded", event.currentTarget.checked);
      host.append(card);
    }
  }
  function renderPresets() {
    const host = element("lightingLabPresets"); host.replaceChildren();
    for (const preset of state.presets || []) {
      const card = document.createElement("article"); card.innerHTML = `<div><strong></strong><code></code></div><div class="actions"><button type="button" data-load>LOAD</button><button type="button" data-run>RUN</button><button type="button" class="danger" data-remove>REMOVE</button></div>`;
      card.querySelector("strong").textContent = preset.name; card.querySelector("code").textContent = preset.command;
      card.querySelector("[data-load]").onclick = () => { element("labPreviewCommand").value = preset.command; };
      card.querySelector("[data-run]").onclick = async () => { try { const result = await ui.request("/twitch/lights/test", { method: "POST", body: JSON.stringify({ text: preset.command }) }); notice(`${preset.name.toUpperCase()} RUN // ${result.targets?.length || 0} TARGETS`); await load(true); } catch (error) { notice(error.message, true); } };
      card.querySelector("[data-remove]").onclick = async () => { state.presets = state.presets.filter(row => row.id !== preset.id); await save(); };
      host.append(card);
    }
  }
  function renderHistory() {
    const body = element("lightingLabHistory"); body.replaceChildren();
    if (!state.history?.length) { const row = body.insertRow(); const cell = row.insertCell(); cell.colSpan = 5; cell.textContent = "NO COMMANDS RECORDED"; return; }
    for (const entry of state.history) {
      const row = body.insertRow();
      for (const value of [new Date(entry.at).toLocaleTimeString(), entry.source.toUpperCase(), entry.command, entry.targets.map(fixtureName).join(", ") || "NONE", `${entry.sent} SENT // ${entry.failed} FAILED`]) row.insertCell().textContent = value;
    }
  }
  function renderMap(targets = []) {
    const map = element("lightingLabMap"), front = map.querySelector(".roomFrontLabel"); map.replaceChildren(front || Object.assign(document.createElement("span"), { className: "roomFrontLabel", textContent: "FRONT" }));
    const selected = new Set(targets);
    for (const [id, place] of Object.entries(layout?.placements || {})) {
      const marker = document.createElement("span"); marker.className = `layoutMarker ${place.kind}${selected.has(id) ? " previewTarget" : ""}`;
      marker.style.left = `${place.x * 100}%`; marker.style.top = `${place.y * 100}%`; marker.style.setProperty("--rotation", `${place.rotation}deg`); marker.textContent = fixtureName(id).slice(0, 3).toUpperCase(); marker.title = fixtureName(id); map.append(marker);
    }
  }
  function render() {
    element("labBrightnessLimit").value = state.brightnessLimit; element("labBrightnessLimitValue").value = `${state.brightnessLimit}%`;
    element("labDurationSeconds").value = state.durationSeconds; element("labRepeatCount").value = state.repeatCount; element("labCooldownSeconds").value = state.cooldownSeconds;
    element("labChaseGap").value = state.chaseGapMs;
    element("labRestorePrevious").checked = state.restorePrevious; element("labSpatialDirection").value = state.spatialDirection;
    const origin = element("labSpatialOrigin"), previous = state.spatialOriginFixtureId; origin.replaceChildren(new Option("ROOM CENTER", ""), ...ui.fixtures().map(row => new Option(row.name || row.id, row.id))); origin.value = previous;
    renderFixtures(); renderPresets(); renderHistory(); renderMap();
  }
  async function load(force = false) { if (loaded && !force) return; [state, layout] = await Promise.all([ui.request("/lighting-lab"), ui.request("/lighting-layout")]); loaded = true; render(); }
  async function save() { try { state = await ui.request("/lighting-lab", { method: "POST", body: JSON.stringify(payload()) }); notice("LIGHT LAB SAVED"); await load(true); } catch (error) { notice(error.message === "lighting_lab_conflict" ? "Settings changed in another window. Refresh and try again." : error.message, true); } }

  element("labBrightnessLimit").oninput = () => { element("labBrightnessLimitValue").value = `${element("labBrightnessLimit").value}%`; };
  element("saveLightingLab").onclick = save; element("refreshLightingLab").onclick = () => load(true).catch(error => notice(error.message, true));
  element("calibrateLightingLatency").onclick = async event => {
    const button = event.currentTarget; button.disabled = true; button.textContent = "TESTING";
    const measurements = await Promise.all((state.capabilities || []).filter(row => row.enabled).map(async row => {
      const startedAt = performance.now();
      try { const result = await ui.request(`/fixtures/${encodeURIComponent(row.id)}/test`, { method: "POST", body: "{}" }); return result.reachable ? { id: row.id, milliseconds: Math.round(performance.now() - startedAt) } : null; }
      catch { return null; }
    }));
    const reachable = measurements.filter(Boolean), times = reachable.map(row => row.milliseconds);
    notice(reachable.length ? `CONNECTION TEST // ${reachable.length} REACHABLE // ROUND-TRIP ${Math.min(...times)}-${Math.max(...times)}MS // VISUAL TIMING UNCHANGED` : "NO FIXTURES ANSWERED THE CONNECTION TEST", !reachable.length);
    button.disabled = false; button.textContent = "TEST ALL CONNECTIONS";
  };
  element("addLabPreset").onclick = async () => { const name = element("labPresetName").value.trim(), command = element("labPresetCommand").value.trim(); if (!name || !command) return notice("Enter both a preset name and command.", true); state.presets.push({ id: `preset-${Date.now()}`, name, command }); await save(); element("labPresetName").value = ""; element("labPresetCommand").value = ""; };
  element("runLabPreview").onclick = async () => { const output = element("labPreviewResult"); output.hidden = false; try { const result = await ui.request("/twitch/lights/preview", { method: "POST", body: JSON.stringify({ text: element("labPreviewCommand").value }) }); const targets = result.targets || []; output.textContent = `${result.effect?.toUpperCase() || result.hex || result.directiveType} // ${targets.length} TARGETS\n${targets.map(fixtureName).join(", ") || "No active targets"}`; renderMap(targets); } catch (error) { output.textContent = error.message; renderMap(); } };
  element("labPreviewCommand").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); element("runLabPreview").click(); } };
  element("clearLightingHistory").onclick = async () => { state = await ui.request("/lighting-lab/history", { method: "DELETE" }); renderHistory(); };
  void load(true).catch(error => notice(error.message, true));
  return { refresh: () => load(true) };
}
