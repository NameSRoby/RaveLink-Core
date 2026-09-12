const byId = id => document.getElementById(id);
let fixtures = [];
let fixtureConnectivity = new Map();
let fixtureTestState = new Map();
let fixtureGroups = [];
let twitchProgramUi;
let widgetSecurityStatus = {};
let songRequestAvailable = false;

async function request(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

const sensitiveDisplayKey = /(?:authorization|cookie|credential|password|secret|token|jwt|username|clientkey)/i;
const networkDisplayKey = /(?:ip|host|url|bridgeid|deviceid)$/i;

function redactDisplayString(value) {
  return String(value ?? "")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, address => `${address.split(".").slice(0, 2).join(".")}.x.x`)
    .replace(/\beyJ[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{8,}){1,2}\b/g, "[REDACTED TOKEN]")
    .replace(/\b[a-fA-F0-9]{24,}\b/g, value => `${value.slice(0, 4)}...[REDACTED]`);
}

function safeDisplayValue(value, key = "", depth = 0) {
  if (sensitiveDisplayKey.test(key) && !/(?:configured|present)$/i.test(key)) return "[REDACTED]";
  if (networkDisplayKey.test(key)) return value ? redactDisplayString(value) : value;
  if (depth >= 5) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeDisplayValue(item, key, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 40).map(([childKey, child]) => [childKey, safeDisplayValue(child, childKey, depth + 1)]));
  return typeof value === "string" ? redactDisplayString(value) : value;
}

function showResult(id, value, failed = false) {
  const output = byId(id);
  output.hidden = false;
  const safe = safeDisplayValue(value);
  const previousDetails = byId(`${id}DeveloperDetails`);
  previousDetails?.remove();
  if (typeof safe === "string") output.textContent = safe;
  else {
    const count = Array.isArray(safe?.installed) ? safe.installed.length : Array.isArray(safe?.fixtures) ? safe.fixtures.length : null;
    output.textContent = failed || safe?.ok === false
      ? "ACTION FAILED"
      : count !== null
        ? `${count} FIXTURE${count === 1 ? "" : "S"} SAVED`
        : safe?.operation
          ? `${String(safe.operation).replaceAll("_", " ").toUpperCase()} COMPLETE`
          : "ACTION COMPLETED";
    const details = document.createElement("pre");
    details.id = `${id}DeveloperDetails`;
    details.className = "result developerDetails";
    details.dataset.developerOnly = "true";
    details.textContent = JSON.stringify(safe, null, 2);
    output.after(details);
  }
  output.style.color = failed ? "var(--bad)" : "#c9d8ff";
}

const buttonExplanations = {
  discoverHue: "Search the local network for Philips Hue bridges. After discovery, the next pairing step will be shown.",
  pairHueManual: "Connect to the selected Hue bridge after pressing its physical link button.",
  discoverWiz: "Search the local network for WiZ lights and choose which fixtures to add.",
  refreshFixtures: "Reload saved fixtures and their current connection state.",
  saveFixture: "Save the fixture information currently entered in this form.",
  clearFixture: "Clear the fixture form without deleting saved fixtures.",
  applyColor: "Send the entered color and brightness to the selected lights.",
  generateWidget: "Generate the StreamElements widget using the selected rewards and secure intake token.",
  testIntakeToken: "Verify the entered widget token with a harmless request that cannot change lights.",
  copyWidget: "Copy the generated widget code to the clipboard.",
  themeButton: "Open HUD color and Developer Mode settings.",
  resetTheme: "Restore the default RaveLink HUD colors."
};
const tooltip = document.createElement("div");
tooltip.className = "hudTooltip";
tooltip.hidden = true;
tooltip.setAttribute("role", "tooltip");
document.body.append(tooltip);
let tooltipTimer = 0;
let tooltipButton = null;
function buttonExplanation(button) {
  const explicit = button.dataset.tooltip || button.getAttribute("title") || buttonExplanations[button.id];
  if (explicit) {
    button.dataset.tooltip = explicit;
    button.removeAttribute("title");
    return explicit;
  }
  const text = button.textContent.trim().replace(/\s+/g, " ");
  if (button.matches("[data-tab]")) return `Open the ${text.toLowerCase()} workspace.`;
  if (button.matches("[data-theme]")) return `Apply the ${text.toLowerCase()} HUD color theme.`;
  return text ? `Run the ${text.toLowerCase()} action.` : "Activate this control.";
}
function hideButtonTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTimer = 0;
  tooltipButton = null;
  tooltip.hidden = true;
}
document.addEventListener("pointerover", event => {
  const button = event.target.closest?.("button");
  if (!button || button === tooltipButton) return;
  hideButtonTooltip();
  tooltipButton = button;
  const explanation = buttonExplanation(button);
  tooltipTimer = setTimeout(() => {
    if (tooltipButton !== button) return;
    tooltip.textContent = explanation;
    tooltip.hidden = false;
    const rect = button.getBoundingClientRect();
    const left = Math.min(window.innerWidth - tooltip.offsetWidth - 12, Math.max(12, rect.left));
    const below = rect.bottom + 8;
    const top = below + tooltip.offsetHeight <= window.innerHeight - 8 ? below : Math.max(8, rect.top - tooltip.offsetHeight - 8);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }, 1200);
}, true);
document.addEventListener("pointerout", event => {
  if (!tooltipButton || event.relatedTarget && tooltipButton.contains(event.relatedTarget)) return;
  if (event.target === tooltipButton || tooltipButton.contains(event.target)) hideButtonTooltip();
}, true);
window.addEventListener("blur", hideButtonTooltip);

