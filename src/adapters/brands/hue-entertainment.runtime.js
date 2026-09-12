// [TITLE] Module: adapters/brands/hue-entertainment.runtime.js
// [TITLE] Purpose: bounded Hue Entertainment transport runtime (session start/send/stop)
// [TITLE] Functionality Index:
// [TITLE] - lazy optional dependency loading for hue-sync + cross-fetch compatibility
// [TITLE] - bridge/area session lifecycle with deterministic keying
// [TITLE] - RGB frame fan-out for fixture-group sends
// [TITLE] - explicit status surface for diagnostics + readiness
// [DEV] Complex Flow:
// [DEV] Session ownership is scoped by bridge + username + clientKey + area so
// [DEV] one failing stream does not poison unrelated Hue groups.

const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns");

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number(fallback);
  return Math.min(Number(max), Math.max(Number(min), parsed));
}

function normalizeToken(value) {
  return String(value || "").trim();
}

function normalizeHost(value) {
  return String(value || "").trim().toLowerCase();
}

function buildSessionKey(config = {}) {
  const bridgeIp = normalizeHost(config.bridgeIp);
  const username = normalizeToken(config.username);
  const clientKey = normalizeToken(config.clientKey).toUpperCase();
  const area = normalizeToken(config.entertainmentAreaId).toLowerCase();
  const bridgeId = normalizeToken(config.bridgeId).toLowerCase();
  if (!bridgeIp || !username || !clientKey || !area) return "";
  return `${bridgeIp}|${username}|${clientKey}|${area}|${bridgeId}`;
}

function inferAreaChannelCount(area = {}) {
  const channels = Array.isArray(area.channels) ? area.channels.length : 0;
  if (channels > 0) return channels;
  const lightServices = Array.isArray(area.light_services) ? area.light_services.length : 0;
  if (lightServices > 0) return lightServices;
  const serviceLocations = Array.isArray(area?.locations?.service_locations)
    ? area.locations.service_locations.length
    : 0;
  if (serviceLocations > 0) return serviceLocations;
  return 1;
}

function getAreaTokenSet(area = {}) {
  const values = [
    area?.id,
    area?.rid,
    area?.name,
    area?.metadata?.name
  ];
  const tokens = new Set();
  for (const value of values) {
    const token = String(value || "").trim().toLowerCase();
    if (!token) continue;
    tokens.add(token);
  }
  return tokens;
}

function matchArea(areas = [], requested = "") {
  const rows = Array.isArray(areas) ? areas.filter(row => row && typeof row === "object") : [];
  if (!rows.length) return null;
  const requestedToken = String(requested || "").trim().toLowerCase();
  if (!requestedToken) return rows[0];
  for (const row of rows) {
    const tokens = getAreaTokenSet(row);
    if (tokens.has(requestedToken)) return row;
  }
  return rows[0];
}

function sanitizeError(error) {
  return String(error?.message || error || "unknown_hue_entertainment_error").trim();
}

const baseDnsLookup = typeof dns.lookup === "function"
  ? dns.lookup.bind(dns)
  : null;
const hueDnsOverrides = new Map();
const MAX_HUE_DNS_OVERRIDES = 768;
let hueDnsOverrideEvictions = 0;
let hueDnsPatchInstalled = false;
let patchedHueLookupFn = null;
let hueDnsPatchReadyLogged = false;
const hueCaTrustReadyByPath = new Set();

function isValidIpv4Host(value = "") {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(value || "").trim());
}

function normalizeBridgeDnsToken(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9:-]/g, "");
}

