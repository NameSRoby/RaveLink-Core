// [TITLE] Module: adapters/brands/hue-bridge.adapter.js
// [TITLE] Purpose: Hue transport adapter boundary
// [TITLE] Functionality Index:
// [TITLE] - emit Hue light state payloads
// [TITLE] - discover local Hue bridges and pair via link-button flow
// [TITLE] - support dry-run behavior for safe bring-up
// [TITLE] - aggregate send success/failure telemetry

const fs = require("node:fs");
const path = require("node:path");
const tls = require("node:tls");
const https = require("node:https");
const createHueEntertainmentRuntime = require("./hue-entertainment.runtime");
let DefaultBonjour;

function loadDefaultBonjour() {
  if (DefaultBonjour !== undefined) return DefaultBonjour;
  try { ({ Bonjour: DefaultBonjour } = require("bonjour-service")); }
  catch { DefaultBonjour = null; }
  return DefaultBonjour;
}

module.exports = function createHueBridgeAdapter(options = {}) {
  const axios = options.axios;
  const getHttpsAgent = typeof options.getHttpsAgent === "function"
    ? options.getHttpsAgent
    : (() => undefined);
  const log = options.log || console;
  const dryRun = options.dryRun !== false;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setTimeoutFn = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const getBonjour = typeof options.Bonjour === "function" ? () => options.Bonjour : loadDefaultBonjour;
  const egressGovernor = options.egressGovernor && typeof options.egressGovernor.run === "function"
    ? options.egressGovernor
    : null;
  const rootDir = String(options.rootDir || process.cwd()).trim();
  const createHueEntertainment = typeof options.createHueEntertainmentRuntime === "function"
    ? options.createHueEntertainmentRuntime
    : createHueEntertainmentRuntime;
  const hueEntertainment = createHueEntertainment({
    log,
    now,
    rootDir
  });
  const TRANSPORT_MODES = new Set(["auto", "rest", "entertainment"]);
  let transportMode = "auto";
  let hueRestCaPem = "";
  const hueRestHttpsAgentByBridge = new Map();
  let transportTelemetry = {
    transportDesired: "auto",
    transportActive: "rest",
    transportFallbackReason: "",
    entertainment: {
      active: false,
      reason: "idle",
      fixtureReadyCount: 0,
      fixtureTotalCount: 0,
      lastAttemptAt: 0
    },
    sent: 0,
    skipped: 0,
    sendErrors: 0,
    lastDurationMs: 0,
    updatedAt: Number(now() || Date.now())
  };
  let lastSendErrorLog = {
    message: "",
    at: 0
  };
  const hueBridgeFailureState = new Map();
  const hueBridgeTransportHints = new Map();
  const hueEntertainmentSuppressionByBridge = new Map();
  const hueBridgeCapabilityCache = new Map();
  const hueBridgeCapabilityProbeByKey = new Map();
  const HUE_SEND_ERROR_LOG_WINDOW_MS = 15000;
  const HUE_REQUEST_TIMEOUT_MS = 2400;
  const HUE_REQUEST_TIMEOUT_FALLBACK_MS = 2200;
  const HUE_FAILURE_COOLDOWN_BASE_MS = 3000;
  const HUE_FAILURE_COOLDOWN_MAX_MS = 60000;
  const HUE_HTTP_HINT_MS = 10 * 60 * 1000;
  const HUE_ENTERTAINMENT_SUPPRESS_MS = 15 * 60 * 1000;
  const HUE_HTTP_FORCE_HINT_MS = 60 * 60 * 1000;
  const HUE_BRIDGE_CAPABILITY_TTL_MS = 30 * 60 * 1000;
  const MAX_HUE_CACHE_ENTRIES = 256;
  const MAX_HUE_REST_CONCURRENCY = 4;
  let cacheEvictions = 0;
  let lifecycleEvictions = 0;

  function setBoundedMap(map, key, value, onEvict = null) {
    if (!map.has(key) && map.size >= MAX_HUE_CACHE_ENTRIES) {
      const oldestKey = map.keys().next().value;
      const oldest = map.get(oldestKey);
      map.delete(oldestKey);
      cacheEvictions += 1;
      try { onEvict?.(oldest); } catch {}
    }
    map.set(key, value);
  }

  async function runBoundedOperations(operations, maximumConcurrent = MAX_HUE_REST_CONCURRENCY) {
    const results = new Array(operations.length);
    let cursor = 0;
    async function worker() {
      while (cursor < operations.length) {
        const index = cursor;
        cursor += 1;
        try {
          const operation = operations[index];
          const value = egressGovernor
            ? await egressGovernor.run({ owner: "lighting.hue", priority: "baseline", queueDeadlineMs: 5000 }, operation)
            : await operation();
          results[index] = { status: "fulfilled", value };
        }
        catch (reason) { results[index] = { status: "rejected", reason }; }
      }
    }
    const workers = Array.from({ length: Math.min(maximumConcurrent, operations.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return Number(fallback);
    return Math.min(Number(max), Math.max(Number(min), parsed));
  }

  function sanitizeBridgeHost(value) {
    const token = String(value || "").trim().toLowerCase();
    if (!token) return "";
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(token)) return token;
    if (/^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/i.test(token)) return token;
    return "";
  }

  function sanitizeBridgeId(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-F0-9]/g, "")
      .slice(0, 32);
  }

  function sanitizeUsername(value) {
    return String(value || "")
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 64);
  }

  function sanitizeClientKey(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-F0-9]/g, "")
      .slice(0, 128);
  }

  function sanitizeEntertainmentAreaId(value) {
    return String(value || "").trim().slice(0, 96);
  }

  function buildHueRestStatePayload(rawState = {}) {
    const source = rawState && typeof rawState === "object" ? rawState : {};
    const out = {};
    for (const [key, value] of Object.entries(source)) {
      const token = String(key || "").trim();
      if (!token || token.startsWith("__")) continue;
      out[token] = value;
    }
    return out;
  }

  function clampRgbChannel(value, fallback = 0) {
    return Math.round(clampNumber(value, 0, 255, fallback));
  }

  function convertHueXyStateToRgb(state = {}, options = {}) {
    const xy = Array.isArray(state.xy) ? state.xy : [];
    const x = clampNumber(xy[0], 0, 1, 0);
    const y = clampNumber(xy[1], 0, 1, 0);
    const opts = options && typeof options === "object" ? options : {};
    // [DEV] Entertainment frames keep RGB identity independent from brightness.
    // [DEV] We decode XY using neutral luma by default so `bri` stays intensity-only.
    const useBrightnessForLuma = opts.useBrightnessForLuma === true;
    const bri = useBrightnessForLuma
      ? clampNumber(state.bri, 1, 254, 254)
      : 254;
    if (!(y > 0.0001)) {
      const gray = clampRgbChannel((bri / 254) * 255, 0);
      return { r: gray, g: gray, b: gray };
    }
    const Y = bri / 254;
    const X = (Y / y) * x;
    const Z = (Y / y) * Math.max(0, 1 - x - y);
    let r = (X * 1.656492) - (Y * 0.354851) - (Z * 0.255038);
    let g = (-X * 0.707196) + (Y * 1.655397) + (Z * 0.036152);
    let b = (X * 0.051713) - (Y * 0.121364) + (Z * 1.01153);
    r = Math.max(0, r);
    g = Math.max(0, g);
    b = Math.max(0, b);
    const max = Math.max(r, g, b);
    if (max > 1) {
      r /= max;
      g /= max;
      b /= max;
    }
    const gamma = value => value <= 0.0031308
      ? (12.92 * value)
      : ((1 + 0.055) * Math.pow(value, 1 / 2.4) - 0.055);
    return {
      r: clampRgbChannel(gamma(r) * 255, 0),
      g: clampRgbChannel(gamma(g) * 255, 0),
      b: clampRgbChannel(gamma(b) * 255, 0)
    };
  }

  function resolveHueEntertainmentRgb(state = {}) {
    const source = state && typeof state === "object" ? state : {};
    if (source.on === false) {
      return { r: 0, g: 0, b: 0 };
    }
    const direct = source.__rgb && typeof source.__rgb === "object"
      ? source.__rgb
      : null;
    if (direct) {
      return {
        r: clampRgbChannel(direct.r, 0),
        g: clampRgbChannel(direct.g, 0),
        b: clampRgbChannel(direct.b, 0)
      };
    }
    return convertHueXyStateToRgb(source, { useBrightnessForLuma: false });
  }

  function sanitizeBridgeIdToken(value = "") {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-f0-9:-]/g, "");
  }

  function getHueFixtureCapabilities(target = {}) {
    const extras = target?.extras && typeof target.extras === "object"
      ? target.extras
      : {};
    const row = extras.hueBridgeCapabilities && typeof extras.hueBridgeCapabilities === "object"
      ? extras.hueBridgeCapabilities
      : {};
    return {
      supportsEntertainment: row.supportsEntertainment !== false,
      supportsHttps: row.supportsHttps !== false,
      forceHttp: row.forceHttp === true,
      bridgeModelId: String(row.bridgeModelId || "").trim().toUpperCase()
    };
  }

  function fixtureSupportsHueEntertainment(target = {}) {
    const capabilities = getHueFixtureCapabilities(target);
    if (capabilities.supportsEntertainment === false) return false;
    return true;
  }

  function fixtureForcesHueHttp(target = {}) {
    const capabilities = getHueFixtureCapabilities(target);
    if (capabilities.forceHttp === true) return true;
    if (capabilities.supportsHttps === false) return true;
    if (capabilities.bridgeModelId === "BSB001") return true;
    return false;
  }

  function buildHueBridgeFailureKey(bridgeIp = "", username = "") {
    const host = sanitizeBridgeHost(bridgeIp);
    const user = sanitizeUsername(username);
    if (!host || !user) return "";
    return `${host}|${user}`;
  }

  function buildHueBridgeTransportHintKey(bridgeIp = "", username = "") {
    return buildHueBridgeFailureKey(bridgeIp, username);
  }

  function buildHueBridgeCapabilityKey(bridgeIp = "", username = "") {
    return buildHueBridgeFailureKey(bridgeIp, username);
  }

  function getHueBridgeFailureRow(key = "") {
    const token = String(key || "").trim();
    if (!token) {
      return {
        failures: 0,
        cooldownUntil: 0
      };
    }
    const row = hueBridgeFailureState.get(token);
    if (row && typeof row === "object") {
      return {
        failures: Math.max(0, Math.round(Number(row.failures || 0))),
        cooldownUntil: Math.max(0, Number(row.cooldownUntil || 0)),
        lastReason: String(row.lastReason || "")
      };
    }
    return {
      failures: 0,
      cooldownUntil: 0,
      lastReason: ""
    };
  }

  function getHueBridgeTransportHint(bridgeIp = "", username = "") {
    const key = buildHueBridgeTransportHintKey(bridgeIp, username);
    if (!key) return { mode: "https", until: 0 };
    const row = hueBridgeTransportHints.get(key);
    if (!row || typeof row !== "object") {
      return { mode: "https", until: 0 };
    }
    return {
      mode: String(row.mode || "https").trim().toLowerCase() === "http" ? "http" : "https",
      until: Math.max(0, Number(row.until || 0))
    };
  }

  function setHueBridgeTransportHint(bridgeIp = "", username = "", mode = "https", ttlMs = 0) {
    const key = buildHueBridgeTransportHintKey(bridgeIp, username);
    if (!key) return;
    const normalizedMode = String(mode || "https").trim().toLowerCase() === "http" ? "http" : "https";
    const ttl = Math.max(0, Math.round(Number(ttlMs || 0)));
    if (normalizedMode !== "http" || ttl <= 0) {
      hueBridgeTransportHints.delete(key);
      return;
    }
    const at = Number(now() || Date.now());
    setBoundedMap(hueBridgeTransportHints, key, {
      mode: "http",
      until: at + ttl
    });
  }

  function shouldTreatAsTransientBridgeFailure(error) {
    const code = String(error?.code || "").trim().toUpperCase();
    const message = String(error?.message || error || "").toLowerCase();
    return code === "ECONNABORTED"
      || code === "ETIMEDOUT"
      || code === "ECONNRESET"
      || code === "EHOSTUNREACH"
      || code === "ENETUNREACH"
      || code === "ECONNREFUSED"
      || message.includes("timeout")
      || message.includes("timed out")
      || message.includes("fetch failed")
      || message.includes("aborted")
      || message.includes("stream has been aborted")
      || message.includes("socket hang up")
      || message.includes("network");
  }

  function recordHueBridgeFailure(bridgeIp = "", username = "", error = null) {
    const key = buildHueBridgeFailureKey(bridgeIp, username);
    if (!key) return;
    const at = Number(now() || Date.now());
    const prev = getHueBridgeFailureRow(key);
    const transient = shouldTreatAsTransientBridgeFailure(error);
    const nextFailures = transient ? Math.min(10, prev.failures + 1) : Math.min(10, Math.max(1, prev.failures));
    const cooldownMs = transient
      ? Math.round(clampNumber(HUE_FAILURE_COOLDOWN_BASE_MS * (2 ** (nextFailures - 1)), HUE_FAILURE_COOLDOWN_BASE_MS, HUE_FAILURE_COOLDOWN_MAX_MS, HUE_FAILURE_COOLDOWN_BASE_MS))
      : HUE_FAILURE_COOLDOWN_BASE_MS;
    setBoundedMap(hueBridgeFailureState, key, {
      failures: nextFailures,
      cooldownUntil: at + cooldownMs,
      lastReason: String(error?.message || error || "")
    });
  }

  function clearHueBridgeFailure(bridgeIp = "", username = "") {
    const key = buildHueBridgeFailureKey(bridgeIp, username);
    if (!key) return;
    hueBridgeFailureState.delete(key);
  }

  function getHueEntertainmentSuppression(bridgeIp = "", username = "") {
    const key = buildHueBridgeFailureKey(bridgeIp, username);
    const at = Number(now() || Date.now());
    if (!key) {
      return {
        active: false,
        reason: "",
        until: 0
      };
    }
    const row = hueEntertainmentSuppressionByBridge.get(key);
    if (!row || Number(row.until || 0) <= at) {
      hueEntertainmentSuppressionByBridge.delete(key);
      return {
        active: false,
        reason: "",
        until: 0
      };
    }
    return {
      active: true,
      reason: String(row.reason || ""),
      until: Number(row.until || 0)
    };
  }

  function setHueEntertainmentSuppression(bridgeIp = "", username = "", reason = "", ttlMs = HUE_ENTERTAINMENT_SUPPRESS_MS) {
    const key = buildHueBridgeFailureKey(bridgeIp, username);
    if (!key) return;
    const ttl = Math.max(1000, Math.round(Number(ttlMs || HUE_ENTERTAINMENT_SUPPRESS_MS)));
    const at = Number(now() || Date.now());
    setBoundedMap(hueEntertainmentSuppressionByBridge, key, {
      reason: String(reason || "").trim(),
      until: at + ttl
    });
  }

  function clearHueEntertainmentSuppression(bridgeIp = "", username = "") {
    const key = buildHueBridgeFailureKey(bridgeIp, username);
    if (!key) return;
    hueEntertainmentSuppressionByBridge.delete(key);
  }

  function getCachedHueBridgeCapabilities(bridgeIp = "", username = "") {
    const key = buildHueBridgeCapabilityKey(bridgeIp, username);
    if (!key) return null;
    const at = Number(now() || Date.now());
    const row = hueBridgeCapabilityCache.get(key);
    if (!row || Number(row.expiresAt || 0) <= at) {
      hueBridgeCapabilityCache.delete(key);
      return null;
    }
    return row.capabilities && typeof row.capabilities === "object"
      ? row.capabilities
      : null;
  }

  function setCachedHueBridgeCapabilities(bridgeIp = "", username = "", capabilities = null, ttlMs = HUE_BRIDGE_CAPABILITY_TTL_MS) {
    const key = buildHueBridgeCapabilityKey(bridgeIp, username);
    if (!key || !capabilities || typeof capabilities !== "object") return;
    const ttl = Math.max(5000, Math.round(Number(ttlMs || HUE_BRIDGE_CAPABILITY_TTL_MS)));
    const at = Number(now() || Date.now());
    setBoundedMap(hueBridgeCapabilityCache, key, {
      capabilities,
      expiresAt: at + ttl
    });
  }

  async function resolveRuntimeBridgeCapabilities(bridgeIp = "", username = "", fixture = {}) {
    const host = sanitizeBridgeHost(bridgeIp);
    const user = sanitizeUsername(username);
    if (!host || !user) return null;
    const fromFixture = getHueFixtureCapabilities(fixture);
    const hasExplicitFixtureCapability = fixture?.extras
      && typeof fixture.extras === "object"
      && fixture.extras.hueBridgeCapabilities
      && typeof fixture.extras.hueBridgeCapabilities === "object";
    if (hasExplicitFixtureCapability) {
      setCachedHueBridgeCapabilities(host, user, fromFixture);
      return fromFixture;
    }
    const cached = getCachedHueBridgeCapabilities(host, user);
    if (cached) return cached;
    if (!axios || typeof axios.get !== "function") return null;
    const key = buildHueBridgeCapabilityKey(host, user);
    if (!key) return null;
    if (hueBridgeCapabilityProbeByKey.has(key)) {
      return hueBridgeCapabilityProbeByKey.get(key);
    }
    const probe = (async () => {
      const bridgeConfig = await readBridgeConfig(host, user, {});
      const capabilities = inferBridgeCapabilities({
        bridgeConfig,
        clientKey: fixture?.clientKey || "",
        entertainmentAreas: []
      });
      setCachedHueBridgeCapabilities(host, user, capabilities);
      if (capabilities.forceHttp === true) {
        setHueBridgeTransportHint(host, user, "http", HUE_HTTP_FORCE_HINT_MS);
      }
      return capabilities;
    })()
      .catch(() => null)
      .finally(() => {
        hueBridgeCapabilityProbeByKey.delete(key);
      });
    setBoundedMap(hueBridgeCapabilityProbeByKey, key, probe);
    return probe;
  }

  function shouldSuppressHueEntertainmentFromError(error) {
    const message = String(error?.message || error || "").toLowerCase();
    if (!message) return false;
    return message.includes("invalid ip address")
      || message.includes("entertainment_configuration")
      || message.includes("hue_entertainment_area_unavailable")
      || message.includes("hue_entertainment_start_timeout")
      || message.includes("hue_entertainment_start_failed")
      || message.includes("hue_entertainment_socket_error")
      || message.includes("dtls handshake timed out")
      || message.includes("node-dtls-client")
      || message.includes("unable to verify")
      || message.includes("certificate")
      || message.includes("self signed")
      || message.includes("tls")
      || message.includes("socket is closed")
      || message.includes("cannot send data");
  }

  async function readBridgeConfig(bridgeHost = "", username = "", input = {}) {
    const host = sanitizeBridgeHost(bridgeHost);
    const user = sanitizeUsername(username);
    if (!host || !user || !axios || typeof axios.get !== "function") return {};
    try {
      const response = await axios.get(
        `http://${host}/api/${user}/config`,
        { timeout: clampNumber(input.timeoutMs, 200, 10000, 2200) }
      );
      return response?.data && typeof response.data === "object"
        ? response.data
        : {};
    } catch {
      return {};
    }
  }

  function inferBridgeCapabilities(input = {}) {
    const bridgeConfig = input.bridgeConfig && typeof input.bridgeConfig === "object"
      ? input.bridgeConfig
      : {};
    const clientKey = sanitizeClientKey(input.clientKey || "");
    const entertainmentAreas = Array.isArray(input.entertainmentAreas)
      ? input.entertainmentAreas
      : [];
    const bridgeModelId = String(bridgeConfig.modelid || bridgeConfig.modelId || "").trim().toUpperCase();
    // BSB001 keeps its legacy HTTP REST fallback. If the operator has explicit
    // Entertainment credentials, allow the bounded DTLS runtime to try them;
    // handshake failures are suppressed and fall back to REST.
    const isLegacyBridgeV1 = bridgeModelId === "BSB001";
    const supportsHttps = !isLegacyBridgeV1;
    const supportsEntertainment = Boolean(clientKey);
    return {
      bridgeModelId,
      bridgeSoftwareVersion: String(bridgeConfig.swversion || bridgeConfig.swVersion || "").trim(),
      apiVersion: String(bridgeConfig.apiversion || bridgeConfig.apiVersion || "").trim(),
      supportsHttps,
      supportsEntertainment,
      forceHttp: isLegacyBridgeV1,
      entertainmentAreasAvailable: entertainmentAreas.length > 0
    };
  }

  function resolveHueRestCaPath() {
    const candidates = [];
    if (process.env.RAVE_HUE_CA_CERT_PATH) {
      candidates.push(String(process.env.RAVE_HUE_CA_CERT_PATH));
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

  function ensureHueRestCaLoaded() {
    if (hueRestCaPem) return;
    const caPath = resolveHueRestCaPath();
    if (!caPath) return;
    try {
      hueRestCaPem = fs.readFileSync(caPath, "utf8");
    } catch {
      hueRestCaPem = "";
    }
  }

  function getHueRestHttpsAgent(target = {}) {
    ensureHueRestCaLoaded();
    const bridgeIp = sanitizeBridgeHost(target?.bridgeIp || "");
    const bridgeId = sanitizeBridgeIdToken(target?.bridgeId || "");
    const cacheKey = bridgeId || bridgeIp || "default";
    if (hueRestHttpsAgentByBridge.has(cacheKey)) {
      return hueRestHttpsAgentByBridge.get(cacheKey);
    }
    const options = {
      keepAlive: true,
      maxSockets: 24,
      keepAliveMsecs: 1000,
      rejectUnauthorized: true
    };
    if (hueRestCaPem) {
      options.ca = hueRestCaPem;
    }
    if (bridgeId) {
      options.servername = bridgeId;
      options.checkServerIdentity = (_host, cert) =>
        tls.checkServerIdentity(bridgeId, cert);
    }
    const agent = new https.Agent(options);
    setBoundedMap(hueRestHttpsAgentByBridge, cacheKey, agent, previous => previous?.destroy?.());
    return agent;
  }

  async function sleep(ms) {
    await new Promise(resolve => setTimeoutFn(resolve, Math.max(1, Math.round(Number(ms) || 1))));
  }

  async function discoverBridges(input = {}) {
    if (!axios || typeof axios.get !== "function") {
      const Bonjour = getBonjour();
      return Bonjour
        ? discoverBridgesMdns(input)
        : { ok: false, error: "hue_discovery_transport_unavailable", bridges: [] };
    }
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const url = String(
      source.discoveryUrl ||
      options.discoveryUrl ||
      process.env.HUE_DISCOVERY_URL ||
      "https://discovery.meethue.com/"
    ).trim();
    if (!url) {
      return {
        ok: false,
        error: "hue_discovery_url_missing",
        bridges: []
      };
    }

    try {
      const response = await axios.get(url, {
        timeout: clampNumber(source.timeoutMs, 200, 12000, 3500)
      });
      const rows = Array.isArray(response?.data) ? response.data : [];
      const bridges = rows
        .map(row => ({
          id: sanitizeBridgeId(row?.id || row?.bridgeid || row?.bridgeId),
          ip: sanitizeBridgeHost(row?.internalipaddress || row?.ip || row?.internalIpAddress)
        }))
        .filter(row => row.ip)
        .map(row => ({
          id: row.id,
          ip: row.ip,
          source: "meethue_discovery"
        }));
      const cloud = {
        ok: true,
        bridges,
        source: "meethue_discovery"
      };
      if (bridges.length || !getBonjour()) return cloud;
      return discoverBridgesMdns(source);
    } catch (error) {
      if (getBonjour()) return discoverBridgesMdns(source);
      return { ok: false, error: "hue_discovery_failed", detail: String(error?.message || error), bridges: [] };
    }
  }

  async function discoverBridgesMdns(input = {}) {
    const Bonjour = getBonjour();
    if (!Bonjour) return { ok: false, error: "hue_mdns_unavailable", bridges: [] };
    const timeoutMs = clampNumber(input.mdnsTimeoutMs, 300, 5000, 1600);
    const bridges = new Map();
    let bonjour = null;
    let browser = null;
    let timer = null;
    let settled = false;
    try {
      return await new Promise(resolve => {
        const finish = result => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeoutFn(timer);
          try { browser?.stop?.(); } catch {}
          try { bonjour?.destroy?.(); } catch {}
          resolve(result);
        };
        bonjour = new Bonjour({}, error => finish({ ok: false, error: "hue_mdns_failed", detail: String(error?.message || error), bridges: [] }));
        browser = bonjour.find({ type: "hue", protocol: "tcp" }, service => {
          const txt = service?.txt && typeof service.txt === "object" ? service.txt : {};
          const id = sanitizeBridgeId(txt.bridgeid || txt.bridgeId || txt.id || "");
          for (const address of Array.isArray(service?.addresses) ? service.addresses : []) {
            const ip = sanitizeBridgeHost(address);
            if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) bridges.set(ip, { id, ip, source: "mdns" });
          }
        });
        if (settled) return;
        timer = setTimeoutFn(() => finish({ ok: true, bridges: [...bridges.values()], source: "mdns" }), timeoutMs);
        timer?.unref?.();
      });
    } catch (error) {
      try { browser?.stop?.(); } catch {}
      try { bonjour?.destroy?.(); } catch {}
      return { ok: false, error: "hue_mdns_failed", detail: String(error?.message || error), bridges: [] };
    }
  }

  async function listEntertainmentAreas(bridgeHost = "", username = "", input = {}) {
    const host = sanitizeBridgeHost(bridgeHost);
    const user = sanitizeUsername(username);
    if (!host || !user || !axios || typeof axios.get !== "function") return [];
    try {
      const response = await axios.get(
        `http://${host}/api/${user}/groups`,
        { timeout: clampNumber(input.timeoutMs, 200, 10000, 2000) }
      );
      const groups = response?.data && typeof response.data === "object" ? response.data : {};
      const out = [];
      for (const [id, row] of Object.entries(groups)) {
        const type = String(row?.type || "").trim().toLowerCase();
        if (type !== "entertainment") continue;
        const areaId = String(id || "").trim();
        if (!areaId) continue;
        out.push({
          id: areaId,
          name: String(row?.name || areaId).trim() || areaId
        });
      }
      return out.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    } catch {
      return [];
    }
  }

  async function listLights(input = {}) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const bridgeIp = sanitizeBridgeHost(source.bridgeIp);
    const username = sanitizeUsername(source.username);
    if (!bridgeIp) {
      return {
        ok: false,
        error: "invalid_bridge_ip",
        lights: []
      };
    }
    if (!username) {
      return {
        ok: false,
        error: "missing_hue_username",
        lights: []
      };
    }
    if (!axios || typeof axios.get !== "function") {
      return {
        ok: false,
        error: "hue_lights_transport_unavailable",
        lights: []
      };
    }
    try {
      const response = await axios.get(
        `http://${bridgeIp}/api/${username}/lights`,
        { timeout: clampNumber(source.timeoutMs, 200, 10000, 2500) }
      );
      const payload = response?.data && typeof response.data === "object" ? response.data : {};
      const lights = [];
      for (const [rawId, rawLight] of Object.entries(payload)) {
        const lightId = clampNumber(Math.round(Number(rawId)), 1, 65535, NaN);
        if (!Number.isFinite(lightId)) continue;
        lights.push({
          lightId,
          name: String(rawLight?.name || `Hue light ${lightId}`).trim() || `Hue light ${lightId}`,
          modelId: String(rawLight?.modelid || "").trim().toUpperCase(),
          type: String(rawLight?.type || "").trim(),
          productName: String(rawLight?.productname || "").trim(),
          uniqueId: String(rawLight?.uniqueid || "").trim(),
          swVersion: String(rawLight?.swversion || "").trim(),
          colorTemperatureMired: {
            minimum: clampNumber(rawLight?.capabilities?.control?.ct?.min, 100, 1000, 153),
            maximum: clampNumber(rawLight?.capabilities?.control?.ct?.max, 100, 1000, 500)
          }
        });
      }
      lights.sort((a, b) => Number(a.lightId || 0) - Number(b.lightId || 0));
      return {
        ok: true,
        bridgeIp,
        lights
      };
    } catch (error) {
      return {
        ok: false,
        error: "hue_lights_query_failed",
        detail: String(error?.message || error),
        lights: []
      };
    }
  }

  function normalizeDeviceType(value) {
    const token = String(value || "ravelink#bridge").trim().toLowerCase().replace(/[^a-z0-9#_-]/g, "");
    if (!token.includes("#")) return `${token.slice(0, 19) || "ravelink"}#bridge`;
    const [appRaw, deviceRaw] = token.split("#", 2);
    const app = String(appRaw || "ravelink").slice(0, 19) || "ravelink";
    const device = String(deviceRaw || "bridge").slice(0, 19) || "bridge";
    return `${app}#${device}`;
  }

  async function pairBridge(input = {}) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const bridgeIp = sanitizeBridgeHost(source.bridgeIp);
    if (!bridgeIp) {
      return {
        ok: false,
        error: "invalid_bridge_ip"
      };
    }
    if (!axios || typeof axios.post !== "function") {
      return {
        ok: false,
        error: "hue_pair_transport_unavailable"
      };
    }
    const timeoutMs = clampNumber(source.timeoutMs, 1000, 120000, 30000);
    const pollMs = clampNumber(source.pollMs, 250, 10000, 1200);
    const deadline = Number(now() || Date.now()) + timeoutMs;
    const payload = {
      devicetype: normalizeDeviceType(source.appName || "ravelink#bridge"),
      generateclientkey: true
    };

    let lastError = "";
    while (Number(now() || Date.now()) <= deadline) {
      try {
        const response = await axios.post(
          `http://${bridgeIp}/api`,
          payload,
          { timeout: clampNumber(source.requestTimeoutMs, 250, 10000, 2500) }
        );
        const rows = Array.isArray(response?.data) ? response.data : [];
        for (const row of rows) {
          if (row?.success && typeof row.success === "object") {
            const username = sanitizeUsername(row.success.username);
            const clientKey = sanitizeClientKey(row.success.clientkey);
            if (!username) continue;
            const entertainmentAreas = await listEntertainmentAreas(bridgeIp, username, {
              timeoutMs: source.areaTimeoutMs
            });
            const bridgeConfig = await readBridgeConfig(bridgeIp, username, {
              timeoutMs: source.configTimeoutMs
            });
            const capabilities = inferBridgeCapabilities({
              bridgeConfig,
              clientKey,
              entertainmentAreas
            });
            setCachedHueBridgeCapabilities(bridgeIp, username, capabilities);
            if (capabilities.forceHttp === true) {
              setHueBridgeTransportHint(bridgeIp, username, "http", HUE_HTTP_FORCE_HINT_MS);
            }
            return {
              ok: true,
              bridge: {
                ip: bridgeIp,
                id: sanitizeBridgeId(source.bridgeId || "")
              },
              credentials: {
                username,
                clientKey
              },
              entertainmentAreas,
              capabilities
            };
          }
          if (row?.error && typeof row.error === "object") {
            const type = Number(row.error.type || 0);
            if (type === 101) {
              lastError = "link_button_required";
              continue;
            }
            return {
              ok: false,
              error: "pair_failed",
              detail: String(row.error.description || row.error.address || "bridge rejected pairing")
            };
          }
        }
      } catch (error) {
        lastError = String(error?.message || error);
      }
      await sleep(pollMs);
    }

    return {
      ok: false,
      error: "link_button_timeout",
      detail: lastError || "timed out waiting for Hue link-button confirmation"
    };
  }

  async function sendState(fixtures = [], state = {}) {
    // [DEV] Adapter boundary is intentionally narrow:
    // [DEV] domain layer composes state; adapter only performs side effects.
    const targets = Array.isArray(fixtures) ? fixtures : [];
    const restStatePayload = buildHueRestStatePayload(state);
    const command = { method: "PUT", resource: "light-state", body: restStatePayload };
    if (!targets.length) {
      transportTelemetry = {
        ...transportTelemetry,
        skipped: Number(transportTelemetry.skipped || 0),
        updatedAt: Number(now() || Date.now())
      };
      return { sent: 0, failed: 0, dryRun, command };
    }
    if (dryRun || !axios || typeof axios.put !== "function") {
      transportTelemetry = {
        ...transportTelemetry,
        sent: Number(transportTelemetry.sent || 0) + targets.length,
        lastDurationMs: 0,
        updatedAt: Number(now() || Date.now())
      };
      return { sent: targets.length, failed: 0, dryRun: true, command };
    }

    const transportDesired = normalizeTransportMode(transportMode);
    // Tunable-white commands must reach the REST state endpoint. Entertainment
    // frames carry RGB values and cannot preserve a requested Hue `ct` mode.
    const entertainmentEnabled = state?.__forceRest !== true && !Number.isFinite(Number(state?.ct)) && (transportDesired === "entertainment" || transportDesired === "auto");
    const entertainmentRgb = resolveHueEntertainmentRgb(state);
    const entertainmentReadyGroups = new Map();
    const restTargets = [];
    let entertainmentSuppressedCount = 0;

    for (const target of targets) {
      const bridgeIp = sanitizeBridgeHost(target?.bridgeIp || "");
      const username = sanitizeUsername(target?.username || "");
      const clientKey = sanitizeClientKey(target?.clientKey || "");
      const entertainmentAreaId = sanitizeEntertainmentAreaId(target?.entertainmentAreaId || "");
      const bridgeId = sanitizeBridgeId(target?.bridgeId || "");
      const runtimeCapabilities = await resolveRuntimeBridgeCapabilities(bridgeIp, username, target);
      const effectiveTarget = runtimeCapabilities
        ? {
          ...target,
          extras: {
            ...(target?.extras && typeof target.extras === "object" ? target.extras : {}),
            hueBridgeCapabilities: runtimeCapabilities
          }
        }
        : target;
      const entertainmentSuppression = getHueEntertainmentSuppression(bridgeIp, username);
      const canUseEntertainment = fixtureSupportsHueEntertainment(effectiveTarget) && entertainmentSuppression.active !== true;
      if (entertainmentEnabled && canUseEntertainment && bridgeIp && username && clientKey && entertainmentAreaId) {
        const key = `${bridgeIp}|${username}|${clientKey}|${entertainmentAreaId}|${bridgeId}`;
        if (!entertainmentReadyGroups.has(key)) {
          entertainmentReadyGroups.set(key, {
            config: {
              bridgeIp,
              username,
              clientKey,
              entertainmentAreaId,
              bridgeId
            },
            fixtures: []
          });
        }
        entertainmentReadyGroups.get(key).fixtures.push(effectiveTarget);
      } else {
        if (entertainmentSuppression.active === true) {
          entertainmentSuppressedCount += 1;
        }
        if (fixtureForcesHueHttp(effectiveTarget) && bridgeIp && username) {
          setHueBridgeTransportHint(bridgeIp, username, "http", HUE_HTTP_FORCE_HINT_MS);
        }
        restTargets.push(effectiveTarget);
      }
    }

    const startedAt = Number(now() || Date.now());
    let entertainmentSent = 0;
    let entertainmentFallbackCount = 0;
    let entertainmentAttempted = 0;
    const entertainmentStatus = hueEntertainment.getStatus();
    if (entertainmentEnabled && entertainmentReadyGroups.size > 0 && entertainmentStatus.available === true) {
      for (const group of entertainmentReadyGroups.values()) {
        entertainmentAttempted += group.fixtures.length;
        const result = await hueEntertainment.sendFrame(group.config, {
          rgb: entertainmentRgb,
          bri: clampNumber(state?.bri, 1, 254, 254),
          on: state?.on !== false,
          fixtureCount: group.fixtures.length
        });
        if (result?.ok === true) {
          clearHueEntertainmentSuppression(group.config.bridgeIp, group.config.username);
          entertainmentSent += group.fixtures.length;
        } else {
          entertainmentFallbackCount += group.fixtures.length;
          const entertainmentError = result?.error || "hue_entertainment_send_failed";
          logSendErrorThrottled(entertainmentError);
          if (shouldSuppressHueEntertainmentFromError(entertainmentError)) {
            setHueEntertainmentSuppression(group.config.bridgeIp, group.config.username, entertainmentError);
            setHueBridgeTransportHint(group.config.bridgeIp, group.config.username, "http", HUE_HTTP_HINT_MS);
            entertainmentSuppressedCount += group.fixtures.length;
          }
          restTargets.push(...group.fixtures);
        }
      }
    } else if (entertainmentReadyGroups.size > 0) {
      restTargets.push(...Array.from(entertainmentReadyGroups.values()).flatMap(row => row.fixtures));
    }

    const operations = restTargets.map(target => async () => {
      const bridgeIp = sanitizeBridgeHost(target?.bridgeIp || "");
      const username = sanitizeUsername(target?.username || "");
      const lightId = Math.round(clampNumber(target?.lightId, 1, 65535, 0));
      if (!bridgeIp || !username || lightId <= 0) {
        return {
          ok: false,
          error: "invalid_hue_target",
          detail: { bridgeIp, username, lightId }
        };
      }

      const failureKey = buildHueBridgeFailureKey(bridgeIp, username);
      if (failureKey) {
        const bridgeFailure = getHueBridgeFailureRow(failureKey);
        const at = Number(now() || Date.now());
        if (bridgeFailure.cooldownUntil > at) {
          return {
            ok: false,
            skipped: true,
            error: `bridge_temporarily_unreachable_${Math.max(1, Math.round(bridgeFailure.cooldownUntil - at))}ms`
          };
        }
      }

      const httpsAgent = getHttpsAgent(target) || getHueRestHttpsAgent(target);
      const httpsUrl = `https://${bridgeIp}/api/${username}/lights/${lightId}/state`;
      const httpUrl = `http://${bridgeIp}/api/${username}/lights/${lightId}/state`;
      const transportHint = getHueBridgeTransportHint(bridgeIp, username);
      const nowAtHintCheck = Number(now() || Date.now());
      const forceHttpTransport = fixtureForcesHueHttp(target);
      const shouldTryHttpFirst = forceHttpTransport || (transportHint.mode === "http" && transportHint.until > nowAtHintCheck);

      async function sendHttpWithTimeout(timeoutMs = HUE_REQUEST_TIMEOUT_FALLBACK_MS) {
        await axios.put(httpUrl, restStatePayload, {
          timeout: clampNumber(timeoutMs, 300, 6000, HUE_REQUEST_TIMEOUT_FALLBACK_MS)
        });
        return {
          ok: true,
          transport: "http_fallback"
        };
      }

      if (shouldTryHttpFirst) {
        try {
          const result = await sendHttpWithTimeout(HUE_REQUEST_TIMEOUT_MS);
          setHueBridgeTransportHint(bridgeIp, username, "http", HUE_HTTP_FORCE_HINT_MS);
          clearHueBridgeFailure(bridgeIp, username);
          return result;
        } catch (httpHintError) {
          // [DEV] Hint was stale; clear it and continue through normal https->http path.
          if (!forceHttpTransport) {
            setHueBridgeTransportHint(bridgeIp, username, "https", 0);
          }
        }
      }

      try {
        await axios.put(httpsUrl, restStatePayload, {
          timeout: HUE_REQUEST_TIMEOUT_MS,
          httpsAgent
        });
        setHueBridgeTransportHint(bridgeIp, username, "https", 0);
        clearHueBridgeFailure(bridgeIp, username);
        return {
          ok: true,
          transport: "https"
        };
      } catch (firstError) {
        const message = String(firstError?.message || firstError || "").toLowerCase();
        const code = String(firstError?.code || "").toUpperCase();
        const shouldFallbackHttp = message.includes("certificate")
          || message.includes("unable to verify")
          || message.includes("self signed")
          || message.includes("tls")
          || message.includes("hostname/ip")
          || message.includes("fetch failed")
          || message.includes("aborted")
          || message.includes("stream has been aborted")
          || message.includes("timeout")
          || message.includes("timed out")
          || code === "ECONNABORTED"
          || code === "ETIMEDOUT"
          || code === "ECONNRESET"
          || code === "EHOSTUNREACH";
        if (!shouldFallbackHttp) {
          recordHueBridgeFailure(bridgeIp, username, firstError);
          return {
            ok: false,
            error: firstError
          };
        }
        try {
          await sendHttpWithTimeout(HUE_REQUEST_TIMEOUT_FALLBACK_MS);
          setHueBridgeTransportHint(bridgeIp, username, "http", HUE_HTTP_FORCE_HINT_MS);
          clearHueBridgeFailure(bridgeIp, username);
          return {
            ok: true,
            transport: "http_fallback"
          };
        } catch (fallbackError) {
          recordHueBridgeFailure(bridgeIp, username, fallbackError || firstError);
          return {
            ok: false,
            error: fallbackError
          };
        }
      }
    });
    const results = await runBoundedOperations(operations);
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let httpFallbackSent = 0;
    for (const result of results) {
      const payload = result.status === "fulfilled" ? result.value : null;
      if (payload?.ok === true) {
        sent += 1;
        if (payload.transport === "http_fallback") {
          httpFallbackSent += 1;
        }
      } else if (payload?.skipped === true) {
        skipped += 1;
      } else {
        failed += 1;
        const reason = payload?.error || result.reason;
        logSendErrorThrottled(reason);
      }
    }
    const durationMs = Math.max(0, Number(now() || Date.now()) - startedAt);
    const entertainmentNow = hueEntertainment.getStatus();
    transportTelemetry = {
      ...transportTelemetry,
      sent: Number(transportTelemetry.sent || 0) + sent + entertainmentSent,
      skipped: Number(transportTelemetry.skipped || 0) + skipped,
      sendErrors: Number(transportTelemetry.sendErrors || 0) + failed,
      lastDurationMs: durationMs,
      transportFallbackReason: entertainmentFallbackCount > 0
        ? "entertainment_failed_rest_fallback"
        : (httpFallbackSent > 0 ? "rest_https_failed_http_fallback" : transportTelemetry.transportFallbackReason),
      entertainment: {
        ...transportTelemetry.entertainment,
        active: entertainmentEnabled && entertainmentStatus.available === true,
        reason: entertainmentNow.available === true
          ? (
            entertainmentSuppressedCount > 0
              ? "entertainment_temporarily_suppressed"
              : (entertainmentFallbackCount > 0
                ? "entertainment_partial_failure"
                : (entertainmentAttempted > 0 ? "entertainment_active" : "entertainment_idle"))
          )
          : (entertainmentNow.reason || "hue_sync_unavailable"),
        fixtureReadyCount: entertainmentReadyGroups.size > 0
          ? entertainmentAttempted
          : Number(transportTelemetry?.entertainment?.fixtureReadyCount || 0),
        fixtureTotalCount: targets.length,
        lastAttemptAt: Number(now() || Date.now())
      },
      updatedAt: Number(now() || Date.now())
    };
    return {
      sent: sent + entertainmentSent,
      failed,
      skipped,
      dryRun: false,
      command
    };
  }

  function normalizeTransportMode(mode) {
    const token = String(mode || "").trim().toLowerCase();
    return TRANSPORT_MODES.has(token) ? token : "auto";
  }

  function logSendErrorThrottled(reason) {
    const rawMessage = String(reason?.message || reason || "").trim() || "unknown_hue_send_error";
    const lower = rawMessage.toLowerCase();
    const logDetail = (() => {
      if (
        lower.includes("hue_entertainment_start_timeout")
        || lower.includes("dtls handshake timed out")
      ) {
        return {
          code: "hue_entertainment_start_timeout",
          message: "Entertainment fallback -> REST (DTLS start timed out)"
        };
      }
      if (
        lower.includes("socket is closed")
        || lower.includes("cannot send data")
        || lower.includes("hue_entertainment_socket_error")
      ) {
        return {
          code: "hue_entertainment_session_closed",
          message: "Entertainment fallback -> REST (session closed)"
        };
      }
      if (
        lower.includes("hue_entertainment_start_failed")
        || lower.includes("hue_entertainment_area_unavailable")
        || lower.includes("certificate")
        || lower.includes("self signed")
        || lower.includes("tls")
        || lower.includes("unable to verify")
      ) {
        return {
          code: "hue_entertainment_unavailable",
          message: "Entertainment fallback -> REST (bridge transport unavailable)"
        };
      }
      if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("econnaborted")) {
        return {
          code: "hue_request_timeout",
          message: "REST send failed (bridge timeout)"
        };
      }
      if (
        lower.includes("fetch failed")
        || lower.includes("stream has been aborted")
        || lower.includes("aborted")
        || lower.includes("econnreset")
        || lower.includes("ehostunreach")
        || lower.includes("enetunreach")
        || lower.includes("econnrefused")
        || lower.includes("socket hang up")
      ) {
        return {
          code: "hue_network_unreachable",
          message: "REST send failed (bridge unreachable)"
        };
      }
      return {
        code: rawMessage,
        message: `Send failed (${rawMessage})`
      };
    })();
    const at = Number(now() || Date.now());
    const sameMessage = logDetail.code === String(lastSendErrorLog.message || "");
    const withinWindow = (at - Number(lastSendErrorLog.at || 0)) < HUE_SEND_ERROR_LOG_WINDOW_MS;
    if (sameMessage && withinWindow) return;
    lastSendErrorLog = { message: logDetail.code, at };
    log.warn(`[HUE] ${logDetail.message}`);
  }

  function setTransportMode(mode = "auto") {
    transportMode = normalizeTransportMode(mode);
    if (transportMode === "rest") {
      Promise.resolve(hueEntertainment.stopAll("transport_mode_rest"))
        .catch(() => {
          // [DEV] best-effort cleanup only
        });
    }
    transportTelemetry = {
      ...transportTelemetry,
      transportDesired: transportMode,
      updatedAt: Number(now() || Date.now())
    };
    return getTelemetry();
  }

  function evaluateEntertainmentReadiness(fixtures = []) {
    const rows = Array.isArray(fixtures) ? fixtures : [];
    const hueRows = rows.filter(row => String(row?.brand || "").trim().toLowerCase() === "hue");
    const entertainmentCapableRows = hueRows.filter(row => fixtureSupportsHueEntertainment(row));
    const readyRows = hueRows.filter(row => {
      if (!fixtureSupportsHueEntertainment(row)) return false;
      const bridgeIp = String(row?.bridgeIp || "").trim();
      const username = String(row?.username || "").trim();
      const clientKey = String(row?.clientKey || "").trim();
      const entertainmentAreaId = String(row?.entertainmentAreaId || "").trim();
      return Boolean(bridgeIp && username && clientKey && entertainmentAreaId);
    });
    return {
      fixtureTotalCount: entertainmentCapableRows.length,
      fixtureReadyCount: readyRows.length
    };
  }

  function syncTransportForFixtures(fixtures = [], meta = {}) {
    const desiredRaw = normalizeTransportMode(meta.mode || transportMode);
    const readiness = evaluateEntertainmentReadiness(fixtures);
    const wantEntertainment = desiredRaw === "entertainment"
      || (desiredRaw === "auto" && readiness.fixtureReadyCount > 0);
    const entertainmentStatus = hueEntertainment.getStatus();

    let transportActive = "rest";
    let fallbackReason = "";
    let entertainmentActive = false;
    let entertainmentReason = "rest_mode";

    if (wantEntertainment) {
      if (readiness.fixtureReadyCount <= 0) {
        fallbackReason = "entertainment_fixture_credentials_missing";
        entertainmentReason = "missing_clientkey_or_area";
      } else if (entertainmentStatus.available !== true) {
        fallbackReason = "entertainment_runtime_unavailable";
        entertainmentReason = String(entertainmentStatus.reason || "hue_sync_unavailable");
      } else if (dryRun) {
        transportActive = "entertainment";
        entertainmentActive = true;
        entertainmentReason = "dry_run_simulated";
      } else {
        transportActive = "entertainment";
        entertainmentActive = true;
        fallbackReason = "";
        entertainmentReason = "entertainment_ready";
      }
    } else {
      entertainmentReason = desiredRaw === "rest" ? "forced_rest_mode" : "auto_rest_selected";
    }

    transportTelemetry = {
      ...transportTelemetry,
      transportDesired: desiredRaw,
      transportActive,
      transportFallbackReason: fallbackReason,
      entertainment: {
        active: entertainmentActive,
        reason: entertainmentReason,
        fixtureReadyCount: readiness.fixtureReadyCount,
        fixtureTotalCount: readiness.fixtureTotalCount,
        lastAttemptAt: Number(now() || Date.now())
      },
      updatedAt: Number(now() || Date.now())
    };
    return getTelemetry();
  }

  function getTelemetry() {
    return {
      ok: true,
      ...transportTelemetry,
      entertainmentRuntime: hueEntertainment.getStatus(),
      resources: {
        maximumEntriesPerCache: MAX_HUE_CACHE_ENTRIES,
        maximumRestConcurrency: MAX_HUE_REST_CONCURRENCY,
        cacheEntries: hueRestHttpsAgentByBridge.size + hueBridgeFailureState.size + hueBridgeTransportHints.size
          + hueEntertainmentSuppressionByBridge.size + hueBridgeCapabilityCache.size + hueBridgeCapabilityProbeByKey.size,
        cacheEvictions,
        lifecycleEvictions
      }
    };
  }

  async function reconcileFixtures(fixtures = []) {
    const rows = (Array.isArray(fixtures) ? fixtures : []).filter(row => String(row?.brand || "").toLowerCase() === "hue");
    const bridgeKeys = new Set(rows.map(row => sanitizeBridgeIdToken(row.bridgeId) || sanitizeBridgeHost(row.bridgeIp)).filter(Boolean));
    const authKeys = new Set(rows.map(row => buildHueBridgeFailureKey(row.bridgeIp, row.username)).filter(Boolean));
    let removed = 0;
    for (const [key, agent] of [...hueRestHttpsAgentByBridge.entries()]) {
      if (bridgeKeys.has(key)) continue;
      hueRestHttpsAgentByBridge.delete(key); removed += 1;
      try { agent?.destroy?.(); } catch {}
    }
    for (const map of [hueBridgeFailureState, hueBridgeTransportHints, hueEntertainmentSuppressionByBridge, hueBridgeCapabilityCache]) {
      for (const key of [...map.keys()]) if (!authKeys.has(key)) { map.delete(key); removed += 1; }
    }
    lifecycleEvictions += removed;
    await hueEntertainment.reconcileConfigs?.(rows);
    return { ok: true, removed, retainedBridges: bridgeKeys.size };
  }

  async function shutdown() {
    await hueEntertainment.stopAll("shutdown");
    for (const agent of hueRestHttpsAgentByBridge.values()) { try { agent?.destroy?.(); } catch {} }
    hueRestHttpsAgentByBridge.clear(); hueBridgeFailureState.clear(); hueBridgeTransportHints.clear();
    hueEntertainmentSuppressionByBridge.clear(); hueBridgeCapabilityCache.clear(); hueBridgeCapabilityProbeByKey.clear();
    return { ok: true };
  }

  return {
    sendState,
    discoverBridges,
    pairBridge,
    listLights,
    setTransportMode,
    syncTransportForFixtures,
    getTelemetry,
    reconcileFixtures,
    shutdown
  };
};