function maskedAddress(value) {
  return redactDisplayString(value || "hidden");
}

function setUnavailable(element, unavailable, reason = "") {
  if (!element) return;
  element.disabled = Boolean(unavailable);
  element.title = unavailable ? reason : "";
  if (unavailable && reason) {
    element.dataset.tooltip = reason;
    element.dataset.tooltipUnavailable = "true";
  } else if (element.dataset.tooltipUnavailable === "true") {
    delete element.dataset.tooltip;
    delete element.dataset.tooltipUnavailable;
  }
  element.setAttribute("aria-disabled", unavailable ? "true" : "false");
}

function setStatus(id, text, tone = "") {
  const element = byId(id);
  element.textContent = text;
  element.className = `statusLine${tone ? ` ${tone}` : ""}`;
}

function configuredLightFixtures() {
  return fixtures.filter(row => {
    const connectivity = fixtureConnectivity.get(row.id);
    return row.enabled !== false && connectivity?.configured === true;
  });
}

function applyLightingReadiness() {
  const ready = configuredLightFixtures();
  const directReason = "Pair a Hue bridge or add a discovered WiZ fixture before controlling lights.";
  const twitchReady = ready.some(row => row.twitchEnabled === true);
  const twitchReason = "Add and enable at least one Twitch-controlled fixture before programming channel-point routing.";
  for (const element of [byId("lightTarget"), byId("colorText"), byId("colorPicker"), byId("brightness"), byId("applyColor"), ...document.querySelectorAll("[data-color]")]) {
    setUnavailable(element, ready.length === 0, directReason);
  }
  setUnavailable(byId("twitchProgramControls"), !twitchReady, twitchReason);
  setStatus("lightStatus", ready.length ? "READY" : "FIXTURE SETUP REQUIRED", ready.length ? "ok" : "warn");
  byId("lightStatus").title = ready.length ? "" : directReason;
  updateWidgetReadiness();
}

function showDiscoveryResult(result) {
  const output = byId("fixtureActionResult");
  byId("fixtureActionResultDeveloperDetails")?.remove();
  output.hidden = false;
  output.style.color = "#c9d8ff";
  output.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = `${Number(result.count || 0)} ${result.kind === "hue" ? "Hue bridge" : "WiZ device"}${result.count === 1 ? "" : "s"} found`;
  output.append(heading);
  const targets = result.targets || [];
  if (result.kind === "hue" && targets.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "NO HUE BRIDGE FOUND // CHECK THAT THE BRIDGE IS POWERED AND ON THIS NETWORK";
    output.append(empty);
    return;
  }
  if (result.kind === "hue" && targets.length === 1) {
    void selectDiscoveredHue(targets[0]);
    return;
  }
  for (const target of targets) {
    const row = document.createElement("div");
    row.className = "discoveryRow";
    Object.assign(row.style, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "8px 0", borderTop: "1px solid var(--edge)" });
    const label = document.createElement("span");
    label.textContent = `${target.label}  ${maskedAddress(target.addressHint)}`;
    const use = document.createElement("button");
    use.type = "button";
    use.textContent = result.kind === "hue" ? "SELECT BRIDGE" : "ADD";
    use.onclick = async () => {
      try {
        if (result.kind === "hue") {
          use.disabled = true;
          use.textContent = "SELECTING";
          await selectDiscoveredHue(target);
        } else {
          const saved = await request("/wiz/onboarding/commit", { method: "POST", body: JSON.stringify({ selectionToken: target.selectionToken, zone: byId("fixtureZone").value }) });
          label.textContent = `${target.label} added`;
          use.remove();
          await loadFixtures();
          showResult("fixtureActionResult", saved);
        }
      } catch (error) { showResult("fixtureActionResult", error.message, true); }
    };
    if (result.kind === "hue") row.append(label, use);
    else {
      row.append(label, use);
    }
    output.append(row);
  }
  if (result.kind === "wiz" && targets.length > 1) {
    const addAll = document.createElement("button");
    addAll.type = "button";
    addAll.textContent = "ADD ALL";
    addAll.onclick = async () => {
      try {
        const saved = await request("/wiz/onboarding/commit", { method: "POST", body: JSON.stringify({ selectionTokens: targets.map(row => row.selectionToken), zone: byId("fixtureZone").value }) });
        await loadFixtures();
        showResult("fixtureActionResult", saved);
      } catch (error) { showResult("fixtureActionResult", error.message, true); }
    };
    output.append(addAll);
  }
}