function normalizeBridgeDnsTokenCompact(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildBridgeDnsLookupCandidates(hostname = "") {
  const raw = String(hostname || "").trim().toLowerCase();
  if (!raw) return [];
  const hostOnly = raw.split(".")[0] || raw;
  const tokens = new Set();
  const candidates = [raw, hostOnly];
  for (const candidate of candidates) {
    const token = normalizeBridgeDnsToken(candidate);
    if (token) tokens.add(token);
    const compact = normalizeBridgeDnsTokenCompact(candidate);
    if (compact) tokens.add(compact);
    if (compact.length >= 16) {
      tokens.add(compact.slice(0, 16));
    }
  }
  return Array.from(tokens);
}

function installHueDnsOverride(log = console) {
  if (!baseDnsLookup) return;
  if (patchedHueLookupFn && dns.lookup === patchedHueLookupFn) {
    hueDnsPatchInstalled = true;
    return;
  }
  patchedHueLookupFn = function patchedHueLookup(hostname, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof options === "function") {
      cb = options;
      opts = undefined;
    }
    const hostTokens = buildBridgeDnsLookupCandidates(hostname);
    const mappedIp = hostTokens
      .map(token => hueDnsOverrides.get(token))
      .find(Boolean);
    if (mappedIp && typeof cb === "function") {
      const allMode = Boolean(opts && typeof opts === "object" && opts.all === true);
      if (allMode) {
        return process.nextTick(() => cb(null, [{ address: mappedIp, family: 4 }]));
      }
      return process.nextTick(() => cb(null, mappedIp, 4));
    }
    return baseDnsLookup(hostname, opts, cb);
  };
  dns.lookup = patchedHueLookupFn;
  hueDnsPatchInstalled = true;
  if (!hueDnsPatchReadyLogged) {
    hueDnsPatchReadyLogged = true;
    log.log?.("[HUE] Entertainment DNS bridge-id override ready");
  }
}

function registerHueDnsOverride(bridgeId = "", bridgeIp = "", log = console) {
  const bridgeToken = normalizeBridgeDnsToken(bridgeId);
  const bridgeTokenCompact = normalizeBridgeDnsTokenCompact(bridgeId);
  const ip = String(bridgeIp || "").trim();
  if ((!bridgeToken && !bridgeTokenCompact) || !isValidIpv4Host(ip)) return false;
  installHueDnsOverride(log);
  const setOverride = token => {
    if (!hueDnsOverrides.has(token) && hueDnsOverrides.size >= MAX_HUE_DNS_OVERRIDES) {
      hueDnsOverrides.delete(hueDnsOverrides.keys().next().value);
      hueDnsOverrideEvictions += 1;
    }
    hueDnsOverrides.set(token, ip);
  };
  if (bridgeToken) {
    setOverride(bridgeToken);
  }
  if (bridgeTokenCompact) {
    setOverride(bridgeTokenCompact);
    if (bridgeTokenCompact.length >= 16) {
      setOverride(bridgeTokenCompact.slice(0, 16));
    }
  }
  return true;
}

function resolveSignifyPemPath(rootDir = "") {
  const candidates = [];
  if (process.env.RAVE_HUE_CA_CERT_PATH) {
    candidates.push(String(process.env.RAVE_HUE_CA_CERT_PATH || "").trim());
  }
  try {
    const hueSyncPkg = require.resolve("hue-sync/package.json");
    const hueSyncDir = path.dirname(hueSyncPkg);
    candidates.push(path.join(hueSyncDir, "signify.pem"));
  } catch {
    // Optional dependency path.
  }
  if (rootDir) {
    candidates.push(path.join(rootDir, "node_modules", "hue-sync", "signify.pem"));
  }
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || "";
}

function ensureHueCaTrust(rootDir = "", log = console) {
  const certPath = resolveSignifyPemPath(rootDir);
  if (!certPath) {
    return {
      installed: false,
      reason: "signify_pem_missing",
      certPath: ""
    };
  }
  const existing = String(process.env.NODE_EXTRA_CA_CERTS || "").trim();
  if (!existing) {
    process.env.NODE_EXTRA_CA_CERTS = certPath;
    if (!hueCaTrustReadyByPath.has(certPath)) {
      hueCaTrustReadyByPath.add(certPath);
      log.log?.(`[HUE] Entertainment CA trust ready (${path.basename(certPath)})`);
    }
    return {
      installed: true,
      reason: "node_extra_ca_set",
      certPath
    };
  }
  if (existing.toLowerCase() === certPath.toLowerCase()) {
    return {
      installed: true,
      reason: "node_extra_ca_already_set",
      certPath
    };
  }
  return {
    installed: false,
    reason: "node_extra_ca_conflict",
    certPath
  };
}

