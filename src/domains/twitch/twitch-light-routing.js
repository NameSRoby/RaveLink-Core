const fs = require('node:fs');
const { writeJsonFile } = require('../../shared/fs/json-file-store');
const { DEFINITIONS } = require('../colors/color-descriptors');
const DEFAULT = { version: 1, revision: 0, mode: 'assignments', parser: { allowFuzzy: true, allowDescriptors: true, defaultBrightness: 100 }, rules: [] };
const LIMITS = { rules: 32, membersPerRule: 64, bytes: 131072 };
module.exports = function createRouting({ storePath, colorLibrary }) {
  let state = structuredClone(DEFAULT), invalid = false, recovered = false;
  function validate(value) {
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !['legacy', 'assignments', 'off'].includes(value.mode)) return false;
    if (!Object.keys(value).every(key => ['version', 'revision', 'mode', 'parser', 'rules'].includes(key))) return false;
    const p = value.parser;
    if (!p || !Object.keys(p).every(key => ['allowFuzzy', 'allowDescriptors', 'defaultBrightness'].includes(key)) || typeof p.allowFuzzy !== 'boolean' || typeof p.allowDescriptors !== 'boolean' || !Number.isInteger(p.defaultBrightness) || p.defaultBrightness < 1 || p.defaultBrightness > 100) return false;
    if (!Array.isArray(value.rules) || value.rules.length > LIMITS.rules) return false;
    const ids = new Set();
    return value.rules.every(row => {
      if (!row || !Object.keys(row).every(key => ['id', 'name', 'prefix', 'enabled', 'fixtureIds'].includes(key)) || typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(row.id) || ids.has(row.id)) return false;
      ids.add(row.id);
      return typeof row.name === 'string' && row.name.trim().length > 0 && row.name.length <= 64 && !/[\x00-\x1f\x7f]/.test(row.name) && typeof row.enabled === 'boolean' && typeof row.prefix === 'string' && (row.prefix === '' || /^[a-z][a-z0-9_-]{0,31}$/.test(row.prefix)) && Array.isArray(row.fixtureIds) && row.fixtureIds.length <= LIMITS.membersPerRule && new Set(row.fixtureIds).size === row.fixtureIds.length && row.fixtureIds.every(id => typeof id === 'string' && id.trim().length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id));
    });
  }
  for (const file of [storePath, `${storePath}.bak`]) {
    if (!fs.existsSync(file)) continue;
    try {
      if (fs.statSync(file).size > LIMITS.bytes) throw new Error();
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!validate(value)) throw new Error();
      state = value; invalid = false; recovered = file !== storePath; break;
    } catch { invalid = true; }
  }
  function snapshot() { return { ok: !invalid, ...structuredClone(state), limits: LIMITS, ...(invalid ? { error: 'twitch_routing_storage_invalid' } : {}) }; }
  function save(input = {}) {
    if (invalid) return { ok: false, error: 'twitch_routing_storage_invalid' };
    if (input.revision !== state.revision) return { ok: false, error: 'twitch_routing_conflict' };
    const next = { version: 1, revision: state.revision + 1, mode: input.mode, parser: input.parser, rules: input.rules };
    if (!validate(next)) return { ok: false, error: 'invalid_twitch_routing' };
    const owned = next.rules.flatMap(row => row.fixtureIds);
    if (new Set(owned).size !== owned.length) return { ok: false, error: 'fixture_has_multiple_twitch_owners' };
    if (next.rules.filter(row => row.prefix === '').length > 1) return { ok: false, error: 'multiple_active_fixture_rules' };
    const reserved = new Set([...Object.keys(DEFINITIONS), 'random', 'rand', 'rnd', 'bright', 'dim', 'please', ...Object.keys(colorLibrary.getColorMapSnapshot())]);
    if (next.rules.some(row => row.prefix && reserved.has(row.prefix))) return { ok: false, error: 'prefix_conflicts_with_color_language' };
    if (JSON.stringify({ ...next, revision: state.revision }) === JSON.stringify(state)) return snapshot();
    if (Buffer.byteLength(JSON.stringify(next, null, 2)) + 1 > LIMITS.bytes) return { ok: false, error: 'twitch_routing_too_large' };
    try { writeJsonFile(storePath, next, { backup: !recovered }); } catch { return { ok: false, error: 'twitch_routing_write_failed' }; }
    state = structuredClone(next); recovered = false; return snapshot();
  }
  function resolve(rawText) {
    if (invalid || state.mode === 'off') return { managed: true, error: invalid ? 'twitch_routing_storage_invalid' : 'channel_point_lighting_disabled' };
    if (state.mode === 'legacy') return { managed: false };
    const source = String(rawText || '').trim(), lower = source.toLowerCase();
    const prefixes = [...new Set(state.rules.filter(row => row.enabled && row.prefix).map(row => row.prefix))].sort((a, b) => b.length - a.length);
    const prefix = prefixes.find(value => lower === value || lower.startsWith(value) && /^[ :=-]/.test(source.slice(value.length))) || '';
    const rules = state.rules.filter(row => row.enabled && row.prefix === prefix);
    const fixtureIds = [...new Set(rules.flatMap(row => row.fixtureIds))];
    return { managed: true, prefix, text: prefix ? source.slice(prefix.length).replace(/^[ :=-]+/, '').trim() : source,
      fixtureIds, ruleIds: rules.map(row => row.id), ...(fixtureIds.length ? {} : { error: 'no_twitch_assignments_matched' }) };
  }
  function resolveGroup(id) {
    if (invalid) return null;
    const rule = state.rules.find(row => row.id === String(id || ""));
    return rule ? structuredClone(rule) : null;
  }
  function resolveAll() {
    if (invalid || state.mode === 'off') return { managed: true, error: invalid ? 'twitch_routing_storage_invalid' : 'channel_point_lighting_disabled' };
    const rules = state.rules.filter(row => row.enabled);
    const fixtureIds = [...new Set(rules.flatMap(row => row.fixtureIds))];
    return { managed: true, prefix: 'all', fixtureIds, ruleIds: rules.map(row => row.id), ...(fixtureIds.length ? {} : { error: 'no_twitch_assignments_matched' }) };
  }
  return Object.freeze({ snapshot, save, resolve, resolveAll, resolveGroup, parserOptions: () => ({ ...state.parser }) });
};