async function selectDiscoveredHue(target) {
  try {
    const selected = await request("/hardware/discovery/select", { method: "POST", body: JSON.stringify({ selectionToken: target.selectionToken }) });
    byId("fixtureBrand").value = "hue";
    byId("fixtureBridgeIp").value = selected.address || "";
    syncHuePairButton();
    const output = byId("fixtureActionResult");
    const heading = document.createElement("strong");
    heading.textContent = "HUE BRIDGE SELECTED";
    const next = document.createElement("p");
    next.textContent = "NEXT: PRESS THE PHYSICAL BUTTON ON THE HUE BRIDGE, THEN SELECT 2 // PAIR SELECTED BRIDGE";
    output.replaceChildren(heading, next);
  } catch (error) { showResult("fixtureActionResult", error.message, true); }
}

async function connectHuePair(prepared) {
  const output = byId('fixtureActionResult');
  output.hidden = false;
  const status = document.createElement('p');
  status.textContent = 'CONNECTING TO HUE BRIDGE';
  output.replaceChildren(status);
  const response = await fetch('/hue/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingToken: prepared.pairingToken }) });
  const result = await response.json();
  if (response.ok && result.ok) return showHueSetup(result);
  status.textContent = result.error === 'link_button_timeout'
    ? 'LINK BUTTON NOT DETECTED // PRESS THE PHYSICAL BUTTON, THEN SELECT 2 // PAIR SELECTED BRIDGE AGAIN'
    : result.paired
      ? 'BRIDGE PAIRED, BUT LIGHT INVENTORY IS UNAVAILABLE // SELECT PAIR AGAIN TO RETRY'
      : redactDisplayString(result.error || 'HUE CONNECTION FAILED');
}

function syncHuePairButton() {
  setUnavailable(byId("pairHueManual"), !byId("fixtureBridgeIp").value.trim(), "Discover a Hue bridge or enter its address first.");
}

function showHueSetup(result) {
  const output = byId("fixtureActionResult");
  output.hidden = false;
  output.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = `${result.lights.length} Hue light${result.lights.length === 1 ? "" : "s"} ready`;
  const list = document.createElement("div");
  list.className = "hueLightList";
  for (const light of result.lights) {
    const row = document.createElement("label");
    row.className = "hueLightRow";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.value = String(light.lightId);
    const name = document.createElement("span");
    name.textContent = `${light.name}${light.productName ? `  ${light.productName}` : ""}`;
    row.append(checkbox, name);
    list.append(row);
  }
  const actions = document.createElement("div");
  actions.className = "discoveryActions";
  const area = document.createElement('select');
  area.setAttribute('aria-label', 'Entertainment area');
  area.add(new Option('STANDARD LIGHT CONTROL', ''));
  for (const item of result.entertainmentAreas || []) area.add(new Option(item.name, item.id));
  const setupOptions = document.createElement("div");
  setupOptions.className = "hueSetupOptions";
  const zoneLabel = document.createElement("label");
  zoneLabel.textContent = "ZONE";
  const zone = document.createElement("input");
  zone.placeholder = "desk";
  zone.value = byId("fixtureZone").value;
  zoneLabel.append(zone);
  const twitchLabel = document.createElement("label");
  twitchLabel.className = "checkLabel";
  const twitch = document.createElement("input");
  twitch.type = "checkbox";
  twitch.checked = byId("fixtureTwitch").checked;
  twitchLabel.append(twitch, document.createTextNode(" TWITCH CONTROL"));
  setupOptions.append(zoneLabel, twitchLabel);
  const saveStatus = document.createElement('p');
  saveStatus.setAttribute('role', 'status');
  const install = async mode => {
    const lightIds = [...list.querySelectorAll('input[type="checkbox"]:checked')].map(input => Number(input.value));
    try {
      const saved = await request("/hue/onboarding/commit", { method: "POST", body: JSON.stringify({ setupToken: result.setupToken, mode, lightIds, entertainmentAreaId: area.value, zone: zone.value, twitchEnabled: twitch.checked }) });
      await loadFixtures();
      showResult("fixtureActionResult", saved);
    } catch (error) { saveStatus.textContent = redactDisplayString(error.message); }
  };
  const selected = document.createElement("button");
  selected.type = "button";
  selected.textContent = "SAVE SELECTED";
  selected.onclick = () => install("selected");
  const all = document.createElement("button");
  all.type = "button";
  all.textContent = "SAVE WHOLE BRIDGE";
  all.onclick = () => install("all");
  actions.append(selected, all);
  output.append(heading, list, area, setupOptions, actions, saveStatus);
}

function escapeHtml(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, character => entities[character]);
}

document.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll("[data-tab]").forEach(item => item.classList.toggle("active", item === button));
  document.querySelectorAll("[data-panel]").forEach(panel => { panel.hidden = panel.dataset.panel !== button.dataset.tab; });
}));

