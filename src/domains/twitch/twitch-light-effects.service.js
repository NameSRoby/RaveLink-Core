// [TITLE] Module: domains/twitch/twitch-light-effects.service.js
// [TITLE] Purpose: bounded, fixture-scoped channel-point lighting effects

const fs = require("node:fs");
const { writeJsonFile } = require("../../shared/fs/json-file-store");
const { hsvToRgb255, createHueStateFromRgb, createWizStateFromRgb } = require("../colors/color-space");

const DEFAULT = Object.freeze({ version: 1, revision: 0, enabled: false, returnEffect: false, fixtureIds: [], prefixes: {} });
const EFFECTS = new Set(["cycle", "fade", "breathe", "rainbow", "wave", "sweep", "ripple", "chase"]);
const SPEEDS = Object.freeze({ fast: 1200, normal: 2400, slow: 4500 });
const SYNCHRONIZATION_LEAD_MS = 500;
const ENGINE_TICK_MS = 50;
const STREAM_CADENCE_MS = 250;
const RAINBOW = Object.freeze([0, 45, 90, 150, 210, 270, 315].map(hue => hsvToRgb255(hue, 1, 1)));

function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, Number(value))); }
function rgbFromHex(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value || ""));
  return match ? { r: parseInt(match[1].slice(0, 2), 16), g: parseInt(match[1].slice(2, 4), 16), b: parseInt(match[1].slice(4, 6), 16) } : null;
}
function mix(a, b, amount) {
  const t = clamp(amount, 0, 1);
  return { r: Math.round(a.r + ((b.r - a.r) * t)), g: Math.round(a.g + ((b.g - a.g) * t)), b: Math.round(a.b + ((b.b - a.b) * t)) };
}

