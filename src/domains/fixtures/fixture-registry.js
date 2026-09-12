// [TITLE] Module: domains/fixtures/fixture-registry.js
// [TITLE] Purpose: fixture registry persistence + mode-aware querying
// [TITLE] Functionality Index:
// [TITLE] - load and sanitize fixture/runtime route config
// [TITLE] - resolve route zones and fixture mode listings
// [TITLE] - apply transport-readiness guards by brand

const fs = require("fs");
const {
  readJsonFileWithMetadata,
  writeJsonFile,
  cloneJsonSafe
} = require("../../shared/fs/json-file-store");
const { parseBoolean } = require("../../shared/validation/parse-boolean");

const VALID_BRAND_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const VALID_FIXTURE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_FIXTURES = 256;
const MAX_EXTRAS_BYTES = 4096;
const MAX_INTENT_ROUTES = 64;
const SECRET_FIELDS = Object.freeze(["bridgeIp", "username", "bridgeId", "clientKey", "entertainmentAreaId", "ip"]);

function boundedText(value, maximum = 255) {
  return String(value || "").trim().slice(0, maximum);
}

function normalizeExtras(value) {
  const cloned = cloneJsonSafe(value && typeof value === "object" && !Array.isArray(value) ? value : {}, {});
  try { return Buffer.byteLength(JSON.stringify(cloned), "utf8") <= MAX_EXTRAS_BYTES ? cloned : {}; } catch { return {}; }
}

function normalizeIntentRoutes(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(source).slice(0, MAX_INTENT_ROUTES).map(([key, route]) => [
    boundedText(key, 64),
    boundedText(route, 64)
  ]).filter(([key]) => key));
}

function normalizeZone(value, fallback = "custom") {
  const token = String(value || "").trim().toLowerCase();
  return token || fallback;
}

function fixtureSecrets(fixture = {}) {
  return Object.fromEntries(SECRET_FIELDS.map(field => [field, boundedText(fixture[field], field === "username" || field === "clientKey" ? 256 : 255)]).filter(([, value]) => value));
}

function fixtureWithoutSecrets(fixture = {}) {
  return Object.fromEntries(Object.entries(fixture).filter(([key]) => !SECRET_FIELDS.includes(key)));
}

function parseZoneList(raw, fallbackZone) {
  const fallback = String(fallbackZone || "").trim();
  const text = String(raw || "").trim();
  if (!text) return fallback ? [fallback] : [];
  const zones = text
    .split(/[,;|]+/)
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);
  if (!zones.length && fallback) return [fallback];
  return [...new Set(zones)];
}

function fixtureMatchesZone(fixture, zoneToken) {
  const requested = String(zoneToken || "").trim().toLowerCase();
  if (!requested || requested === "*" || requested === "all") return true;
  const brand = String(fixture?.brand || "").trim().toLowerCase();
  const zone = normalizeZone(fixture?.zone, brand || "custom");
  if (requested === brand) return true;
  return zone === requested;
}