const themes = {
  midnight: { accent: "#8b001f", bg: "#050507", surface: "#121a2f", text: "#eaeaea", glow: 65 },
  ember: { accent: "#d94118", bg: "#090606", surface: "#24120e", text: "#fff1e8", glow: 58 },
  ocean: { accent: "#007ea8", bg: "#03080b", surface: "#0a2028", text: "#e8fbff", glow: 58 },
  matrix: { accent: "#14a64a", bg: "#020704", surface: "#092013", text: "#e9ffef", glow: 48 },
  aurora: { accent: "#9b287b", bg: "#07050a", surface: "#201229", text: "#f9edff", glow: 62 },
  solar: { accent: "#d99a00", bg: "#090805", surface: "#27200b", text: "#fff9df", glow: 44 }
};

function applyTheme(theme, persist = true) {
  const value = { ...themes.midnight, ...(theme || {}) };
  const root = document.documentElement.style;
  root.setProperty("--accent", value.accent);
  root.setProperty("--accent-glow", `${value.accent}aa`);
  root.setProperty("--bg", value.bg);
  root.setProperty("--surface", value.surface);
  root.setProperty("--text", value.text);
  root.setProperty("--glow", String(value.glow / 100));
  byId("themeAccent").value = value.accent;
  byId("themeBg").value = value.bg;
  byId("themeSurface").value = value.surface;
  byId("themeText").value = value.text;
  byId("themeGlow").value = value.glow;
  byId("glowValue").value = `${value.glow}%`;
  if (persist) localStorage.setItem("ravelink.hud.theme", JSON.stringify(value));
}

function customTheme() {
  return { accent: byId("themeAccent").value, bg: byId("themeBg").value, surface: byId("themeSurface").value, text: byId("themeText").value, glow: Number(byId("themeGlow").value) };
}

byId("themeButton").onclick = () => { byId("themePanel").hidden = !byId("themePanel").hidden; };
byId("closeTheme").onclick = () => { byId("themePanel").hidden = true; };
byId("resetTheme").onclick = () => applyTheme(themes.midnight);
document.querySelectorAll("[data-theme]").forEach(button => button.onclick = () => applyTheme(themes[button.dataset.theme]));
for (const id of ["themeAccent", "themeBg", "themeSurface", "themeText", "themeGlow"]) byId(id).oninput = () => applyTheme(customTheme());
try { applyTheme(JSON.parse(localStorage.getItem("ravelink.hud.theme")), false); } catch { applyTheme(themes.midnight, false); }
const developerMode = byId("developerMode");
developerMode.checked = localStorage.getItem("ravelink.hud.developerMode") === "true";
document.documentElement.dataset.developerMode = String(developerMode.checked);
developerMode.onchange = () => {
  localStorage.setItem("ravelink.hud.developerMode", String(developerMode.checked));
  document.documentElement.dataset.developerMode = String(developerMode.checked);
};

function clearFixtureForm() {
  byId("fixtureId").value = "";
  byId("fixtureName").value = "";
  byId("fixtureZone").value = "";
  byId("fixtureLightId").value = "1";
  byId("fixtureIp").value = "";
  byId("fixtureBridgeIp").value = "";
  byId("fixtureEnabled").checked = true;
  byId("fixtureTwitch").checked = true;
  byId("showFixtureAddresses").checked = false;
  byId("fixtureIp").type = "password";
  byId("fixtureBridgeIp").type = "password";
}

byId("showFixtureAddresses").onchange = () => {
  const type = byId("showFixtureAddresses").checked ? "text" : "password";
  byId("fixtureIp").type = type;
  byId("fixtureBridgeIp").type = type;
};

function renderFixtures() {
  byId("hueCount").textContent = String(fixtures.filter(row => row.brand === "hue").length);
  byId("wizCount").textContent = String(fixtures.filter(row => row.brand === "wiz").length);
  byId("fixtureRows").innerHTML = fixtures.length ? fixtures.map(row => {
    const connectivity = fixtureConnectivity.get(row.id);
    const state = !row.enabled ? "DISABLED" : fixtureTestState.get(row.id)?.status || String(connectivity?.status || (row.credentialsConfigured || row.deviceIpConfigured ? "untested" : "not_configured")).replaceAll("_", " ").toUpperCase();
    return `<tr><td><strong>${escapeHtml(row.name || row.id)}</strong><br><span class="sub">${escapeHtml(row.id)}</span></td><td>${escapeHtml(row.brand).toUpperCase()}</td><td>${escapeHtml(row.zone || "-")}</td><td>${row.twitchEnabled ? "TWITCH" : "OFF"}</td><td>${escapeHtml(state)}</td><td><div class="actions compact"><button data-fixture-test="${escapeHtml(row.id)}">TEST</button><button data-fixture-edit="${escapeHtml(row.id)}">EDIT</button><button class="danger" data-fixture-delete="${escapeHtml(row.id)}">DELETE</button></div></td></tr>`;
  }).join("") : '<tr><td colspan="6">NO FIXTURES CONFIGURED</td></tr>';
  renderLightTargets();
  applyLightingReadiness();
}