module.exports = function createTwitchLightEffectsService(options = {}) {
  const { storePath, fixtureRegistry, directiveService, adapters = {} } = options;
  const lightingLayout = options.lightingLayout;
  const lightingLab = options.lightingLab;
  if (!storePath || !fixtureRegistry || !directiveService?.parseTwitchColorDirective) throw new Error("createTwitchLightEffectsService requires storage, fixtures, and directive service");
  const now = typeof options.now === "function" ? options.now : Date.now;
  const schedule = typeof options.setInterval === "function" ? options.setInterval : setInterval;
  const unschedule = typeof options.clearInterval === "function" ? options.clearInterval : clearInterval;
  let config = structuredClone(DEFAULT), invalid = false, timer = null, ticking = false, sessionSequence = 0;
  const active = new Map(), cooldownUntil = new Map(), restoreGenerations = new Map();
  const scheduleOnce = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;

  for (const file of [storePath, `${storePath}.bak`]) {
    if (!fs.existsSync(file)) continue;
    try {
      if (fs.statSync(file).size > 65536) throw new Error();
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!validConfig(value)) throw new Error();
      config = value; invalid = false; break;
    } catch { invalid = true; }
  }

  function validConfig(value) {
    return Boolean(value && value.version === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0
      && typeof value.enabled === "boolean" && (value.returnEffect === undefined || typeof value.returnEffect === "boolean") && Array.isArray(value.fixtureIds) && value.fixtureIds.length <= 64
      && new Set(value.fixtureIds).size === value.fixtureIds.length
      && value.fixtureIds.every(id => typeof id === "string" && id.trim() && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id))
      && (value.prefixes === undefined || value.prefixes && typeof value.prefixes === "object" && !Array.isArray(value.prefixes)
        && Object.entries(value.prefixes).length <= 64
        && Object.entries(value.prefixes).every(([id, prefix]) => value.fixtureIds.includes(id) && prefix !== "all" && /^[a-z][a-z0-9_-]{0,31}$/.test(prefix)))
      && Object.keys(value).every(key => ["version", "revision", "enabled", "returnEffect", "fixtureIds", "prefixes"].includes(key)));
  }
  function snapshot() {
    return { ok: !invalid, ...structuredClone(config), returnEffect: config.returnEffect === true, prefixes: structuredClone(config.prefixes || {}), activeFixtureIds: [...active.keys()].sort(), supportedCommands: [...EFFECTS, "stop"], ...(invalid ? { error: "twitch_effects_storage_invalid" } : {}) };
  }
  function save(input = {}) {
    if (invalid) return { ok: false, error: "twitch_effects_storage_invalid" };
    if (input.revision !== config.revision) return { ok: false, error: "twitch_effects_conflict" };
    const next = { version: 1, revision: config.revision + 1, enabled: input.enabled, returnEffect: input.returnEffect === true, fixtureIds: input.fixtureIds,
      prefixes: input.prefixes && typeof input.prefixes === "object" && !Array.isArray(input.prefixes) ? input.prefixes : {} };
    if (!validConfig(next)) return { ok: false, error: "invalid_twitch_effects_config" };
    if (!next.enabled) stopAll();
    try { writeJsonFile(storePath, next, { backup: true }); } catch { return { ok: false, error: "twitch_effects_write_failed" }; }
    config = structuredClone(next); return snapshot();
  }

  function parse(rawText) {
    const source = String(rawText || "").replace(/\s+/g, " ").trim();
    const requested = /^([a-z]+)(?:\s+|$)/i.exec(source)?.[1]?.toLowerCase() || "";
    const first = requested === "alternate" ? "cycle" : requested;
    if (first === "stop" && /^(?:stop|stop\s+(?:effects?|lights?))$/i.test(source)) return { matched: true, ok: true, type: "stop" };
    if (!EFFECTS.has(first)) return { matched: false };
    let remainder = source.slice(requested.length).trim(), speed = "normal";
    const speedMatch = /(?:^|\s)(fast|slow|normal)$/i.exec(remainder);
    if (speedMatch) { speed = speedMatch[1].toLowerCase(); remainder = remainder.slice(0, speedMatch.index).trim(); }
    let colors = [];
    if (first === "rainbow") {
      if (remainder) return { matched: true, ok: false, error: "rainbow_accepts_only_an_optional_speed" };
      colors = RAINBOW.map(row => ({ ...row }));
    } else {
      if (!remainder && first === "wave") colors = RAINBOW.map(row => ({ ...row }));
      else {
        const tokens = remainder.split(/\s*,\s*/).map(row => row.trim()).filter(Boolean);
        const minimum = first === "breathe" ? 1 : 2;
        if (tokens.length < minimum || tokens.length > 12 || (requested === "alternate" && tokens.length !== 2) || (first === "breathe" && tokens.length !== 1)) {
          return { matched: true, ok: false, error: requested === "alternate" ? "alternate_requires_exactly_two_colors" : first === "breathe" ? "breathe_requires_one_color" : "effect_requires_2_to_12_colors" };
        }
        for (const token of tokens) {
          const parsed = directiveService.parseTwitchColorDirective(token);
          const rgb = parsed.ok ? rgbFromHex(parsed.hex) : null;
          if (!rgb) return { matched: true, ok: false, error: `invalid_effect_color:${token}` };
          colors.push(rgb);
        }
      }
    }
    return { matched: true, ok: true, type: first, speed, durationMs: SPEEDS[speed], colors, ...(requested === "alternate" ? { compatibilityAlias: "alternate" } : {}) };
  }

  function resolve(rawText) {
    const source = String(rawText || "").replace(/\s+/g, " ").trim();
    const lower = source.toLowerCase(), prefixes = config.prefixes || {};
    if (lower === "all" || lower.startsWith("all ") || lower.startsWith("all:") || lower.startsWith("all=")) {
      const text = source.slice(3).replace(/^[ :=-]+/, "").trim();
      if (parse(text).matched) return { matched: true, prefix: "all", text, fixtureIds: [...config.fixtureIds] };
    }
    const candidates = [...new Set(Object.values(prefixes))].sort((a, b) => b.length - a.length);
    for (const prefix of candidates) {
      if (!(lower === prefix || lower.startsWith(prefix) && /^[ :=-]/.test(source.slice(prefix.length)))) continue;
      const text = source.slice(prefix.length).replace(/^[ :=-]+/, "").trim();
      if (!parse(text).matched) continue;
      return { matched: true, prefix, text, fixtureIds: config.fixtureIds.filter(id => prefixes[id] === prefix) };
    }
    if (!parse(source).matched) return { matched: false };
    return { matched: true, prefix: "", text: source, fixtureIds: [...config.fixtureIds] };
  }

  function selectedFixtures(fixtureIds) {
    const routed = new Set(Array.isArray(fixtureIds) ? fixtureIds : []);
    const allowed = new Set(config.fixtureIds);
    return fixtureRegistry.listTwitchBy().filter(row => routed.has(row.id) && allowed.has(row.id) && !lightingLab?.isExcluded?.(row.id) && ["hue", "wiz", "govee"].includes(String(row.brand).toLowerCase()));
  }
  function invalidateRestore(id) { restoreGenerations.set(String(id), Number(restoreGenerations.get(String(id)) || 0) + 1); }
  function later(id, generation, delayMs, action) {
    const timerHandle = scheduleOnce(() => { if (restoreGenerations.get(String(id)) === generation) void action(); }, Math.max(0, Math.round(delayMs)));
    timerHandle?.unref?.();
  }
  async function restore(entry, options = {}) {
    const shouldRestore = options.force === true || config.returnEffect === true || entry?.settings?.restorePrevious === true;
    if (!shouldRestore || !entry?.previousState?.value) return;
    const adapter = adapters[String(entry.fixture.brand).toLowerCase()];
    const generation = Number(restoreGenerations.get(entry.fixture.id) || 0) + 1;
    restoreGenerations.set(entry.fixture.id, generation);
    const finish = async () => { try { await adapter?.sendState?.([entry.fixture], entry.previousState.value); } catch {} };
    if (config.returnEffect !== true || options.animate === false || !entry.lastFrame) return finish();
    const offset = lightingLayout?.spatialOffset?.(entry.fixture.id, "sweep", entry.fixtureIndex, entry.fixtureCount, entry.settings)
      ?? (entry.fixtureIndex / Math.max(1, entry.fixtureCount - 1));
    later(entry.fixture.id, generation, clamp(offset, 0, 1) * 240, async () => {
      try { await dispatch(entry.fixture, { rgb: entry.lastFrame.rgb, brightness: Math.min(18, entry.lastFrame.brightness) }, 120); } catch {}
      later(entry.fixture.id, generation, 180, finish);
    });
  }
  function stopFixtures(fixtureIds, options = {}) {
    let stopped = 0;
    for (const id of fixtureIds) {
      const key = String(id), entry = active.get(key);
      if (!entry) continue;
      active.delete(key); stopped += 1;
      if (entry.settings.cooldownSeconds > 0) cooldownUntil.set(key, now() + (entry.settings.cooldownSeconds * 1000));
      if (options.restore !== false) void restore(entry, options);
      else invalidateRestore(key);
    }
    if (!active.size && timer) { unschedule(timer); timer = null; }
    return stopped;
  }
  function stopAll() { return stopFixtures([...active.keys()]); }
  function cancelForStaticTargets(fixtureIds) {
    const targets = new Set((Array.isArray(fixtureIds) ? fixtureIds : []).map(String));
    const sessions = new Set([...targets].map(id => active.get(id)?.sessionId).filter(value => value !== undefined));
    const affected = [...active.values()].filter(entry => sessions.has(entry.sessionId));
    for (const entry of affected) {
      active.delete(entry.fixture.id);
      if (targets.has(entry.fixture.id)) invalidateRestore(entry.fixture.id);
      else void restore(entry, { force: true, animate: true });
    }
    if (!active.size && timer) { unschedule(timer); timer = null; }
    return { stopped: affected.length, restoredFixtureIds: affected.filter(entry => !targets.has(entry.fixture.id) && entry.previousState?.value).map(entry => entry.fixture.id) };
  }
  function ensureTimer() {
    if (timer) return;
    timer = schedule(() => { void tick(); }, ENGINE_TICK_MS);
    timer?.unref?.();
  }

  function isSmooth(command) { return ["fade", "rainbow", "wave", "sweep", "ripple", "breathe"].includes(command.type); }
  function nextAbsoluteDeadline(entry, at, cadence) {
    const origin = entry.startedAt - entry.latencyMs;
    if (at < origin) return origin;
    return origin + ((Math.floor((at - origin) / cadence) + 1) * cadence);
  }

  function render(entry, at) {
    const { command, fixtureIndex, fixtureCount } = entry;
    const duration = command.durationMs;
    let elapsed = Math.max(0, at - entry.startedAt);
    const spatialOffset = lightingLayout?.spatialOffset?.(entry.fixture.id, command.type, fixtureIndex, fixtureCount, entry.settings)
      ?? (fixtureIndex / Math.max(1, fixtureCount - 1));
    if (["wave", "rainbow"].includes(command.type)) elapsed += duration * clamp(spatialOffset, 0, 1);
    if (command.type === "chase") {
      elapsed = Math.max(0, elapsed - (entry.settings.chaseGapMs * clamp(spatialOffset, 0, 1) * Math.max(1, fixtureCount - 1)));
    }
    if (["sweep", "ripple"].includes(command.type)) {
      const travel = (elapsed % duration) / duration, offset = clamp(spatialOffset, 0, 1);
      const rawDistance = Math.abs(travel - offset);
      const distance = command.type === "sweep" ? Math.min(rawDistance, 1 - rawDistance) : rawDistance;
      const width = command.type === "sweep" ? 0.3 : 0.22;
      const strength = Math.max(0, 1 - (distance / width));
      const colorIndex = Math.floor(elapsed / duration) % command.colors.length;
      return { rgb: command.colors[colorIndex], brightness: Math.round(Math.min(entry.settings.brightnessLimit, 8 + (92 * strength * strength))), phase: Math.floor(elapsed / 125) };
    }
    if (command.type === "breathe") {
      const phase = (elapsed % duration) / duration;
      return { rgb: command.colors[0], brightness: Math.min(entry.settings.brightnessLimit, Math.round(30 + (70 * ((1 - Math.cos(phase * Math.PI * 2)) / 2)))), phase: Math.floor(elapsed / (duration / 2)) };
    }
    const position = elapsed / duration, index = Math.floor(position) % command.colors.length;
    const next = (index + 1) % command.colors.length;
    const smooth = ["fade", "rainbow", "wave"].includes(command.type);
    return { rgb: smooth ? mix(command.colors[index], command.colors[next], position - Math.floor(position)) : command.colors[index], brightness: entry.settings.brightnessLimit, phase: smooth ? Math.floor(elapsed / 333) : Math.floor(position) };
  }
  async function dispatch(fixture, frame, transitionMs) {
    const brand = String(fixture.brand).toLowerCase();
    if (brand === "hue") {
      const state = createHueStateFromRgb(frame.rgb, { brightness: Math.round(frame.brightness * 254 / 100), transitiontime: Math.round(clamp(transitionMs / 100, 0, 30)) });
      return adapters.hue?.sendState?.([fixture], state);
    }
    const state = createWizStateFromRgb(frame.rgb, { dimming: frame.brightness });
    return adapters[brand]?.sendState?.([fixture], state);
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const at = now();
      for (const [id, entry] of active) {
        const limits = [entry.settings.durationSeconds > 0 ? entry.settings.durationSeconds * 1000 : 0,
          entry.settings.repeatCount > 0 ? entry.command.durationMs * entry.command.colors.length * entry.settings.repeatCount : 0].filter(Boolean);
        const durationMs = limits.length ? Math.min(...limits) : 0;
        if (durationMs > 0 && at >= entry.startedAt + durationMs) { stopFixtures([id]); continue; }
        const brand = String(entry.fixture.brand).toLowerCase();
        const hueEntertainmentReason = brand === "hue" ? String(adapters.hue?.getTelemetry?.()?.entertainment?.reason || "") : "";
        const hueEntertainmentStreaming = hueEntertainmentReason === "entertainment_active";
        const cadence = brand === "hue"
          ? (hueEntertainmentStreaming ? STREAM_CADENCE_MS : (["wave", "sweep", "ripple"].includes(entry.command.type) ? entry.command.durationMs / 4 : entry.command.type === "breathe" ? entry.command.durationMs / 2 : entry.command.durationMs))
          : isSmooth(entry.command) ? STREAM_CADENCE_MS : entry.command.durationMs;
        if (at < entry.nextSentAt) continue;
        const initialFrame = entry.lastSentAt < 0;
        let frame = render(entry, initialFrame ? Math.min(at, entry.startedAt) : at + entry.latencyMs);
        // REST-capable Hue bulbs perform the transition themselves. At each
        // shared boundary, send the next boundary's target while WiZ/Govee
        // interpolate against the same clock. The first frame always settles
        // every brand on the common starting color before that clock begins.
        const smooth = isSmooth(entry.command);
        if (brand === "hue" && !hueEntertainmentStreaming && smooth && !initialFrame && at >= entry.startedAt) {
          frame = render(entry, at + cadence + entry.latencyMs);
        }
        const hueSmoothStream = hueEntertainmentStreaming && ["fade", "rainbow", "wave", "sweep", "ripple", "breathe"].includes(entry.command.type);
        if (brand === "hue" && !hueSmoothStream && frame.phase === entry.lastPhase) {
          entry.nextSentAt = nextAbsoluteDeadline(entry, at, cadence);
          continue;
        }
        entry.lastSentAt = at; entry.lastPhase = frame.phase; entry.lastFrame = frame;
        // Every deadline is derived from the common start time. Never add a
        // cadence to the previous (possibly late) dispatch, because that makes
        // unlike device cadences beat against each other and periodically swap
        // which brand appears to lead.
        entry.nextSentAt = initialFrame
          ? (brand === "hue" && !hueEntertainmentStreaming && smooth
            ? entry.startedAt - entry.latencyMs
            : nextAbsoluteDeadline(entry, entry.startedAt - entry.latencyMs, cadence))
          : nextAbsoluteDeadline(entry, at, cadence);
        // Start every due adapter in this same engine turn. A slow Hue HTTP
        // response must not hold the WiZ/Govee clock; adapter failures remain
        // isolated and a later absolute deadline catches up without drift.
        void Promise.resolve(dispatch(entry.fixture, frame, smooth && !initialFrame ? cadence : 0)).catch(() => null);
      }
    } finally { ticking = false; }
  }

  async function handle(rawText, context = {}) {
    const command = parse(rawText);
    if (!command.matched) return { matched: false };
    const routedIds = Array.isArray(context.fixtureIds) ? context.fixtureIds : [];
    if (command.type === "stop") {
      const relevant = routedIds.filter(id => active.has(id));
      return { matched: true, ok: true, effect: "stop", stopped: context.preview ? relevant.length : stopFixtures(relevant), targets: relevant };
    }
    if (!command.ok) return command;
    if (!config.enabled) return { matched: true, ok: false, error: "dynamic_light_effects_disabled" };
    const settings = lightingLab?.settings?.() || { brightnessLimit: 100, durationSeconds: 0, repeatCount: 0, cooldownSeconds: 0, restorePrevious: false, spatialDirection: "left-right", spatialOriginFixtureId: "", chaseGapMs: 250 };
    const fixtures = selectedFixtures(routedIds).filter(row => Number(cooldownUntil.get(row.id) || 0) <= now()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (!fixtures.length) return { matched: true, ok: false, error: "no_effect_enabled_fixtures_matched" };
    if (context.preview) return { matched: true, ok: true, preview: true, effect: command.type, speed: command.speed, targets: fixtures.map(row => row.id), sent: 0, failed: 0 };
    const startedAt = now() + SYNCHRONIZATION_LEAD_MS, sessionId = ++sessionSequence;
    fixtures.forEach((fixture, fixtureIndex) => active.set(fixture.id, { fixture, command, fixtureIndex, fixtureCount: fixtures.length, settings,
      previousState: lightingLab?.previousState?.(fixture.id), sessionId, startedAt, latencyMs: Number(lightingLab?.latencyFor?.(fixture.id) || 0),
      lastSentAt: -Infinity, nextSentAt: -Infinity, lastPhase: -1, lastFrame: null }));
    fixtures.forEach(fixture => invalidateRestore(fixture.id));
    ensureTimer(); await tick();
    const result = { matched: true, ok: true, effect: command.type, speed: command.speed, synchronized: true, startsAt: startedAt, targets: fixtures.map(row => row.id), sent: fixtures.length, failed: 0 };
    lightingLab?.record?.({ source: "effect", command: rawText, ok: true, targets: result.targets, sent: result.sent, detail: `${command.type}:${command.speed}` });
    return result;
  }
  function cancelFixtureIds(ids) { return stopFixtures(Array.isArray(ids) ? ids : []); }
  function shutdown() { stopAll(); }

  return Object.freeze({ snapshot, save, parse, resolve, handle, cancelFixtureIds, cancelForStaticTargets, tick, shutdown });
};
