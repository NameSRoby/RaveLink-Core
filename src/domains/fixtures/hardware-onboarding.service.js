// [TITLE] Module: domains/fixtures/hardware-onboarding.service.js
// [TITLE] Purpose: bounded, server-owned Hue, WiZ, and alpha Govee discovery/onboarding sessions

const crypto = require("node:crypto");

const DISCOVERY_TTL_MS = 60_000;
const HUE_PAIR_TARGET_TTL_MS = 5 * 60_000;
const HUE_SETUP_TTL_MS = 5 * 60_000;
const MAX_DISCOVERY_TARGETS = 32;
const MAX_HUE_PAIR_TARGETS = 8;
const MAX_HUE_SETUPS = 8;
const MAX_COMMIT_FIXTURES = 64;

function text(value, maximum = 128) {
  return String(value || "").trim().slice(0, maximum);
}

function slug(value, fallback = "light") {
  const normalized = text(value, 64).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function maskAddress(value) {
  const source = text(value, 255);
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(source)) return `${source.split(".").slice(0, 2).join(".")}.x.x`;
  return source ? `${source.slice(0, 2)}...` : "hidden";
}

module.exports = function createHardwareOnboardingService(options = {}) {
  const core = options.core;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const randomToken = typeof options.randomToken === "function"
    ? options.randomToken
    : () => crypto.randomBytes(18).toString("base64url");
  if (!core?.fixtureRegistry || !core?.hueBridge || !core?.wizBridge) {
    throw new Error("createHardwareOnboardingService requires lighting core services");
  }

  const discovery = new Map();
  const huePairTargets = new Map();
  const hueSetups = new Map();
  const discoveryWork = new Map();
  const discoveryCounters = { started: 0, joined: 0, completed: 0, failed: 0 };

  function discover(kindRaw, input = {}) {
    const kind = ["hue", "wiz", "govee"].includes(kindRaw) ? kindRaw : "";
    if (!kind) return Promise.resolve({ ok: false, error: "unsupported_discovery_kind" });
    if (discoveryWork.has(kind)) {
      discoveryCounters.joined += 1;
      return discoveryWork.get(kind);
    }
    discoveryCounters.started += 1;
    if (kind === "govee" && typeof core.goveeBridge?.discoverDevices !== "function") {
      return Promise.resolve({ ok: false, error: "govee_alpha_unavailable", devices: [] });
    }
    const operation = Promise.resolve().then(() => kind === "hue"
      ? core.hueBridge.discoverBridges(input)
      : kind === "govee" ? core.goveeBridge.discoverDevices(input) : core.wizBridge.discoverDevices(input));
    const tracked = operation.then(result => {
      if (result?.ok === false) discoveryCounters.failed += 1;
      else discoveryCounters.completed += 1;
      return result;
    }, error => {
      discoveryCounters.failed += 1;
      throw error;
    }).finally(() => discoveryWork.delete(kind));
    discoveryWork.set(kind, tracked);
    return tracked;
  }

  function prune(map, maximum) {
    const timestamp = Number(now() || Date.now());
    for (const [token, row] of map) if (Number(row.expiresAt || 0) <= timestamp) map.delete(token);
    while (map.size >= maximum) map.delete(map.keys().next().value);
  }

  function validToken(value) {
    const token = text(value, 64);
    return /^[A-Za-z0-9_-]{24}$/.test(token) ? token : "";
  }

  function recordDiscovery(kindRaw, rowsRaw) {
    const kind = ["hue", "wiz", "govee"].includes(kindRaw) ? kindRaw : "wiz";
    const rows = Array.isArray(rowsRaw) ? rowsRaw.slice(0, 16) : [];
    const targets = [];
    for (const [index, row] of rows.entries()) {
      const ip = text(row?.ip, 255);
      if (!ip) continue;
      prune(discovery, MAX_DISCOVERY_TARGETS);
      const selectionToken = randomToken();
      discovery.set(selectionToken, {
        kind,
        ip,
        bridgeId: text(row?.id, 128).toUpperCase(),
        name: text(row?.roomName || row?.moduleName, 96),
        moduleName: text(row?.moduleName, 96),
        device: text(row?.device, 128),
        sku: text(row?.sku, 32).toUpperCase(),
        expiresAt: Number(now() || Date.now()) + DISCOVERY_TTL_MS
      });
      targets.push({
        selectionToken,
        label: kind === "hue" ? `Hue bridge ${index + 1}` : kind === "govee" ? (text(row?.name, 96) || `Govee light ${index + 1}`) : (text(row?.roomName || row?.moduleName, 96) || `WiZ device ${index + 1}`),
        addressHint: maskAddress(ip)
      });
    }
    return targets;
  }

  function takeDiscovery(selectionToken, expectedKind = "") {
    const token = validToken(selectionToken);
    const target = token ? discovery.get(token) : null;
    if (!target || target.expiresAt <= Number(now() || Date.now()) || (expectedKind && target.kind !== expectedKind)) {
      if (target) discovery.delete(token);
      return { ok: false, error: "discovery_selection_expired" };
    }
    discovery.delete(token);
    return { ok: true, target };
  }

  function selectDiscovery(selectionToken) {
    const selected = takeDiscovery(selectionToken);
    return selected.ok
      ? { ok: true, kind: selected.target.kind, address: selected.target.ip, oneTimeReveal: true }
      : selected;
  }

  function prepareHue(input = {}) {
    let bridgeIp = text(input.bridgeIp, 255);
    let bridgeId = text(input.bridgeId, 128).toUpperCase();
    if (input.selectionToken) {
      const selected = takeDiscovery(input.selectionToken, "hue");
      if (!selected.ok) return selected;
      bridgeIp = selected.target.ip;
      bridgeId = selected.target.bridgeId;
    }
    if (!bridgeIp) return { ok: false, error: "missing_hue_bridge" };
    for (const [token, row] of huePairTargets) {
      if (!row.inFlight && row.expiresAt <= Number(now())) huePairTargets.delete(token);
    }
    if (huePairTargets.size >= MAX_HUE_PAIR_TARGETS) return { ok: false, error: 'hue_pairing_capacity_reached' };
    const pairingToken = randomToken();
    huePairTargets.set(pairingToken, {
      bridgeIp,
      bridgeId,
      attempts: 0,
      inFlight: false,
      paired: null,
      expiresAt: Number(now() || Date.now()) + HUE_PAIR_TARGET_TTL_MS
    });
    return {
      ok: true,
      pairingToken,
      state: "awaiting_link_button",
      expiresInSeconds: HUE_PAIR_TARGET_TTL_MS / 1000,
      bridge: { addressHint: maskAddress(bridgeIp) }
    };
  }

  async function pairHue(input = {}) {
    let pairingToken = validToken(input.pairingToken);
    if (!pairingToken) {
      const prepared = prepareHue(input);
      if (!prepared.ok) return prepared;
      pairingToken = prepared.pairingToken;
    }
    const target = huePairTargets.get(pairingToken);
    if (!target || target.expiresAt <= Number(now() || Date.now())) {
      if (target) huePairTargets.delete(pairingToken);
      return { ok: false, error: "hue_pairing_session_expired" };
    }
    if (target.inFlight) return { ok: false, error: "hue_pairing_in_progress", pairingToken, retryable: true };
    if ([...huePairTargets.values()].some(row => row.inFlight)) return { ok: false, error: 'hue_pairing_in_progress', retryable: true };
    target.inFlight = true;
    target.attempts += 1;
    try {
      if (!target.paired) {
        const paired = await core.hueBridge.pairBridge({ bridgeIp: target.bridgeIp, bridgeId: target.bridgeId, timeoutMs: input.timeoutMs });
        if (!paired?.ok) {
          return {
            ok: false,
            error: text(paired?.error || "hue_pair_failed", 96),
            pairingToken,
            retryable: true,
            expiresInSeconds: Math.max(0, Math.ceil((target.expiresAt - Number(now() || Date.now())) / 1000))
          };
        }
        target.paired = paired;
      }
      const paired = target.paired;
    const lightsResult = await core.hueBridge.listLights({
      bridgeIp: paired.bridge?.ip,
      username: paired.credentials?.username
    });
      if (!lightsResult?.ok || !lightsResult.lights?.length) {
        return {
          ok: false,
          error: text(lightsResult?.error || "hue_bridge_has_no_lights", 96),
          pairingToken,
          retryable: true,
          paired: true
        };
      }
    prune(hueSetups, MAX_HUE_SETUPS);
    const setupToken = randomToken();
    const lights = lightsResult.lights.slice(0, MAX_COMMIT_FIXTURES).map(row => ({
      lightId: Number(row.lightId || 0),
      name: text(row.name, 96),
      modelId: text(row.modelId, 64),
      productName: text(row.productName, 96),
      type: text(row.type, 96),
      uniqueId: text(row.uniqueId, 128)
    })).filter(row => row.lightId > 0);
    hueSetups.set(setupToken, {
      bridge: paired.bridge,
      credentials: paired.credentials,
      entertainmentAreas: Array.isArray(paired.entertainmentAreas) ? paired.entertainmentAreas.slice(0, 32) : [],
      capabilities: paired.capabilities || {},
      lights,
      expiresAt: Number(now() || Date.now()) + HUE_SETUP_TTL_MS
    });
      huePairTargets.delete(pairingToken);
    return {
      ok: true,
      setupToken,
      expiresInSeconds: HUE_SETUP_TTL_MS / 1000,
      bridge: { addressHint: maskAddress(paired.bridge?.ip), modelId: text(paired.capabilities?.bridgeModelId, 64) },
      lights: lights.map(({ uniqueId, ...row }) => row),
      entertainmentAreas: (paired.entertainmentAreas || []).map(row => ({ id: text(row.id, 64), name: text(row.name, 96) }))
    };
    } finally {
      const retained = huePairTargets.get(pairingToken);
      if (retained) retained.inFlight = false;
    }
  }

  function uniqueFixtureId(base, existingIds) {
    const root = slug(base, "light").slice(0, 56);
    if (!existingIds.has(root)) return root;
    for (let index = 2; index <= 999; index += 1) {
      const candidate = `${root.slice(0, 59 - String(index).length)}-${index}`;
      if (!existingIds.has(candidate)) return candidate;
    }
    return `${root.slice(0, 39)}-${randomToken().slice(0, 8)}`;
  }

  function commitHue(input = {}) {
    const token = validToken(input.setupToken);
    const setup = token ? hueSetups.get(token) : null;
    if (!setup || setup.expiresAt <= Number(now() || Date.now())) {
      if (setup) hueSetups.delete(token);
      return { ok: false, error: "hue_setup_expired" };
    }
    const requested = new Set((Array.isArray(input.lightIds) ? input.lightIds : []).map(Number).filter(value => Number.isInteger(value) && value > 0));
    const lights = input.mode === "all" ? setup.lights : setup.lights.filter(row => requested.has(row.lightId));
    if (!lights.length) return { ok: false, error: "no_hue_lights_selected" };
    const current = core.fixtureRegistry.getFixtures();
    const existingIds = new Set(current.map(row => row.id));
    const zone = slug(input.zone, "hue").slice(0, 64);
    const area = setup.entertainmentAreas.find(row => String(row.id) === String(input.entertainmentAreaId || "")) || null;
    const fixtures = lights.map(light => {
      const existing = current.find(row => row.brand === "hue" && row.bridgeId === setup.bridge.id && Number(row.lightId) === light.lightId);
      const id = existing?.id || uniqueFixtureId(`hue-${light.name || light.lightId}`, existingIds);
      existingIds.add(id);
      return {
        id,
        name: light.name,
        brand: "hue",
        zone,
        enabled: true,
        engineEnabled: true,
        twitchEnabled: input.twitchEnabled !== false,
        bridgeIp: setup.bridge.ip,
        bridgeId: setup.bridge.id,
        username: setup.credentials.username,
        clientKey: setup.credentials.clientKey,
        entertainmentAreaId: area?.id || "",
        lightId: light.lightId,
        extras: {
          productName: light.productName,
          modelId: light.modelId,
          hueBridgeCapabilities: setup.capabilities
        }
      };
    });
    const saved = core.fixtureRegistry.upsertFixtures(fixtures);
    if (saved.ok) hueSetups.delete(token);
    return saved.ok
      ? { ok: true, installed: saved.fixtures.map(row => ({ id: row.id, name: row.name, lightId: row.lightId, zone: row.zone })), mode: input.mode === "all" ? "all" : "selected" }
      : saved;
  }

  function commitWiz(input = {}) {
    const tokens = [...new Set((Array.isArray(input.selectionTokens) ? input.selectionTokens : [input.selectionToken]).map(validToken).filter(Boolean))].slice(0, MAX_COMMIT_FIXTURES);
    if (!tokens.length) return { ok: false, error: "no_wiz_devices_selected" };
    const selected = [];
    for (const token of tokens) {
      const result = takeDiscovery(token, "wiz");
      if (result.ok) selected.push(result.target);
    }
    if (!selected.length) return { ok: false, error: "discovery_selection_expired" };
    const current = core.fixtureRegistry.getFixtures();
    const existingIds = new Set(current.map(row => row.id));
    const fixtures = selected.map((target, index) => {
      const existing = current.find(row => row.brand === "wiz" && row.ip === target.ip);
      const displayName = target.name || `WiZ light ${index + 1}`;
      const id = existing?.id || uniqueFixtureId(`wiz-${displayName}`, existingIds);
      existingIds.add(id);
      return {
        id,
        name: displayName,
        brand: "wiz",
        zone: slug(input.zone || target.name, "wiz").slice(0, 64),
        enabled: true,
        engineEnabled: true,
        twitchEnabled: input.twitchEnabled !== false,
        ip: target.ip,
        extras: { moduleName: target.moduleName }
      };
    });
    const saved = core.fixtureRegistry.upsertFixtures(fixtures);
    return saved.ok
      ? { ok: true, installed: saved.fixtures.map(row => ({ id: row.id, name: row.name, zone: row.zone })), skippedExpired: tokens.length - selected.length }
      : saved;
  }

  function commitGovee(input = {}) {
    const tokens = [...new Set((Array.isArray(input.selectionTokens) ? input.selectionTokens : [input.selectionToken]).map(validToken).filter(Boolean))].slice(0, MAX_COMMIT_FIXTURES);
    const selected = tokens.map(token => takeDiscovery(token, "govee")).filter(row => row.ok).map(row => row.target);
    if (!selected.length) return { ok: false, error: tokens.length ? "discovery_selection_expired" : "no_govee_devices_selected" };
    const current = core.fixtureRegistry.getFixtures(), existingIds = new Set(current.map(row => row.id));
    const fixtures = selected.map((target, index) => {
      const existing = current.find(row => row.brand === "govee" && (row.extras?.device === target.device || row.ip === target.ip));
      const displayName = target.name || `Govee ${target.sku || `light ${index + 1}`}`;
      const id = existing?.id || uniqueFixtureId(`govee-${displayName}`, existingIds); existingIds.add(id);
      return { id, name: displayName, brand: "govee", zone: slug(input.zone || target.name, "govee"), enabled: true, engineEnabled: true, twitchEnabled: input.twitchEnabled !== false, ip: target.ip, extras: { device: target.device, sku: target.sku, alpha: true, transport: "lan" } };
    });
    const saved = core.fixtureRegistry.upsertFixtures(fixtures);
    return saved.ok ? { ok: true, alpha: true, installed: saved.fixtures.map(row => ({ id: row.id, name: row.name, zone: row.zone })) } : saved;
  }

  function getDiagnostics() {
    prune(discovery, MAX_DISCOVERY_TARGETS);
    for (const [token, row] of huePairTargets) {
      if (!row.inFlight && row.expiresAt <= Number(now())) huePairTargets.delete(token);
    }
    prune(hueSetups, MAX_HUE_SETUPS);
    return { ok: true, discoverySessions: discovery.size, huePairingSessions: huePairTargets.size, hueSetupSessions: hueSetups.size, maximumDiscoverySessions: MAX_DISCOVERY_TARGETS, maximumHuePairingSessions: MAX_HUE_PAIR_TARGETS, maximumHueSetupSessions: MAX_HUE_SETUPS,
      discoveryWork: { active: discoveryWork.size, maximumActive: 2, ...discoveryCounters } };
  }

  async function testFixture(idRaw, input = {}) {
    const id = text(idRaw, 64);
    const fixture = core.fixtureRegistry.getFixtures().find(row => row.id === id);
    if (!fixture) return { ok: false, reachable: false, error: "fixture_not_found" };
    if (fixture.brand === "hue") {
      const inventory = await core.hueBridge.listLights({ bridgeIp: fixture.bridgeIp, username: fixture.username, timeoutMs: input.timeoutMs });
      const light = inventory?.lights?.find(row => Number(row.lightId) === Number(fixture.lightId));
      return light
        ? { ok: true, reachable: true, fixture: { id: fixture.id, name: fixture.name, brand: "hue" }, hardware: { name: text(light.name, 96), productName: text(light.productName, 96), modelId: text(light.modelId, 64) } }
        : { ok: false, reachable: false, error: inventory?.ok ? "hue_light_not_found" : text(inventory?.error || "hue_probe_failed", 96) };
    }
    if (fixture.brand === "wiz") {
      const probe = await core.wizBridge.probeDevice(fixture, { timeoutMs: input.timeoutMs });
      return probe.ok
        ? { ...probe, fixture: { id: fixture.id, name: fixture.name, brand: "wiz" } }
        : probe;
    }
    if (fixture.brand === "govee") {
      if (typeof core.goveeBridge?.probeDevice !== "function") return { ok: false, reachable: false, error: "govee_alpha_unavailable" };
      const probe = await core.goveeBridge.probeDevice(fixture, { timeoutMs: input.timeoutMs });
      return probe.ok ? { ...probe, fixture: { id: fixture.id, name: fixture.name, brand: "govee", alpha: true } } : probe;
    }
    return { ok: false, reachable: false, error: "fixture_probe_unsupported" };
  }

  return Object.freeze({ discover, recordDiscovery, selectDiscovery, prepareHue, pairHue, commitHue, commitWiz, commitGovee, testFixture, getDiagnostics });
};

module.exports.constants = { DISCOVERY_TTL_MS, HUE_PAIR_TARGET_TTL_MS, HUE_SETUP_TTL_MS, MAX_DISCOVERY_TARGETS, MAX_HUE_PAIR_TARGETS, MAX_HUE_SETUPS, MAX_COMMIT_FIXTURES };
