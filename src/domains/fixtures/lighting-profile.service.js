// [TITLE] Module: domains/fixtures/lighting-profile.service.js
// [TITLE] Purpose: persist and apply operator-defined multi-fixture lighting profiles

const {
  cloneJsonSafe,
  readJsonFileWithMetadata,
  writeJsonFile
} = require("../../shared/fs/json-file-store");

const PROFILE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_PROFILES = 32;
const MAX_ASSIGNMENTS = 256;

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function bounded(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function normalizeTarget(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const mode = source.mode === "temperature" ? "temperature" : "color";
  return {
    on: source.on !== false,
    brightness: Math.round(clamp(source.brightness, 1, 100, 100)),
    mode,
    color: /^#[0-9a-f]{6}$/i.test(String(source.color || "")) ? String(source.color).toLowerCase() : "#ffffff",
    temperatureKelvin: Math.round(clamp(source.temperatureKelvin, 2000, 9000, 3500))
  };
}

function normalizeProfile(raw = {}) {
  const id = bounded(raw.id, 64);
  if (!PROFILE_ID_RE.test(id)) return null;
  const fixtureTargets = raw.fixtureTargets && typeof raw.fixtureTargets === "object" && !Array.isArray(raw.fixtureTargets)
    ? Object.fromEntries(Object.entries(raw.fixtureTargets).slice(0, MAX_ASSIGNMENTS)
      .map(([fixtureId, target]) => [bounded(fixtureId, 64), normalizeTarget(target)])
      .filter(([fixtureId]) => PROFILE_ID_RE.test(fixtureId)))
    : {};
  return {
    id,
    name: bounded(raw.name || id, 72),
    isDefault: raw.isDefault === true,
    strategy: raw.strategy === "shared" ? "shared" : "individual",
    sharedTarget: normalizeTarget(raw.sharedTarget),
    fixtureTargets
  };
}

module.exports = function createLightingProfileService(options = {}) {
  const storePath = bounded(options.storePath, 1024);
  const fixtureRegistry = options.fixtureRegistry;
  const directiveService = options.directiveService;
  const adapters = options.adapters || {};
  const twitchLightEffects = options.twitchLightEffects;
  const lightingLab = options.lightingLab;
  if (!storePath || !fixtureRegistry || !directiveService?.parseTwitchColorDirective) {
    throw new Error("createLightingProfileService requires a store path, fixtures, and color parser");
  }

  let profiles = [];
  function persist() {
    writeJsonFile(storePath, { version: 1, profiles: cloneJsonSafe(profiles, []) }, { mode: 0o600 });
  }
  function load() {
    const loaded = readJsonFileWithMetadata(storePath, { version: 1, profiles: [] });
    profiles = (Array.isArray(loaded.value?.profiles) ? loaded.value.profiles : [])
      .map(normalizeProfile).filter(Boolean).slice(0, MAX_PROFILES);
    const defaultIndex = profiles.findIndex(row => row.isDefault);
    profiles = profiles.map((row, index) => ({ ...row, isDefault: index === defaultIndex }));
    if (loaded.recovered) persist();
  }
  load();

  function snapshot() {
    return { ok: true, version: 1, limits: { maximumProfiles: MAX_PROFILES, maximumAssignments: MAX_ASSIGNMENTS }, profiles: cloneJsonSafe(profiles, []) };
  }

  function save(raw = {}) {
    const normalized = normalizeProfile(raw);
    if (!normalized) return { ok: false, error: "invalid_lighting_profile" };
    const existingIndex = profiles.findIndex(row => row.id === normalized.id);
    if (existingIndex < 0 && profiles.length >= MAX_PROFILES) return { ok: false, error: "lighting_profile_limit_reached" };
    const knownFixtureIds = new Set(fixtureRegistry.getFixtures().map(row => row.id));
    normalized.fixtureTargets = Object.fromEntries(Object.entries(normalized.fixtureTargets).filter(([fixtureId]) => knownFixtureIds.has(fixtureId)));
    if (normalized.isDefault) profiles = profiles.map(row => ({ ...row, isDefault: false }));
    if (existingIndex >= 0) profiles[existingIndex] = normalized;
    else profiles.push(normalized);
    profiles.sort((left, right) => left.name.localeCompare(right.name));
    persist();
    return { ok: true, profile: cloneJsonSafe(normalized, {}) };
  }

  function remove(id) {
    const token = bounded(id, 64);
    const next = profiles.filter(row => row.id !== token);
    if (next.length === profiles.length) return { ok: false, error: "lighting_profile_not_found" };
    profiles = next;
    persist();
    return { ok: true, deleted: token };
  }

  function stateFor(fixture, target) {
    if (target.on === false) return fixture.brand === "hue" ? { on: false } : { on: false, dimming: target.brightness };
    if (target.mode === "temperature") {
      const hueRange = fixture.extras?.colorTemperatureMired;
      const hueMinimumKelvin = Number(hueRange?.maximum) > 0 ? Math.round(1000000 / Number(hueRange.maximum)) : 2000;
      const hueMaximumKelvin = Number(hueRange?.minimum) > 0 ? Math.round(1000000 / Number(hueRange.minimum)) : 6536;
      const kelvin = Math.round(clamp(target.temperatureKelvin,
        fixture.brand === "wiz" ? 2200 : fixture.brand === "hue" ? hueMinimumKelvin : 2000,
        fixture.brand === "wiz" ? 6500 : fixture.brand === "hue" ? hueMaximumKelvin : 9000,
        3500));
      return fixture.brand === "hue"
        ? { on: true, bri: Math.round(target.brightness * 254 / 100), ct: Math.round(clamp(1000000 / kelvin, 153, 500, 286)) }
        : { on: true, dimming: target.brightness, temp: kelvin };
    }
    const directive = directiveService.parseTwitchColorDirective(`${target.color} ${target.brightness}%`);
    if (!directive.ok) throw new Error("invalid_profile_color");
    return fixture.brand === "hue" ? directive.hueState : directive.wizState;
  }

  async function apply(id) {
    const profile = profiles.find(row => row.id === bounded(id, 64));
    if (!profile) return { ok: false, error: "lighting_profile_not_found" };
    const available = new Map(fixtureRegistry.listEngineBy("", "all").map(row => [row.id, row]));
    const entries = Object.entries(profile.fixtureTargets);
    if (!entries.length) return { ok: false, error: "lighting_profile_has_no_fixtures" };
    if (twitchLightEffects?.cancelForStaticTargets) twitchLightEffects.cancelForStaticTargets(entries.map(([fixtureId]) => fixtureId));
    else twitchLightEffects?.cancelFixtureIds?.(entries.map(([fixtureId]) => fixtureId));
    const deliveries = await Promise.all(entries.map(async ([fixtureId, individualTarget]) => {
      const fixture = available.get(fixtureId);
      if (!fixture) return { fixtureId, status: "skipped", error: "fixture_missing_disabled_or_unconfigured" };
      const target = profile.strategy === "shared" ? profile.sharedTarget : individualTarget;
      const adapter = adapters[fixture.brand];
      if (!adapter?.sendState) return { fixtureId, status: "failed", error: "fixture_brand_not_supported" };
      try {
        const state = stateFor(fixture, target);
        const result = await adapter.sendState([fixture], state);
        if (Number(result?.sent || 0) > 0) lightingLab?.rememberState?.(fixture.id, fixture.brand, state);
        return { fixtureId, status: Number(result?.sent || 0) > 0 ? "sent" : "failed", dryRun: result?.dryRun === true };
      } catch {
        return { fixtureId, status: "failed", error: "hardware_delivery_failed" };
      }
    }));
    const sent = deliveries.filter(row => row.status === "sent").length;
    const skipped = deliveries.filter(row => row.status === "skipped").length;
    const failed = deliveries.length - sent - skipped;
    return { ok: sent > 0, profileId: profile.id, sent, failed, skipped, partial: sent > 0 && failed + skipped > 0, deliveries };
  }

  async function applyDefault() {
    const profile = profiles.find(row => row.isDefault);
    return profile ? apply(profile.id) : { ok: false, error: "default_lighting_profile_not_set" };
  }

  return Object.freeze({ snapshot, save, remove, apply, applyDefault });
};