function fixtureTestFailure(error) {
  const messages = {
    hue_light_not_found: "The bridge responded, but this light ID no longer exists. Reconnect the Hue bridge to refresh its lights.",
    hue_lights_query_failed: "The Hue bridge did not return its light inventory. Check bridge power and network access, then test again.",
    hue_lights_transport_unavailable: "Hue networking is unavailable. Restart RaveLink and check the local network connection.",
    wiz_probe_timeout: "The WiZ light did not answer. Confirm it is powered and on the same local network, then rediscover WiZ.",
    wiz_probe_failed: "The WiZ light could not be reached. Rediscover WiZ to refresh its saved address.",
    wiz_probe_transport_unavailable: "WiZ network probing is unavailable on this system.",
    fixture_not_found: "This fixture is no longer saved. Refresh the fixture list."
  };
  return messages[error] || `The fixture test failed (${String(error || "unknown error").replaceAll("_", " ")}). Check its pairing and network settings.`;
}

function renderLightTargets() {
  const select = byId("lightTarget");
  const current = select.value || "all";
  const options = [
    ["all", "ALL LIGHTS"], ["brand:hue", "ALL HUE"], ["brand:wiz", "ALL WIZ"],
    ...fixtureGroups.filter(row => row.enabled !== false && row.fixtureIds?.length).map(row => [`group:${row.id}`, `GROUP: ${row.name}`]),
    ...[...new Set(fixtures.map(row => row.zone).filter(Boolean))].sort().map(zone => [`zone:${zone}`, `ZONE: ${zone.toUpperCase()}`]),
    ...fixtures.map(row => [`fixture:${row.id}`, `${String(row.brand).toUpperCase()}: ${row.name || row.id}`])
  ];
  if (current.startsWith('group:') && !options.some(([value]) => value === current)) options.push([current, 'GROUP UNAVAILABLE']);
  select.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
  select.value = options.some(([value]) => value === current) ? current : "all";
  twitchProgramUi?.refreshFixtures();
}

async function loadFixtures() {
  const result = await request("/fixtures");
  fixtures = result.fixtures || [];
  fixtureConnectivity = new Map((result.connectivity?.rows || []).map(row => [row.id, row]));
  renderFixtures();
}

byId("fixtureRows").onclick = async event => {
  const edit = event.target.closest("[data-fixture-edit]");
  const test = event.target.closest("[data-fixture-test]");
  const remove = event.target.closest("[data-fixture-delete]");
  if (test) {
    test.disabled = true;
    test.textContent = "TESTING";
    try {
      const result = await request(`/fixtures/${encodeURIComponent(test.dataset.fixtureTest)}/test`, { method: "POST", body: "{}" });
      fixtureTestState.set(test.dataset.fixtureTest, { status: "REACHABLE" });
      showResult("fixtureActionResult", `${result.fixture?.name || "Fixture"} responded successfully.`);
    }
    catch (error) {
      fixtureTestState.set(test.dataset.fixtureTest, { status: "UNREACHABLE" });
      showResult("fixtureActionResult", fixtureTestFailure(error.message), true);
    }
    finally { test.disabled = false; test.textContent = "TEST"; }
    renderFixtures();
  }
  if (edit) {
    const row = fixtures.find(item => item.id === edit.dataset.fixtureEdit);
    if (!row) return;
    try {
      const detail = (await request(`/fixtures/${encodeURIComponent(row.id)}/edit`)).fixture;
      byId("fixtureBrand").value = detail.brand;
      byId("fixtureId").value = detail.id;
      byId("fixtureName").value = detail.name || detail.id;
      byId("fixtureZone").value = detail.zone || "";
      byId("fixtureLightId").value = detail.lightId || 1;
      byId("fixtureIp").value = detail.ip || "";
      byId("fixtureBridgeIp").value = detail.bridgeIp || "";
      byId("fixtureEnabled").checked = detail.enabled !== false;
      byId("fixtureTwitch").checked = detail.twitchEnabled === true;
      byId("showFixtureAddresses").checked = false;
      byId("fixtureIp").type = "password";
      byId("fixtureBridgeIp").type = "password";
    } catch (error) { showResult("fixtureActionResult", error.message, true); }
  }
  if (remove && confirm(`Delete fixture ${remove.dataset.fixtureDelete}?`)) {
    try { await request(`/fixtures/${encodeURIComponent(remove.dataset.fixtureDelete)}`, { method: "DELETE" }); await loadFixtures(); } catch (error) { showResult("fixtureActionResult", error.message, true); }
  }
};