module.exports = function createHueEntertainmentRuntime(options = {}) {
  const log = options.log || console;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const rootDir = normalizeToken(options.rootDir || process.cwd());
  const SESSION_IDLE_TTL_MS = Math.max(5000, Math.round(Number(options.sessionIdleTtlMs || 30000)));
  const START_TIMEOUT_MS = Math.max(1500, Math.round(Number(options.startTimeoutMs || 9000)));

  let HueSyncConstructor = null;
  let availabilityReason = "";
  let crossFetchEnabled = false;
  const caTrust = ensureHueCaTrust(rootDir, log);
  let lastSessionStopLog = {
    reason: "",
    at: 0
  };

  try {
    const crossFetch = require("cross-fetch");
    const fetchFn = crossFetch?.fetch || crossFetch;
    if (typeof fetchFn === "function") {
      globalThis.fetch = fetchFn;
      if (crossFetch?.Headers) globalThis.Headers = crossFetch.Headers;
      if (crossFetch?.Request) globalThis.Request = crossFetch.Request;
      if (crossFetch?.Response) globalThis.Response = crossFetch.Response;
      crossFetchEnabled = true;
    }
  } catch {
    crossFetchEnabled = false;
  }

  try {
    const hueSyncModule = require("hue-sync");
    HueSyncConstructor = hueSyncModule?.HueSync || hueSyncModule?.default || hueSyncModule;
    if (typeof HueSyncConstructor !== "function") {
      HueSyncConstructor = null;
      availabilityReason = "hue-sync constructor unavailable";
    }
  } catch (error) {
    availabilityReason = `hue-sync unavailable (${sanitizeError(error)})`;
  }

  const sessionsByKey = new Map();
  const startPromiseByKey = new Map();
  let lastError = "";
  let lastErrorAt = 0;

  function shouldLogSessionStop(reason = "") {
    const token = String(reason || "").trim().toLowerCase();
    if (!token) return false;
    if (
      token === "idle_timeout"
      || token === "transition_failed"
      || token === "transport_mode_rest"
      || token === "shutdown"
    ) {
      return false;
    }
    const at = Number(now() || Date.now());
    const sameReason = token === String(lastSessionStopLog.reason || "");
    const withinWindow = (at - Number(lastSessionStopLog.at || 0)) < 15000;
    if (sameReason && withinWindow) return false;
    lastSessionStopLog = { reason: token, at };
    return true;
  }

  function formatSessionStopReason(reason = "") {
    return String(reason || "")
      .trim()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase() || "unknown";
  }

  async function stopSessionByKey(key = "", reason = "stop") {
    const token = String(key || "").trim();
    if (!token) return;
    const session = sessionsByKey.get(token);
    if (!session) return;
    sessionsByKey.delete(token);
    try {
      if (session.bridge && typeof session.bridge.updateEntertainmentArea === "function" && session.areaId) {
        await Promise.resolve(session.bridge.updateEntertainmentArea(session.areaId, { action: "stop" }));
      }
    } catch {
      // [DEV] Best effort shutdown: keep teardown robust even when bridge rejects stop.
    }
    try {
      if (session.socketErrorHandler && session.bridge?.socket) {
        const socket = session.bridge.socket;
        if (typeof socket.off === "function") {
          socket.off("error", session.socketErrorHandler);
        } else if (typeof socket.removeListener === "function") {
          socket.removeListener("error", session.socketErrorHandler);
        }
      }
    } catch {
      // best effort
    }
    try {
      session.bridge?.stop?.();
    } catch {
      // best effort
    }
    try {
      session.bridge?.abortionController?.abort?.();
    } catch {
      // best effort
    }
    try {
      session.bridge?.socket?.close?.();
    } catch {
      // best effort
    }
    if (shouldLogSessionStop(reason)) {
      log.warn?.(`[HUE] Entertainment session stopped (${formatSessionStopReason(reason)})`);
    }
  }

  async function cleanupIdleSessions() {
    const at = Number(now() || Date.now());
    const keys = Array.from(sessionsByKey.keys());
    for (const key of keys) {
      const row = sessionsByKey.get(key);
      if (!row) continue;
      const ageMs = Math.max(0, at - Number(row.lastUsedAt || 0));
      if (ageMs <= SESSION_IDLE_TTL_MS) continue;
      await stopSessionByKey(key, "idle_timeout");
    }
  }

  async function ensureSession(config = {}) {
    const key = buildSessionKey(config);
    if (!key) {
      return { ok: false, error: "hue_entertainment_config_incomplete" };
    }
    if (!HueSyncConstructor) {
      return { ok: false, error: availabilityReason || "hue_sync_unavailable" };
    }
    const existing = sessionsByKey.get(key);
    if (existing && existing.active === true) {
      existing.lastUsedAt = Number(now() || Date.now());
      return { ok: true, session: existing };
    }
    if (startPromiseByKey.has(key)) {
      return startPromiseByKey.get(key);
    }

    const startPromise = (async () => {
      const bridge = new HueSyncConstructor({
        credentials: {
          username: normalizeToken(config.username),
          clientkey: normalizeToken(config.clientKey).toUpperCase()
        },
        id: normalizeToken(config.bridgeId),
        url: normalizeHost(config.bridgeIp)
      });
      // [DEV] hue-sync constructor patches dns.lookup with a legacy callback shape.
      // [DEV] Re-apply our Node-24-safe override immediately after construction.
      registerHueDnsOverride(config.bridgeId, config.bridgeIp, log);
      if (normalizeToken(config.bridgeId)) bridge.id = normalizeToken(config.bridgeId);
      if (normalizeHost(config.bridgeIp)) bridge.url = normalizeHost(config.bridgeIp);

      const areas = await Promise.resolve(bridge.getEntertainmentAreas?.() || []);
      const selectedArea = matchArea(areas, config.entertainmentAreaId);
      if (!selectedArea) {
        return { ok: false, error: "hue_entertainment_area_unavailable" };
      }
      // [DEV] Guard against Node 24 + hue-sync start hanging when DTLS emits error
      // [DEV] before hue-sync resolves the start promise. We always race start with
      // [DEV] socket error and timeout to avoid deadlocks + unhandled events.
      const startResult = await new Promise(resolve => {
        let settled = false;
        let guardTimer = null;
        const settle = (ok, error = "") => {
          if (settled) return;
          settled = true;
          if (guardTimer) {
            clearTimeout(guardTimer);
            guardTimer = null;
          }
          resolve({
            ok,
            error: sanitizeError(error || "")
          });
        };
        const startCall = Promise.resolve(bridge.start(selectedArea, START_TIMEOUT_MS));
        const dtlsSocket = bridge?.socket;
        const onSocketError = error => {
          settle(false, error || "dtls_socket_error");
        };
        if (dtlsSocket && typeof dtlsSocket.once === "function") {
          dtlsSocket.once("error", onSocketError);
        }
        guardTimer = setTimeout(() => {
          settle(false, "hue_entertainment_start_timeout");
        }, Math.max(START_TIMEOUT_MS + 1200, 2500));
        startCall
          .then(() => settle(true))
          .catch(error => settle(false, error || "hue_entertainment_start_failed"));
      });
      if (!startResult.ok) {
        try {
          bridge?.abortionController?.abort?.();
        } catch {
          // best effort
        }
        try {
          bridge?.socket?.close?.();
        } catch {
          // best effort
        }
        return {
          ok: false,
          error: startResult.error || "hue_entertainment_start_failed"
        };
      }

      const areaId = normalizeToken(selectedArea?.id || selectedArea?.rid || "");
      const session = {
        key,
        active: true,
        bridge,
        areaId,
        areaName: normalizeToken(selectedArea?.name || selectedArea?.metadata?.name || areaId),
        channelCount: Math.max(1, inferAreaChannelCount(selectedArea)),
        lastUsedAt: Number(now() || Date.now()),
        socketErrorHandler: null
      };
      const socket = bridge?.socket;
      if (socket && typeof socket.on === "function") {
        const socketErrorHandler = error => {
          lastError = sanitizeError(error || "hue_entertainment_socket_error");
          lastErrorAt = Number(now() || Date.now());
          void stopSessionByKey(key, "socket_error");
        };
        socket.on("error", socketErrorHandler);
        session.socketErrorHandler = socketErrorHandler;
      }
      sessionsByKey.set(key, session);
      return { ok: true, session };
    })()
      .catch(error => {
        lastError = sanitizeError(error);
        lastErrorAt = Number(now() || Date.now());
        return {
          ok: false,
          error: lastError
        };
      })
      .finally(() => {
        startPromiseByKey.delete(key);
      });

    startPromiseByKey.set(key, startPromise);
    return startPromise;
  }

  function scaleRgbForBrightness(rgb = {}, bri = 254, on = true) {
    if (on === false) {
      return { r: 0, g: 0, b: 0 };
    }
    const gain = clampNumber(Number(bri) / 254, 0, 1, 1);
    return {
      r: clampNumber(Math.round(Number(rgb.r || 0) * gain), 0, 255, 0),
      g: clampNumber(Math.round(Number(rgb.g || 0) * gain), 0, 255, 0),
      b: clampNumber(Math.round(Number(rgb.b || 0) * gain), 0, 255, 0)
    };
  }

  async function sendFrame(config = {}, input = {}) {
    await cleanupIdleSessions();
    const ensured = await ensureSession(config);
    if (!ensured.ok) return ensured;
    const session = ensured.session;
    const rgbInput = input?.rgb && typeof input.rgb === "object" ? input.rgb : { r: 0, g: 0, b: 0 };
    const rgb = scaleRgbForBrightness(rgbInput, input.bri, input.on !== false);
    const requestedCount = Math.max(
      1,
      Math.round(Number(input.channelCount || input.fixtureCount || session.channelCount || 1))
    );
    const frame = Array.from({ length: requestedCount }, () => [rgb.r, rgb.g, rgb.b]);
    try {
      await Promise.resolve(session.bridge.transition(frame));
      session.lastUsedAt = Number(now() || Date.now());
      return {
        ok: true,
        channelCount: requestedCount
      };
    } catch (error) {
      const detail = sanitizeError(error);
      lastError = detail;
      lastErrorAt = Number(now() || Date.now());
      await stopSessionByKey(session.key, "transition_failed");
      return {
        ok: false,
        error: detail
      };
    }
  }

  async function stopAll(reason = "shutdown") {
    const keys = Array.from(sessionsByKey.keys());
    for (const key of keys) {
      await stopSessionByKey(key, reason);
    }
    return {
      ok: true,
      stopped: keys.length
    };
  }

  async function reconcileConfigs(configs = []) {
    const retained = new Set((Array.isArray(configs) ? configs : []).map(buildSessionKey).filter(Boolean));
    const stale = [...sessionsByKey.keys()].filter(key => !retained.has(key));
    for (const key of stale) await stopSessionByKey(key, "fixture_removed");
    return { ok: true, removed: stale.length, retained: retained.size };
  }

  function getStatus() {
    return {
      available: typeof HueSyncConstructor === "function",
      reason: availabilityReason,
      crossFetchEnabled,
      caTrust,
      dnsOverrideCount: hueDnsOverrides.size,
      maximumDnsOverrides: MAX_HUE_DNS_OVERRIDES,
      dnsOverrideEvictions: hueDnsOverrideEvictions,
      activeSessions: sessionsByKey.size,
      lastError,
      lastErrorAt
    };
  }

  return {
    sendFrame,
    stopAll,
    reconcileConfigs,
    getStatus
  };
};
