export function initLightingLayout() {
  const ui = window.RaveLinkCoreUi;
  if (!ui) return null;
  const element = id => document.getElementById(id);
  let state = null, placements = {}, loaded = false;

  function fixtures() { return ui.fixtures().filter(row => row.enabled !== false); }
  function selectedId() { return element("layoutFixtureSelect").value; }
  function values() {
    return { x: Number(element("layoutX").value) / 100, y: Number(element("layoutY").value) / 100, z: Number(element("layoutZ").value) / 100,
      kind: element("layoutKind").value === "strip" ? "strip" : "point", rotation: Number(element("layoutRotation").value) };
  }
  function syncOutputs() {
    for (const axis of ["X", "Y", "Z"]) element(`layout${axis}Value`).value = `${element(`layout${axis}`).value}%`;
    element("layoutRotationValue").value = `${element("layoutRotation").value} deg`;
    element("layoutRotationLabel").hidden = element("layoutKind").value !== "strip";
  }
  function choose(id) {
    if (!id) return;
    element("layoutFixtureSelect").value = id;
    const row = placements[id] || { x: .5, y: .5, z: .5, kind: "point", rotation: 0 };
    element("layoutX").value = Math.round(row.x * 100); element("layoutY").value = Math.round(row.y * 100); element("layoutZ").value = Math.round(row.z * 100);
    element("layoutKind").value = row.kind; element("layoutRotation").value = row.rotation; syncOutputs(); renderMap();
  }
  function putSelected(next = values()) {
    const id = selectedId(); if (!id) return;
    placements[id] = next; choose(id); element("lightingLayoutResult").textContent = "UNSAVED LAYOUT CHANGES";
  }
  function renderMap() {
    const map = element("lightingRoomMap"), front = map.querySelector(".roomFrontLabel");
    map.replaceChildren(front || Object.assign(document.createElement("span"), { className: "roomFrontLabel", textContent: "FRONT" }));
    const names = new Map(fixtures().map(row => [row.id, row.name || row.id]));
    for (const [id, row] of Object.entries(placements)) {
      if (!names.has(id)) continue;
      const marker = document.createElement("button"); marker.type = "button"; marker.className = `layoutMarker ${row.kind}${id === selectedId() ? " selected" : ""}`;
      marker.style.left = `${row.x * 100}%`; marker.style.top = `${row.y * 100}%`; marker.style.setProperty("--rotation", `${row.rotation}deg`);
      marker.textContent = names.get(id).slice(0, 3).toUpperCase(); marker.title = names.get(id); marker.setAttribute("aria-label", names.get(id));
      marker.onclick = event => { event.stopPropagation(); choose(id); };
      marker.onpointerdown = event => { event.preventDefault(); marker.setPointerCapture(event.pointerId); choose(id); };
      marker.onpointermove = event => { if (!marker.hasPointerCapture(event.pointerId)) return; const box = map.getBoundingClientRect(); placements[id] = { ...placements[id], x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) }; marker.style.left = `${placements[id].x * 100}%`; marker.style.top = `${placements[id].y * 100}%`; element("layoutX").value = Math.round(placements[id].x * 100); element("layoutY").value = Math.round(placements[id].y * 100); syncOutputs(); element("lightingLayoutResult").textContent = "UNSAVED LAYOUT CHANGES"; };
      map.append(marker);
    }
  }
  function populate() {
    const select = element("layoutFixtureSelect"), previous = select.value;
    select.replaceChildren(...fixtures().map(row => { const option = document.createElement("option"); option.value = row.id; option.textContent = `${row.name || row.id} // ${String(row.brand).toUpperCase()}`; return option; }));
    select.value = fixtures().some(row => row.id === previous) ? previous : select.options[0]?.value || "";
    choose(select.value);
  }
  async function load() {
    if (loaded) { populate(); return; }
    try {
      state = await ui.request("/lighting-layout"); placements = structuredClone(state.placements || {}); loaded = true;
      element("lightingRoomName").value = state.room?.name || "Streaming room"; populate(); renderMap();
    } catch (error) { element("lightingLayoutResult").textContent = error.message; }
  }
  async function save() {
    if (!state) return;
    try {
      state = await ui.request("/lighting-layout", { method: "POST", body: JSON.stringify({ revision: state.revision, room: { name: element("lightingRoomName").value, width: 1, depth: 1 }, placements }) });
      placements = structuredClone(state.placements); element("lightingLayoutResult").textContent = `LAYOUT SAVED // ${Object.keys(placements).length} POSITIONED FIXTURES`;
    } catch (error) { element("lightingLayoutResult").textContent = error.message === "lighting_layout_conflict" ? "Layout changed in another window. Reload the page." : error.message; }
  }
  async function runRoutingTest(text) {
    const output = element("layoutRoutingTestResult"); output.hidden = false; output.textContent = "ROUTING COMMAND...";
    try {
      const result = await ui.request("/twitch/lights/test", { method: "POST", body: JSON.stringify({ text }) });
      const targets = Array.isArray(result.targets) ? result.targets : [];
      output.textContent = result.effect
        ? `${String(result.effect).toUpperCase()} // ${targets.length} TARGETS${result.synchronized ? " // SYNCHRONIZED" : ""}\n${targets.join(", ") || "No active targets"}`
        : `${result.hex || result.directiveType || "COLOR"} // ${Number(result.sent || 0)} SENT // ${Number(result.failed || 0)} FAILED\n${targets.join(", ") || "No active targets"}`;
    } catch (error) { output.textContent = error.message; }
  }
  element("lightingRoomMap").onclick = event => { const box = event.currentTarget.getBoundingClientRect(); putSelected({ ...values(), x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) }); };
  element("layoutFixtureSelect").onchange = () => choose(selectedId());
  for (const id of ["layoutX", "layoutY", "layoutZ", "layoutRotation"]) element(id).oninput = syncOutputs;
  element("layoutKind").onchange = syncOutputs;
  element("placeLayoutFixture").onclick = () => putSelected();
  element("removeLayoutFixture").onclick = () => { const id = selectedId(); if (!id) return; delete placements[id]; renderMap(); element("lightingLayoutResult").textContent = "UNSAVED LAYOUT CHANGES"; };
  element("saveLightingLayout").onclick = save;
  element("runLayoutRoutingTest").onclick = () => runRoutingTest(element("layoutRoutingTestInput").value);
  element("stopLayoutRoutingTest").onclick = () => runRoutingTest("stop");
  element("layoutRoutingTestInput").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void runRoutingTest(event.currentTarget.value); } });
  document.querySelector('[data-light-tab="layout"]').addEventListener("click", () => void load());
  void load();
  return { refresh: populate };
}
