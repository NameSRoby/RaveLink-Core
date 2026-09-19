// [TITLE] Module: domains/fixtures/lighting-layout.service.js
// [TITLE] Purpose: brand-neutral room geometry for spatial lighting effects

const { cloneJsonSafe, readJsonFileWithMetadata, writeJsonFile } = require("../../shared/fs/json-file-store");

const DEFAULT = Object.freeze({ version: 1, revision: 0, room: { name: "Streaming room", width: 1, depth: 1 }, placements: {} });
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
function clamp(value, minimum, maximum, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback; }
function text(value, maximum) { return String(value || "").trim().slice(0, maximum); }

module.exports = function createLightingLayoutService(options = {}) {
  const storePath = text(options.storePath, 1024), fixtureRegistry = options.fixtureRegistry;
  if (!storePath || !fixtureRegistry) throw new Error("createLightingLayoutService requires storage and fixtures");
  let state = cloneJsonSafe(DEFAULT, {});

  function normalizePlacement(raw = {}) {
    return {
      x: clamp(raw.x, 0, 1, 0.5),
      y: clamp(raw.y, 0, 1, 0.5),
      z: clamp(raw.z, 0, 1, 0.5),
      kind: raw.kind === "strip" ? "strip" : "point",
      rotation: Math.round(clamp(raw.rotation, 0, 359, 0))
    };
  }
  function normalize(raw = {}) {
    const known = new Set(fixtureRegistry.getFixtures().map(row => row.id));
    const placements = raw.placements && typeof raw.placements === "object" && !Array.isArray(raw.placements)
      ? Object.fromEntries(Object.entries(raw.placements).slice(0, 256).filter(([id]) => ID_RE.test(id) && known.has(id)).map(([id, row]) => [id, normalizePlacement(row)]))
      : {};
    return {
      version: 1,
      revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
      room: { name: text(raw.room?.name || "Streaming room", 72), width: clamp(raw.room?.width, 1, 50, 1), depth: clamp(raw.room?.depth, 1, 50, 1) },
      placements
    };
  }
  function load() {
    const loaded = readJsonFileWithMetadata(storePath, DEFAULT);
    state = normalize(loaded.value);
    if (loaded.recovered) writeJsonFile(storePath, state, { mode: 0o600 });
  }
  load();
  function snapshot() { return { ok: true, ...cloneJsonSafe(state, {}), alpha: true, limits: { maximumPlacements: 256 } }; }
  function save(input = {}) {
    if (input.revision !== state.revision) return { ok: false, error: "lighting_layout_conflict" };
    const next = normalize({ ...input, revision: state.revision + 1 });
    try { writeJsonFile(storePath, next, { mode: 0o600 }); } catch { return { ok: false, error: "lighting_layout_write_failed" }; }
    state = next; return snapshot();
  }
  function placement(id) { const row = state.placements[String(id || "")]; return row ? cloneJsonSafe(row, null) : null; }
  function spatialOffset(id, effect, fallbackIndex = 0, fallbackCount = 1, settings = {}) {
    const row = state.placements[String(id || "")];
    if (!row) return Math.max(0, fallbackIndex) / Math.max(1, fallbackCount - 1);
    if (effect === "ripple") {
      const origin = state.placements[String(settings.spatialOriginFixtureId || "")] || { x: 0.5, y: 0.5 };
      const distance = Math.hypot(row.x - origin.x, row.y - origin.y);
      return Math.min(1, distance / Math.SQRT1_2);
    }
    if (settings.spatialDirection === "right-left") return 1 - row.x;
    if (settings.spatialDirection === "front-rear") return row.y;
    if (settings.spatialDirection === "rear-front") return 1 - row.y;
    if (settings.spatialDirection === "clockwise") return (Math.atan2(row.y - 0.5, row.x - 0.5) + Math.PI) / (Math.PI * 2);
    if (settings.spatialDirection === "from-fixture") {
      const origin = state.placements[String(settings.spatialOriginFixtureId || "")] || { x: 0.5, y: 0.5 };
      return Math.min(1, Math.hypot(row.x - origin.x, row.y - origin.y) / Math.SQRT2);
    }
    return row.x;
  }
  return Object.freeze({ snapshot, save, placement, spatialOffset });
};
