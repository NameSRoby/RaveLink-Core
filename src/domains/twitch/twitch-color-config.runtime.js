// [TITLE] Module: domains/twitch/twitch-color-config.runtime.js
// [TITLE] Purpose: persist deterministic Twitch color routing and prefixes

const { parseBoolean } = require("../../shared/validation/parse-boolean");
const fs = require("node:fs");
const { readJsonFileWithMetadata, writeJsonFile } = require("../../shared/fs/json-file-store");

const TARGETS = new Set(["hue", "wiz", "govee", "both"]);
const PREFIX_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_FIXTURE_PREFIXES = 256;

module.exports = function createTwitchColorConfigRuntime(options = {}) {
  const configPath = String(options.configPath || "").trim();
  if (!configPath) throw new Error("createTwitchColorConfigRuntime requires configPath");
  const defaults = options.configDefault || { version: 1, defaultTarget: "hue", autoDefaultTarget: true, prefixes: { hue: "", wiz: "wiz" }, fixturePrefixes: {} };

  function sanitizePrefix(value, fallback = "") {
    const token = String(value || "").trim().toLowerCase();
    return token && PREFIX_RE.test(token) ? token : String(fallback || "").trim().toLowerCase();
  }
  function sanitizeTarget(value, fallback = "hue") {
    const token = String(value || "").trim().toLowerCase();
    return TARGETS.has(token) ? token : (TARGETS.has(fallback) ? fallback : "hue");
  }
  function sanitizeCommandText(value, fallback = "") {
    return String(value || fallback || "").replace(/\s+/g, " ").trim().slice(0, 96);
  }
  function sanitizeFixturePrefixes(input, reserved) {
    const out = {};
    const seen = new Set(reserved);
    for (const [fixtureId, value] of Object.entries(input && typeof input === "object" ? input : {}).sort().slice(0, MAX_FIXTURE_PREFIXES)) {
      const prefix = sanitizePrefix(value);
      const safeFixtureId = String(fixtureId || "").trim().slice(0, 64);
      if (!safeFixtureId || !prefix || seen.has(prefix)) continue;
      out[safeFixtureId] = prefix;
      seen.add(prefix);
    }
    return out;
  }
  function sanitizeConfig(input = {}) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const rawPrefixes = source.prefixes && typeof source.prefixes === "object" ? source.prefixes : {};
    const prefixes = { hue: sanitizePrefix(rawPrefixes.hue, defaults.prefixes?.hue), wiz: sanitizePrefix(rawPrefixes.wiz, defaults.prefixes?.wiz || "wiz"), govee: sanitizePrefix(rawPrefixes.govee, defaults.prefixes?.govee || "govee") };
    const seen = new Set();
    for (const brand of ["hue", "wiz", "govee"]) { if (prefixes[brand] && seen.has(prefixes[brand])) prefixes[brand] = ""; else if (prefixes[brand]) seen.add(prefixes[brand]); }
    return {
      version: 1,
      defaultTarget: sanitizeTarget(source.defaultTarget, defaults.defaultTarget || "hue"),
      autoDefaultTarget: parseBoolean(source.autoDefaultTarget, defaults.autoDefaultTarget !== false),
      prefixes,
      fixturePrefixes: sanitizeFixturePrefixes(source.fixturePrefixes, Object.values(prefixes).filter(Boolean))
    };
  }
  function write(config) {
    const safe = sanitizeConfig(config);
    writeJsonFile(configPath, safe);
    return safe;
  }
  const configExists = fs.existsSync(configPath) || fs.existsSync(`${configPath}.bak`);
  const loaded = configExists ? readJsonFileWithMetadata(configPath, defaults) : null;
  let runtime = sanitizeConfig(loaded?.value || defaults);
  if (!loaded || loaded.recovered || JSON.stringify(loaded.value) !== JSON.stringify(runtime)) writeJsonFile(configPath, runtime);
  function getSnapshot() { return { ...runtime, prefixes: { ...runtime.prefixes }, fixturePrefixes: { ...runtime.fixturePrefixes } }; }
  function patch(input = {}) {
    const hasTarget = Object.prototype.hasOwnProperty.call(input, "defaultTarget");
    runtime = write({ ...runtime, ...input, autoDefaultTarget: input.autoDefaultTarget ?? (hasTarget ? false : runtime.autoDefaultTarget), prefixes: { ...runtime.prefixes, ...(input.prefixes || {}) }, fixturePrefixes: input.fixturePrefixes || runtime.fixturePrefixes });
    return getSnapshot();
  }
  function splitPrefixedColorText(rawText, prefixes = {}, fixturePrefixes = {}) {
    const source = String(rawText || "").trim();
    const candidates = [
      ...Object.entries(fixturePrefixes).map(([fixtureId, prefix]) => ({ fixtureId, target: null, prefix: sanitizePrefix(prefix), fixture: true })),
      { target: "hue", prefix: sanitizePrefix(prefixes.hue), fixtureId: "", fixture: false },
      { target: "wiz", prefix: sanitizePrefix(prefixes.wiz), fixtureId: "", fixture: false },
      { target: "govee", prefix: sanitizePrefix(prefixes.govee), fixtureId: "", fixture: false }
    ].filter(row => row.prefix).sort((a, b) => b.prefix.length - a.prefix.length || Number(b.fixture) - Number(a.fixture));
    const lower = source.toLowerCase();
    for (const row of candidates) {
      if (lower === row.prefix || /^[ :=-]/.test(source.slice(row.prefix.length)) && lower.startsWith(row.prefix)) {
        return { target: row.target, fixtureId: row.fixtureId, prefix: row.prefix, text: source.slice(row.prefix.length).replace(/^[ :=-]+/, "").trim() };
      }
    }
    return { target: null, fixtureId: "", prefix: "", text: source };
  }
  function getCapabilities() { return { hue: true, wiz: true, govee: "alpha" }; }
  function getLoadSummary() { return { defaultTarget: runtime.defaultTarget, autoDefaultTarget: runtime.autoDefaultTarget, prefixes: { ...runtime.prefixes }, fixturePrefixCount: Object.keys(runtime.fixturePrefixes).length }; }
  return Object.freeze({ sanitizeCommandText, getSnapshot, patch, parseColorTarget: sanitizeTarget, splitPrefixedColorText, getCapabilities, getLoadSummary });
};