byId("saveFixture").onclick = async () => {
  try {
    const result = await request("/fixtures", { method: "POST", body: JSON.stringify({ id: byId("fixtureId").value, name: byId("fixtureName").value, brand: byId("fixtureBrand").value, zone: byId("fixtureZone").value, lightId: Number(byId("fixtureLightId").value), ip: byId("fixtureIp").value, bridgeIp: byId("fixtureBridgeIp").value, enabled: byId("fixtureEnabled").checked, twitchEnabled: byId("fixtureTwitch").checked }) });
    showResult("fixtureActionResult", result);
    clearFixtureForm();
    await loadFixtures();
  } catch (error) { showResult("fixtureActionResult", error.message, true); }
};
byId("clearFixture").onclick = clearFixtureForm;
byId("refreshFixtures").onclick = () => loadFixtures().catch(error => showResult("fixtureActionResult", error.message, true));
byId("discoverHue").onclick = async () => {
  byId("discoverHue").disabled = true;
  byId("discoverHue").textContent = "SEARCHING FOR HUE BRIDGE";
  try { showDiscoveryResult(await request("/hue/discover")); }
  catch (error) { showResult("fixtureActionResult", error.message, true); }
  finally { byId("discoverHue").disabled = false; byId("discoverHue").textContent = "1 // DISCOVER HUE"; }
};
byId("discoverWiz").onclick = async () => { try { showDiscoveryResult(await request("/wiz/discover")); } catch (error) { showResult("fixtureActionResult", error.message, true); } };
byId("pairHueManual").onclick = async () => {
  const bridgeIp = byId("fixtureBridgeIp").value;
  if (!bridgeIp) return showResult("fixtureActionResult", "Enter a Hue bridge address or use discovery.", true);
  try {
    byId("pairHueManual").disabled = true;
    byId("pairHueManual").textContent = "PAIRING";
    await connectHuePair(await request("/hue/pair/prepare", { method: "POST", body: JSON.stringify({ bridgeIp }) }));
  } catch (error) { showResult("fixtureActionResult", error.message, true); }
  finally { byId("pairHueManual").textContent = "2 // PAIR SELECTED BRIDGE"; syncHuePairButton(); }
};
byId("fixtureBridgeIp").addEventListener("input", syncHuePairButton);
syncHuePairButton();

byId("applyColor").onclick = async () => {
  setStatus("lightStatus", "APPLYING", "warn");
  const selection = byId("lightTarget").value;
  const text = byId('colorText').value || byId('colorPicker').value;
  const body = { text: /(?:^|\s)(?:dim|bright|\d{1,3}%)(?:\s|$)/i.test(text) ? text : `${text} ${byId('brightness').value}%` };
  if (selection.startsWith("brand:")) body.target = selection.slice(6);
  else if (selection.startsWith("zone:")) { body.target = "both"; body.zone = selection.slice(5); }
  else if (selection.startsWith("fixture:")) body.fixtureId = selection.slice(8);
  else if (selection.startsWith('group:')) body.groupId = selection.slice(6);
  else body.target = "both";
  try {
    const result = await request('/color', { method: 'POST', body: JSON.stringify(body) });
    const dryRun = result.hueDelivery?.dryRun || result.wizDelivery?.dryRun;
    const matched = Number(result.hueTargets || 0) + Number(result.wizTargets || 0);
    const destination = Array.isArray(result.targets) && result.targets.length ? result.targets.join(', ') : 'no fixtures';
    const command = `${result.hex || 'brightness only'} at ${result.brightnessPercent}%`;
    const summary = dryRun ? `Dry run: ${command} matched ${destination}. No hardware command sent.`
      : `${command} sent to ${destination}. ${result.sent || 0} dispatched, ${result.failed || 0} failed (${result.skippedTargets || 0} missing or disabled).`;
    showResult('colorResult', summary);
    setStatus('lightStatus', dryRun ? 'DRY RUN' : result.partial ? 'PARTIAL' : 'APPLIED', dryRun || result.partial ? 'warn' : 'ok');
  }
  catch (error) { showResult("colorResult", error.message, true); setStatus("lightStatus", "FAILED", "bad"); }
};
byId("colorText").onkeydown = event => { if (event.key === "Enter") byId("applyColor").click(); };
byId("colorPicker").oninput = () => { byId("colorText").value = byId("colorPicker").value; };
byId("brightness").oninput = () => { byId("brightnessValue").value = `${byId("brightness").value}%`; };
document.querySelectorAll("[data-color]").forEach(button => button.onclick = () => { byId("colorText").value = button.dataset.color; });

byId("baseUrl").value = location.origin;
function applyWidgetSensitiveVisibility() {
  const reveal = byId("showWidgetSensitive").checked;
  byId("baseUrl").type = reveal ? "text" : "password";
  byId("intakeToken").type = reveal ? "text" : "password";
  byId("widgetOutput").style.webkitTextSecurity = reveal ? "none" : "disc";
}
byId("showWidgetSensitive").onchange = applyWidgetSensitiveVisibility;
applyWidgetSensitiveVisibility();

