// [TITLE] Module: domains/fixtures/lighting-lab.service.js
// [TITLE] Purpose: bounded operator settings, manual visual timing, presets, and audit history for lighting

const { cloneJsonSafe, readJsonFileWithMetadata, writeJsonFile } = require("../../shared/fs/json-file-store");

const DEFAULT = Object.freeze({ version: 1, revision: 0, excludedFixtureIds: [], latencyOffsets: {}, brightnessLimit: 100,
  durationSeconds: 0, repeatCount: 0, cooldownSeconds: 0, restorePrevious: false, spatialDirection: "left-right",
  spatialOriginFixtureId: "", chaseGapMs: 250, chaseRoutes: [], presets: [] });
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const DIRECTIONS = new Set(["left-right", "right-left", "front-rear", "rear-front", "clockwise", "from-fixture"]);
function clamp(value, minimum, maximum, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback; }
function boundedText(value, maximum) { return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum); }

module.exports = function createLightingLabService(options = {}) {
  const storePath = String(options.storePath || "").trim(), fixtureRegistry = options.fixtureRegistry;
  if (!storePath || !fixtureRegistry) throw new Error("createLightingLabService requires storage and fixtures");
  let state = cloneJsonSafe(DEFAULT, {}), history = [], lastStates = new Map();

  function knownIds() { return new Set(fixtureRegistry.getFixtures().map(row => row.id)); }
  function normalize(raw = {}) {
    const known = knownIds();
    const excludedFixtureIds = [...new Set((Array.isArray(raw.excludedFixtureIds) ? raw.excludedFixtureIds : []).filter(id => ID_RE.test(id) && known.has(id)))].slice(0, 64);
    const latencyOffsets = Object.fromEntries(Object.entries(raw.latencyOffsets && typeof raw.latencyOffsets === "object" ? raw.latencyOffsets : {}).filter(([id]) => ID_RE.test(id) && known.has(id)).slice(0, 64).map(([id, value]) => [id, Math.round(clamp(value, -2000, 2000, 0))]));
    const presets = (Array.isArray(raw.presets) ? raw.presets : []).slice(0, 24).map((row, index) => ({
      id: ID_RE.test(String(row?.id || "")) ? String(row.id) : `preset-${index + 1}`,
      name: boundedText(row?.name, 48), command: boundedText(row?.command, 96)
    })).filter(row => row.name && row.command);
    const usedPrefixes = new Set();
    const chaseRoutes = (Array.isArray(raw.chaseRoutes) ? raw.chaseRoutes : []).slice(0, 16).map((row, index) => ({
      id: ID_RE.test(String(row?.id || "")) ? String(row.id) : `chase-route-${index + 1}`,
      name: boundedText(row?.name, 48), prefix: boundedText(row?.prefix, 32).toLowerCase(), enabled: row?.enabled !== false,
      fixtureIds: [...new Set((Array.isArray(row?.fixtureIds) ? row.fixtureIds : []).filter(id => ID_RE.test(id) && known.has(id)))].slice(0, 64)
    })).filter(row => row.name && /^[a-z][a-z0-9_-]{0,31}$/.test(row.prefix) && !usedPrefixes.has(row.prefix) && (usedPrefixes.add(row.prefix), true));
    const spatialOriginFixtureId = known.has(String(raw.spatialOriginFixtureId || "")) ? String(raw.spatialOriginFixtureId) : "";
    return { version: 1, revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
      excludedFixtureIds, latencyOffsets, brightnessLimit: Math.round(clamp(raw.brightnessLimit, 10, 100, 100)),
      durationSeconds: Math.round(clamp(raw.durationSeconds, 0, 3600, 0)), repeatCount: Math.round(clamp(raw.repeatCount, 0, 100, 0)),
      cooldownSeconds: Math.round(clamp(raw.cooldownSeconds, 0, 600, 0)), restorePrevious: raw.restorePrevious === true,
      spatialDirection: DIRECTIONS.has(raw.spatialDirection) ? raw.spatialDirection : "left-right", spatialOriginFixtureId,
      chaseGapMs: Math.round(clamp(raw.chaseGapMs, 50, 2000, 250)), chaseRoutes, presets };
  }
  const loaded = readJsonFileWithMetadata(storePath, DEFAULT); state = normalize(loaded.value);
  if (loaded.recovered) writeJsonFile(storePath, state, { mode: 0o600 });
  function snapshot() { return { ok: true, ...cloneJsonSafe(state, {}), history: cloneJsonSafe(history, []), limits: { maximumPresets: 24, maximumHistory: 100, maximumLatencyMs: 2000 } }; }
  function settings() { return cloneJsonSafe(state, {}); }
  function save(input = {}) {
    if (input.revision !== state.revision) return { ok: false, error: "lighting_lab_conflict" };
    const next = normalize({ ...input, revision: state.revision + 1 });
    try { writeJsonFile(storePath, next, { mode: 0o600 }); } catch { return { ok: false, error: "lighting_lab_write_failed" }; }
    state = next; return snapshot();
  }
  function isExcluded(id) { return state.excludedFixtureIds.includes(String(id)); }
  function latencyFor(id) { return Number(state.latencyOffsets[String(id)] || 0); }
  function rememberState(id, brand, value) { if (ID_RE.test(String(id)) && value && typeof value === "object") lastStates.set(String(id), { brand: String(brand), value: cloneJsonSafe(value, {}) }); }
  function previousState(id) { return cloneJsonSafe(lastStates.get(String(id)), null); }
  function record(entry = {}) {
    const row = { at: new Date().toISOString(), source: boundedText(entry.source || "lighting", 24), command: boundedText(entry.command, 96),
      status: boundedText(entry.status || (entry.ok === false ? "failed" : "sent"), 24), targets: [...new Set((Array.isArray(entry.targets) ? entry.targets : []).map(String).filter(ID_RE.test.bind(ID_RE)))].slice(0, 64),
      sent: Math.max(0, Number(entry.sent || 0)), failed: Math.max(0, Number(entry.failed || 0)), detail: boundedText(entry.detail, 96) };
    history = [row, ...history].slice(0, 100); return row;
  }
  function clearHistory() { history = []; return snapshot(); }
  function resolveChaseRoute(rawText) {
    const source = boundedText(rawText, 128), lower = source.toLowerCase();
    const route = state.chaseRoutes.filter(row => row.enabled).sort((a, b) => b.prefix.length - a.prefix.length)
      .find(row => (lower === row.prefix || lower.startsWith(row.prefix) && /^[ :=-]/.test(source.slice(row.prefix.length)))
        && /^chase(?:\s|$)/i.test(source.slice(row.prefix.length).replace(/^[ :=-]+/, "")));
    if (!route) return null;
    return { managed: true, prefix: route.prefix, text: source.slice(route.prefix.length).replace(/^[ :=-]+/, "").trim(),
      fixtureIds: [...route.fixtureIds], ruleIds: [`chase:${route.id}`], chaseRoute: true };
  }
  return Object.freeze({ snapshot, settings, save, isExcluded, latencyFor, rememberState, previousState, record, clearHistory, resolveChaseRoute });
};