module.exports = function createFixtureRegistry(options = {}) {
  const storePath = String(options.storePath || "").trim();
  const secretVault = options.secretVault && typeof options.secretVault.getAll === "function" ? options.secretVault : null;
  const externalizeSecrets = secretVault?.getStatus?.().persistent === true;
  if (!storePath) {
    throw new Error("createFixtureRegistry requires storePath");
  }
  const seedConfig = options.seedConfig && typeof options.seedConfig === "object"
    ? options.seedConfig
    : { intentRoutes: {}, fixtures: [] };

  let runtime = {
    intentRoutes: {},
    fixtures: []
  };
  let runtimeVersion = 0;
  const changeListeners = new Set();

  function notifyChange() {
    const snapshot = cloneJsonSafe(runtime.fixtures, []);
    for (const listener of changeListeners) {
      try { listener(snapshot); } catch {}
    }
  }

  function normalizeFixture(raw = {}) {
    // [DEV] Unknown brands are intentionally rejected here so later domain
    // [DEV] logic can assume brand tokens are safe and normalized.
    const id = boundedText(raw.id, 64);
    const brand = String(raw.brand || "").trim().toLowerCase();
    if (!VALID_FIXTURE_ID_RE.test(id) || !VALID_BRAND_RE.test(brand)) return null;

    const zoneDefault = brand === "hue" ? "hue" : brand === "wiz" ? "wiz" : "custom";
    return {
      id,
      name: boundedText(raw.name || id, 96),
      brand,
      zone: boundedText(normalizeZone(raw.zone, zoneDefault), 64),
      enabled: parseBoolean(raw.enabled, true),
      engineEnabled: parseBoolean(raw.engineEnabled, true),
      twitchEnabled: parseBoolean(raw.twitchEnabled, true),
      customEnabled: parseBoolean(raw.customEnabled, false),
      bridgeIp: boundedText(raw.bridgeIp, 255),
      username: boundedText(raw.username, 256),
      lightId: Number(raw.lightId || 0),
      bridgeId: boundedText(raw.bridgeId, 128).toUpperCase(),
      clientKey: boundedText(raw.clientKey, 256).toUpperCase(),
      entertainmentAreaId: boundedText(raw.entertainmentAreaId, 128),
      ip: boundedText(raw.ip, 255),
      extras: normalizeExtras(raw.extras)
    };
  }

  function isConfigured(fixture = {}) {
    if (fixture.brand === "hue") {
      return Boolean(
        String(fixture.bridgeIp || "").trim() &&
        String(fixture.username || "").trim() &&
        Number(fixture.lightId || 0) > 0
      );
    }
    if (fixture.brand === "wiz") {
      return Boolean(String(fixture.ip || "").trim());
    }
    return true;
  }

  function load() {
    const hasFile = fs.existsSync(storePath) || fs.existsSync(`${storePath}.bak`);
    const loaded = hasFile ? readJsonFileWithMetadata(storePath, seedConfig) : null;
    const parsed = loaded ? loaded.value : cloneJsonSafe(seedConfig, { intentRoutes: {}, fixtures: [] });
    const fixturesRaw = Array.isArray(parsed.fixtures) ? parsed.fixtures : [];
    const vaulted = externalizeSecrets ? secretVault.getAll() : {};
    const hasPlainSecrets = externalizeSecrets && fixturesRaw.some(row => SECRET_FIELDS.some(field => Boolean(row?.[field])));
    const fixtures = fixturesRaw
      .map(row => normalizeFixture({ ...row, ...(vaulted[String(row?.id || "")] || {}) }))
      .filter(Boolean)
      .slice(0, MAX_FIXTURES);
    runtime = {
      intentRoutes: normalizeIntentRoutes(parsed.intentRoutes),
      fixtures
    };
    runtimeVersion += 1;
    const normalized = { intentRoutes: runtime.intentRoutes, fixtures: externalizeSecrets ? runtime.fixtures.map(fixtureWithoutSecrets) : runtime.fixtures };
    if (hasPlainSecrets) {
      const migrated = secretVault.replaceAll(Object.fromEntries(fixtures.map(row => [row.id, fixtureSecrets(row)]).filter(([, value]) => Object.keys(value).length)));
      if (migrated.ok) {
        persist({ backup: false });
        try { fs.rmSync(`${storePath}.bak`, { force: true }); } catch {}
        return;
      }
    }
    if (!loaded || loaded.recovered || JSON.stringify(parsed) !== JSON.stringify(normalized)) persist();
  }

  function persist(optionsOverride = {}) {
    writeJsonFile(storePath, {
      intentRoutes: cloneJsonSafe(runtime.intentRoutes, {}),
      fixtures: cloneJsonSafe(externalizeSecrets ? runtime.fixtures.map(fixtureWithoutSecrets) : runtime.fixtures, [])
    }, { mode: 0o600, backup: optionsOverride.backup });
  }

  function listByMode(mode = "engine", brand = "", zone = "", optionsOverride = {}) {
    // [DEV] requireConfigured defaults true to prevent dispatching to placeholder
    // [DEV] fixtures unless caller explicitly asks for raw inventory visibility.
    const modeKey = String(mode || "engine").trim().toLowerCase();
    const brandKey = String(brand || "").trim().toLowerCase();
    const zones = parseZoneList(zone, "");
    const requireConfigured = optionsOverride.requireConfigured !== false;
    const modeField = modeKey === "twitch"
      ? "twitchEnabled"
      : modeKey === "custom"
        ? "customEnabled"
        : "engineEnabled";

    let list = runtime.fixtures.filter(fixture => fixture.enabled !== false && fixture[modeField] === true);
    if (brandKey) {
      list = list.filter(fixture => fixture.brand === brandKey);
    }
    if (zones.length > 0) {
      list = list.filter(fixture => zones.some(zoneToken => fixtureMatchesZone(fixture, zoneToken)));
    }
    if (requireConfigured) {
      list = list.filter(isConfigured);
    }
    return optionsOverride?.raw === true ? list : cloneJsonSafe(list, []);
  }

  load();

  function upsertFixture(rawFixture = {}) {
    const result = upsertFixtures([rawFixture]);
    return result.ok ? { ok: true, fixture: result.fixtures[0] } : result;
  }

  function upsertFixtures(rawFixtures = []) {
    const rows = Array.isArray(rawFixtures) ? rawFixtures : [];
    if (!rows.length || rows.length > 64) return { ok: false, error: "invalid_fixture_batch" };
    const staged = new Map(runtime.fixtures.map(row => [String(row.id || ""), row]));
    const normalizedRows = [];
    for (const rawFixture of rows) {
    const source = rawFixture && typeof rawFixture === "object" && !Array.isArray(rawFixture) ? rawFixture : {};
    const id = String(source.id || "").trim();
    if (!id) {
      return {
        ok: false,
        error: "missing_fixture_id"
      };
    }
    if (!VALID_FIXTURE_ID_RE.test(id)) return { ok: false, error: "invalid_fixture_id" };
    if (source.extras !== undefined) {
      try {
        if (Buffer.byteLength(JSON.stringify(source.extras), "utf8") > MAX_EXTRAS_BYTES) {
          return { ok: false, error: "fixture_extras_too_large", maximumBytes: MAX_EXTRAS_BYTES };
        }
      } catch { return { ok: false, error: "fixture_extras_invalid" }; }
    }

    const existing = staged.get(id) || null;
    if (!existing && staged.size >= MAX_FIXTURES) {
      return { ok: false, error: "fixture_limit_reached", maximumFixtures: MAX_FIXTURES };
    }
    const normalized = normalizeFixture({
      ...(existing || {}),
      ...source,
      id
    });
    if (!normalized) {
      return {
        ok: false,
        error: "invalid_fixture_payload",
        detail: "Fixture requires valid id + brand token."
      };
    }

      staged.set(id, normalized);
      normalizedRows.push(normalized);
    }
    const nextFixtures = [...staged.values()].sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
    if (externalizeSecrets) {
      if (secretVault.getStatus?.().error) return { ok: false, error: "fixture_secret_vault_unavailable" };
      const stored = secretVault.replaceAll(Object.fromEntries(nextFixtures.map(row => [row.id, fixtureSecrets(row)]).filter(([, value]) => Object.keys(value).length)));
      if (!stored.ok) return { ok: false, error: "fixture_secret_vault_write_failed" };
    }
    runtime.fixtures = nextFixtures;
    runtimeVersion += 1;
    persist();
    notifyChange();
    return {
      ok: true,
      fixtures: cloneJsonSafe(normalizedRows, [])
    };
  }

  function deleteFixture(rawId = "") {
    const id = String(rawId || "").trim();
    if (!id) {
      return {
        ok: false,
        error: "missing_fixture_id"
      };
    }
    const before = runtime.fixtures.length;
    const nextFixtures = runtime.fixtures.filter(row => String(row.id || "") !== id);
    if (nextFixtures.length === before) {
      return {
        ok: false,
        error: "fixture_not_found",
        id
      };
    }
    if (externalizeSecrets) {
      if (secretVault.getStatus?.().error) return { ok: false, error: "fixture_secret_vault_unavailable" };
      const stored = secretVault.replaceAll(Object.fromEntries(nextFixtures.map(row => [row.id, fixtureSecrets(row)]).filter(([, value]) => Object.keys(value).length)));
      if (!stored.ok) return { ok: false, error: "fixture_secret_vault_write_failed" };
    }
    runtime.fixtures = nextFixtures;
    runtimeVersion += 1;
    persist();
    notifyChange();
    return {
      ok: true,
      deleted: id
    };
  }

  function getConnectivitySnapshot() {
    const fixtures = cloneJsonSafe(runtime.fixtures, []);
    const rows = fixtures.map(fixture => {
      const configured = isConfigured(fixture);
      return {
        id: String(fixture.id || "").trim(),
        brand: String(fixture.brand || "").trim().toLowerCase(),
        zone: normalizeZone(fixture.zone, fixture.brand || "custom"),
        enabled: fixture.enabled !== false,
        configured,
        reachable: configured ? null : false,
        status: configured ? "not_tested" : "not_configured",
        detail: configured ? "explicit hardware test required" : "missing transport credentials"
      };
    });
    const reachable = rows.filter(row => row.reachable === true).length;
    const untested = rows.filter(row => row.reachable === null).length;
    return {
      ok: true,
      total: rows.length,
      reachable,
      unreachable: rows.filter(row => row.reachable === false).length,
      untested,
      rows
    };
  }

  function testConnectivity(rawId = "", timeoutMsRaw = 1200) {
    const id = String(rawId || "").trim();
    if (!id) {
      return {
        ok: false,
        error: "missing_fixture_id"
      };
    }
    const fixture = runtime.fixtures.find(row => String(row.id || "") === id);
    if (!fixture) {
      return {
        ok: false,
        error: "fixture_not_found",
        id
      };
    }
    const configured = isConfigured(fixture);
    return {
      ok: true,
      id,
      timeoutMs: clampNumber(Math.round(Number(timeoutMsRaw)), 200, 10000, 1200),
      configured,
      reachable: configured ? null : false,
      status: configured ? "not_tested" : "not_configured",
      detail: configured
        ? "compatibility status cannot verify hardware; use the fixture test endpoint"
        : "fixture transport credentials missing"
    };
  }

  return {
    parseZoneList,
    load,
    persist,
    getIntentRoutes() {
      return cloneJsonSafe(runtime.intentRoutes, {});
    },
    getFixtures() {
      return cloneJsonSafe(runtime.fixtures, []);
    },
    getFixturesRuntimeRef() {
      return runtime.fixtures;
    },
    getRuntimeVersion() {
      return runtimeVersion;
    },
    getLimits() {
      return { maximumFixtures: MAX_FIXTURES, maximumExtrasBytes: MAX_EXTRAS_BYTES, maximumIntentRoutes: MAX_INTENT_ROUTES };
    },
    resolveZone(routeKey) {
      const key = String(routeKey || "").trim();
      return String(runtime.intentRoutes[key] || "").trim();
    },
    listByMode,
    listEngineBy(brand = "", zone = "", optionsOverride = {}) {
      return listByMode("engine", brand, zone, optionsOverride);
    },
    listTwitchBy(brand = "", zone = "", optionsOverride = {}) {
      return listByMode("twitch", brand, zone, optionsOverride);
    },
    listCustomBy(brand = "", zone = "", optionsOverride = {}) {
      return listByMode("custom", brand, zone, optionsOverride);
    },
    upsertFixture,
    upsertFixtures,
    deleteFixture,
    getConnectivitySnapshot,
    testConnectivity,
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    }
  };
};

module.exports.MAX_FIXTURES = MAX_FIXTURES;
module.exports.MAX_EXTRAS_BYTES = MAX_EXTRAS_BYTES;
module.exports.MAX_INTENT_ROUTES = MAX_INTENT_ROUTES;

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number(fallback);
  return Math.min(Number(max), Math.max(Number(min), parsed));
}