function applyWidgetSecurity(status = {}) {
  widgetSecurityStatus = status;
  const managed = status.managementAvailable === true;
  const configured = status.configured === true;
  const widgetStatusText = status.mode === "environment_read_only"
    ? "ENV TOKEN ACTIVE"
    : (configured ? (status.overlapActive ? "TOKEN ROTATING" : "HOSTED INTAKE READY") : "SERVER TOKEN REQUIRED");
  setStatus("widgetStatus", widgetStatusText, configured ? (status.overlapActive ? "warn" : "ok") : "warn");
  byId("rotateIntakeToken").disabled = !managed;
  byId("clearIntakeToken").disabled = !managed || !configured;
  byId("rotateIntakeToken").textContent = configured ? "ROTATE TOKEN" : "GENERATE TOKEN";
  byId("rotateIntakeToken").title = managed ? "Generate and reveal a server-managed intake token once" : "Token is controlled by RAVELINK_WIDGET_INTAKE_TOKEN";
  updateWidgetReadiness();
}
function widgetGenerationProblem() {
  if (!byId("colorRewardId").value.trim() && !byId("teachRewardId").value.trim() && !byId("songRewardId").value.trim()) return "ADD AT LEAST ONE REWARD ID";
  if (byId("colorRewardId").value.trim() && configuredLightFixtures().length === 0) return "PAIR OR ADD A USABLE FIXTURE FOR THE LIGHT REWARD";
  if (byId("songRewardId").value.trim() && !songRequestAvailable) return "INSTALL AND ENABLE SONG REQUEST BEFORE ROUTING ITS REWARD";
  if (!byId("intakeToken").value.trim()) return widgetSecurityStatus.overlapActive
    ? "TOKEN WAS ROTATED // ROTATE ONCE MORE TO REVEAL A TOKEN, THEN VERIFY, GENERATE, AND REPLACE THE STREAM ELEMENTS CODE"
    : "GENERATE OR ENTER AN INTAKE TOKEN";
  try {
    const url = new URL(byId("baseUrl").value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return "BRIDGE URL MUST BE LOOPBACK HTTP";
  } catch { return "BRIDGE URL IS INVALID"; }
  return "";
}

function updateWidgetReadiness() {
  const problem = widgetGenerationProblem();
  byId("generateWidget").disabled = Boolean(problem);
  const rebuildProblem = !byId("colorRewardId").value.trim() && !byId("teachRewardId").value.trim() && !byId("songRewardId").value.trim()
    ? "Add at least one reward ID before rebuilding the widget."
    : (byId("colorRewardId").value.trim() && configuredLightFixtures().length === 0
      ? "Pair or add a usable fixture before rebuilding the lights widget."
      : (byId("songRewardId").value.trim() && !songRequestAvailable ? "Install and enable Song Request before rebuilding its widget route." : ""));
  setUnavailable(byId("rebuildWidget"), !widgetSecurityStatus.managementAvailable || Boolean(rebuildProblem), !widgetSecurityStatus.managementAvailable ? "The intake token is managed by the server environment." : rebuildProblem);
  byId("widgetNotice").textContent = problem || "READY TO GENERATE";
  byId("widgetNotice").className = `notice${problem ? " bad" : ""}`;
  const hasOutput = Boolean(byId("widgetOutput").value);
  setUnavailable(byId("copyWidget"), !hasOutput, "Generate widget code before copying it.");
  setUnavailable(byId("testIntakeToken"), !byId("intakeToken").value.trim(), "Generate or enter an intake token before verifying it.");
}
for (const id of ["colorRewardId", "teachRewardId", "songRewardId", "baseUrl", "intakeToken"]) byId(id).oninput = updateWidgetReadiness;
byId("rotateIntakeToken").onclick = async () => {
  if (byId("rotateIntakeToken").textContent === "ROTATE TOKEN" && !confirm("Rotate the widget token? Existing widgets keep working briefly during the overlap window.")) return;
  try {
    const result = await request("/system/widget-token/rotate", { method: "POST", body: "{}" });
    byId("intakeToken").value = result.token || "";
    byId("intakeToken").focus();
    byId("intakeToken").select();
    applyWidgetSecurity(result.widgetSecurity);
  } catch (error) { byId("widgetOutput").value = error.message; }
};
byId("clearIntakeToken").onclick = async () => {
  if (!confirm("Revoke the current and overlapping widget tokens? Hosted widgets will stop until a new token is generated.")) return;
  try {
    const result = await request("/system/widget-token/clear", { method: "POST", body: "{}" });
    byId("intakeToken").value = "";
    applyWidgetSecurity(result.widgetSecurity);
  } catch (error) { byId("widgetOutput").value = error.message; }
};
byId("testIntakeToken").onclick = async () => {
  try {
    const token = byId("intakeToken").value.trim();
    const result = await request("/widget/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        contract: "widget.events.v2",
        source: "streamelements",
        eventEnvelope: { detail: { listener: "message", event: { text: "ravelink-intake-health-check" } } },
        widgetConfig: { colorRewardId: byId("colorRewardId").value.trim(), teachRewardId: byId("teachRewardId").value.trim(), songRewardId: byId("songRewardId").value.trim() }
      })
    });
    byId("widgetNotice").textContent = result.disposition === "irrelevant" ? "INTAKE TOKEN VERIFIED // GENERATE AND REPLACE THE STREAM ELEMENTS WIDGET CODE" : "INTAKE TOKEN VERIFIED";
    byId("widgetNotice").className = "notice";
  } catch (error) {
    byId("widgetNotice").textContent = `INTAKE TOKEN REJECTED // ${error.message}`;
    byId("widgetNotice").className = "notice bad";
  }
};
byId("generateWidget").onclick = async () => {
  const problem = widgetGenerationProblem();
  if (problem) return updateWidgetReadiness();
  try {
    const result = await request("/system/widget-template-get", { method: "POST", body: JSON.stringify({ colorRewardId: byId("colorRewardId").value, teachRewardId: byId("teachRewardId").value, songRewardId: byId("songRewardId").value, baseUrl: byId("baseUrl").value, widgetIntakeToken: byId("intakeToken").value }) });
    byId("widgetOutput").value = result.script || "";
    byId("intakeToken").value = "";
    byId("generateWidget").disabled = true;
    setUnavailable(byId("copyWidget"), false);
    applyWidgetSensitiveVisibility();
    byId("widgetNotice").textContent = "WIDGET CODE GENERATED";
    byId("widgetNotice").className = "notice";
  } catch (error) { byId("widgetNotice").textContent = error.message; byId("widgetNotice").className = "notice bad"; }
};
byId("rebuildWidget").onclick = async () => {
  if (!confirm("Create replacement widget code? This rotates the intake token. The currently deployed widget remains valid for ten minutes while you replace its JavaScript.")) return;
  try {
    const result = await request("/system/widget-template-rebuild", { method: "POST", body: JSON.stringify({ colorRewardId: byId("colorRewardId").value, teachRewardId: byId("teachRewardId").value, songRewardId: byId("songRewardId").value, baseUrl: byId("baseUrl").value }) });
    byId("widgetOutput").value = result.script || "";
    byId("intakeToken").value = "";
    applyWidgetSecurity(result.widgetSecurity);
    setUnavailable(byId("copyWidget"), false);
    applyWidgetSensitiveVisibility();
    byId("widgetNotice").textContent = "REPLACEMENT READY // COPY IT INTO THE STREAM ELEMENTS CUSTOM WIDGET JS AND SAVE";
    byId("widgetNotice").className = "notice";
  } catch (error) {
    byId("widgetNotice").textContent = `REBUILD FAILED // ${error.message}`;
    byId("widgetNotice").className = "notice bad";
  }
};
async function refreshWidgetConnection() {
  try {
    const diagnostics = await request("/system/diagnostics");
    const counters = diagnostics.domains?.widget?.counters || {};
    const received = Number(counters.received || 0), ready = Number(counters.ready || 0), handled = Number(counters.handled || 0), rejected = Number(counters.rejected || 0);
    const message = handled > 0
      ? `DEPLOYMENT ACTIVE // ${handled} REDEMPTION${handled === 1 ? "" : "S"} HANDLED`
      : ready > 0
        ? `DEPLOYMENT CONNECTED // ${ready} AUTHENTICATED WIDGET LOAD${ready === 1 ? "" : "S"}; NO MATCHING REDEMPTION YET`
        : rejected > 0
          ? `DEPLOYED WIDGET TOKEN REJECTED ${rejected} TIME${rejected === 1 ? "" : "S"} // REBUILD AND REPLACE THE STREAM ELEMENTS JS`
          : "NO WIDGET CONTACT YET // REBUILD, PASTE THE JS INTO STREAM ELEMENTS, SAVE, THEN REFRESH ITS OBS SOURCE";
    byId("widgetConnectionNotice").textContent = message;
    byId("widgetConnectionNotice").className = `notice${handled > 0 || received > 0 ? "" : " bad"}`;
  } catch (error) {
    byId("widgetConnectionNotice").textContent = `DEPLOYMENT CHECK FAILED // ${error.message}`;
    byId("widgetConnectionNotice").className = "notice bad";
  }
}
byId("refreshWidgetConnection").onclick = refreshWidgetConnection;
byId("copyWidget").onclick = async () => {
  if (!byId("widgetOutput").value) return;
  try {
    await navigator.clipboard.writeText(byId("widgetOutput").value);
    byId("widgetNotice").textContent = "WIDGET CODE COPIED";
    byId("widgetNotice").className = "notice";
  } catch {
    byId("widgetNotice").textContent = "COPY BLOCKED BY BROWSER // SELECT THE GENERATED OUTPUT MANUALLY";
    byId("widgetNotice").className = "notice bad";
  }
};

async function boot() {
  try {
    const status = await request("/system/status");
    byId("health").textContent = "CORE ONLINE";
    byId("health").className = "badge ok";
    byId("network").className = "badge ok";
    fixtures = status.fixtures?.items || [];
    fixtureConnectivity = new Map((status.fixtures?.connectivity?.rows || []).map(row => [row.id, row]));
    songRequestAvailable = status.capabilities?.songRequest === true;
    renderFixtures();
    applyWidgetSecurity(status.widgetSecurity);
    twitchProgramUi = await import('/twitch-light-program.js').then(module => module.initTwitchLightProgram({ request, initialState: status.twitchLightRouting, getFixtures: () => fixtures, changed: groups => { fixtureGroups = groups; renderLightTargets(); } }));
    if (status.capabilities?.features === true) { byId("featuresTab").hidden = false; await import("/features.js").then(module => module.initFeaturePlatform()); }
    if (status.capabilities?.mods === true) { byId("modsTab").hidden = false; await import("/mods.js").then(module => module.initModPlatform()); }
  } catch (error) {
    byId("health").textContent = "CORE OFFLINE";
    byId("health").className = "badge bad";
    byId("network").className = "badge bad";
  }
}

boot();
