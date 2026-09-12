const path = require("node:path");
const { readJsonFileWithMetadata, writeJsonFile } = require("../../../shared/fs/json-file-store");

const FEATURE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const MAX_FEATURES = 64;

module.exports = function createFeatureStateStore(options = {}) {
  const storePath = path.resolve(options.storePath || path.join(process.cwd(), "runtime", "features", "state.json"));
  const now = typeof options.now === "function" ? options.now : Date.now;
  const loaded = readJsonFileWithMetadata(storePath, { schemaVersion: 1, features: {} });
  const states = new Map();
  const source = loaded.value?.schemaVersion === 1 && loaded.value?.features && typeof loaded.value.features === "object"
    ? loaded.value.features
    : {};
  for (const [id, row] of Object.entries(source).slice(0, MAX_FEATURES)) {
    if (!FEATURE_ID_RE.test(id) || !row || typeof row !== "object" || typeof row.enabled !== "boolean") continue;
    states.set(id, { enabled: row.enabled, updatedAt: Math.max(0, Number(row.updatedAt) || 0), reason: String(row.reason || "").slice(0, 80) });
  }

  function snapshot() {
    return {
      schemaVersion: 1,
      features: Object.fromEntries([...states.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, row]) => [id, { ...row }]))
    };
  }

  function get(featureId) {
    const id = String(featureId || "");
    const row = states.get(id);
    return row ? { configured: true, ...row } : { configured: false, enabled: true, updatedAt: 0, reason: "installed-default" };
  }

  function setEnabled(featureId, enabled, reason = "operator") {
    const id = String(featureId || "");
    if (!FEATURE_ID_RE.test(id)) return { ok: false, error: "invalid_feature_id" };
    if (!states.has(id) && states.size >= MAX_FEATURES) return { ok: false, error: "feature_state_limit" };
    const next = { enabled: enabled === true, updatedAt: Number(now()), reason: String(reason || "operator").slice(0, 80) };
    const current = states.get(id);
    if (current?.enabled === next.enabled && current.reason === next.reason) return { ok: true, changed: false, featureId: id, ...current };
    states.set(id, next);
    writeJsonFile(storePath, snapshot(), { mode: 0o600 });
    return { ok: true, changed: true, featureId: id, ...next };
  }

  return Object.freeze({ get, setEnabled, snapshot, status: () => ({ pathMode: loaded.source, tracked: states.size }) });
};

module.exports.MAX_FEATURES = MAX_FEATURES;
