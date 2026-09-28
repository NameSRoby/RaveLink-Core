const crypto = require("node:crypto");

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const MAX_PROFILES = 32;
const MAX_HISTORY = 48;
const MAX_ACTIVE = 2;

const BUILT_IN_PRESETS = Object.freeze([
  { id: "kelvin-white-flash", name: "White Flash", icon: "✦", description: "A clean native-white flash that works on RGB and tunable-white bulbs.", controls: ["kelvin", "brightness", "floor", "repeats"] },
  { id: "double-blink", name: "Double Blink", icon: "◉", description: "Two crisp color pulses with a clearly visible pause between them.", controls: ["primary", "brightness", "floor", "repeats"] },
  { id: "color-burst", name: "Color Burst", icon: "◆", description: "Builds from a dim primary color into a bright secondary-color finish.", controls: ["primary", "secondary", "brightness", "floor", "repeats", "smoothness"] },
  { id: "celebration-cascade", name: "Celebration Cascade", icon: "▰", description: "Runs alternating colors across fixtures in a chosen direction.", controls: ["primary", "secondary", "brightness", "repeats", "direction", "smoothness"] },
  { id: "heartbeat", name: "Heartbeat", icon: "♥", description: "A recognizable double pulse with adjustable depth and softness.", controls: ["primary", "brightness", "floor", "repeats", "smoothness"] },
  { id: "color-wave", name: "Color Wave", icon: "≈", description: "Moves a smooth two-color wave across the selected fixtures.", controls: ["primary", "secondary", "brightness", "floor", "repeats", "direction", "smoothness"] },
  { id: "rainbow-flow", name: "Rainbow Flow", icon: "◒", description: "Moves a full spectrum across fixtures instead of changing them all together.", controls: ["brightness", "floor", "repeats", "direction", "smoothness"] }
]);
const PRESET_IDS = new Set(BUILT_IN_PRESETS.map(row => row.id));

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function text(value, maximum) { return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum); }
function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}
function uniqueFixtureIds(raw) {
  return Array.isArray(raw) ? [...new Set(raw.map(value => text(value, 64)).filter(value => ID_RE.test(value)))].slice(0, 64) : [];
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = text(raw.id, 64), name = text(raw.name, 80), presetId = text(raw.presetId, 64);
  const fixtureIds = uniqueFixtureIds(raw.fixtureIds);
  if (!ID_RE.test(id) || !name || !PRESET_IDS.has(presetId) || !fixtureIds.length) return null;
  const primary = HEX_RE.test(String(raw.primary || "")) ? String(raw.primary).toLowerCase() : "#ffffff";
  const secondary = HEX_RE.test(String(raw.secondary || "")) ? String(raw.secondary).toLowerCase() : "#7c3aed";
  const triggerEnabled = raw.triggerEnabled === true;
  const triggerId = text(raw.triggerId || (raw.triggerRewardId ? `reward:${raw.triggerRewardId}` : ""), 180);
  if (triggerEnabled && !triggerId) return null;
  return {
    id, name, presetId, fixtureIds,
    primary, secondary,
    kelvin: Math.round(clamp(raw.kelvin, 2200, 6500, 4000)),
    brightness: Math.round(clamp(raw.brightness, 10, 100, 100)),
    intensityFloor: Math.round(clamp(raw.intensityFloor, 5, 90, 20)),
    repeatCount: Math.round(clamp(raw.repeatCount, 1, 8, 1)),
    direction: ["forward", "reverse", "bounce"].includes(raw.direction) ? raw.direction : "forward",
    smoothness: Math.round(clamp(raw.smoothness, 0, 100, 65)),
    durationMs: Math.round(clamp(raw.durationMs, 800, 10000, 2400)),
    restorePrevious: raw.restorePrevious !== false,
    triggerId,
    triggerLabel: text(raw.triggerLabel || raw.triggerRewardTitle, 80),
    triggerMinimum: Math.round(clamp(raw.triggerMinimum, 0, 1000000, 0)),
    triggerMaximum: Math.round(clamp(raw.triggerMaximum, 0, 1000000, 0)),
    triggerCooldownMs: Math.round(clamp(raw.triggerCooldownMs, 0, 3600000, 0)),
    triggerAggregate: raw.triggerAggregate === "stream" ? "stream" : "event",
    triggerEnabled
  };
}

function rgb(color, brightness, fixtureIds) {
  return { fixtureIds: [...fixtureIds], state: { mode: "rgb", color, brightness: Math.round(clamp(brightness, 1, 100, 100)) } };
}
function white(kelvin, brightness, fixtureIds) {
  return { fixtureIds: [...fixtureIds], state: { mode: "white", kelvin, brightness: Math.round(clamp(brightness, 1, 100, 100)) } };
}
function rgbTuple(color) { return [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)); }
function hexColor(tuple) { return `#${tuple.map(value => Math.round(clamp(value, 0, 255, 0)).toString(16).padStart(2, "0")).join("")}`; }
function mixColor(left, right, ratio) {
  const a = rgbTuple(left), b = rgbTuple(right), amount = clamp(ratio, 0, 1, 0);
  return hexColor(a.map((value, index) => value + (b[index] - value) * amount));
}
function rainbowColor(ratio) {
  const h = ((Number(ratio) % 1) + 1) % 1 * 6, sector = Math.floor(h), fraction = h - sector;
  const colors = [[255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 0, 0]];
  return hexColor(colors[sector].map((value, index) => value + (colors[sector + 1][index] - value) * fraction));
}
function directed(ids, direction, repeatIndex = 0) {
  const reverse = direction === "reverse" || (direction === "bounce" && repeatIndex % 2 === 1);
  return reverse ? [...ids].reverse() : [...ids];
}

function compileProfile(raw) {
  const profile = normalizeProfile(raw);
  if (!profile) return { ok: false, code: "animation_profile_invalid" };
  const ids = profile.fixtureIds, duration = profile.durationMs, bright = profile.brightness;
  const floor = Math.max(5, Math.round(bright * profile.intensityFloor / 100)), repeats = profile.repeatCount;
  const at = ratio => Math.round(duration * ratio);
  const transition = interval => Math.round(Math.max(0, interval * profile.smoothness / 100));
  const add = (ratio, states, interval = 0) => frames.push({ atMs: at(Math.min(0.98, ratio)), states, transitionMs: transition(interval) });
  let frames = [];
  if (profile.presetId === "kelvin-white-flash") {
    for (let pass = 0; pass < repeats; pass += 1) { const base = pass / repeats, span = 1 / repeats; add(base, [white(profile.kelvin, bright, ids)]); add(base + span * 0.48, [white(profile.kelvin, floor, ids)]); }
  } else if (profile.presetId === "double-blink") {
    for (let pass = 0; pass < repeats; pass += 1) { const base = pass / repeats, span = 1 / repeats; [0, 0.2, 0.45, 0.65].forEach((offset, index) => add(base + span * offset, [rgb(profile.primary, index % 2 ? floor : bright, ids)])); }
  } else if (profile.presetId === "color-burst") {
    for (let pass = 0; pass < repeats; pass += 1) { const base = pass / repeats, span = 1 / repeats, interval = duration * span * 0.25; add(base, [rgb(profile.primary, floor, ids)], interval); add(base + span * 0.25, [rgb(profile.primary, bright, ids)], interval); add(base + span * 0.58, [rgb(profile.secondary, bright, ids)], interval); add(base + span * 0.88, [rgb(profile.secondary, floor, ids)], interval); }
  } else if (profile.presetId === "celebration-cascade") {
    const safeRepeats = Math.min(repeats, Math.max(1, Math.floor(80 / (ids.length + 1))));
    for (let pass = 0; pass < safeRepeats; pass += 1) { const base = pass / safeRepeats, span = 1 / safeRepeats, order = directed(ids, profile.direction, pass), interval = duration * span * 0.62 / Math.max(1, order.length); order.forEach((fixtureId, index) => add(base + span * 0.62 * index / Math.max(1, order.length), [rgb(index % 2 ? profile.secondary : profile.primary, bright, [fixtureId])], interval)); add(base + span * 0.76, [rgb(pass % 2 ? profile.secondary : profile.primary, bright, ids)], interval); }
  } else if (profile.presetId === "heartbeat") {
    for (let pass = 0; pass < repeats; pass += 1) { const base = pass / repeats, span = 1 / repeats, interval = duration * span * 0.14; [[0,floor],[0.12,bright],[0.3,floor],[0.43,Math.max(floor,bright*.82)],[0.66,floor]].forEach(([offset,level])=>add(base+span*offset,[rgb(profile.primary,level,ids)],interval)); }
  } else if (profile.presetId === "color-wave" || profile.presetId === "rainbow-flow") {
    const steps = Math.min(24, Math.max(8, repeats * 8)), interval = duration / steps, buckets = Math.min(6, ids.length);
    for (let step = 0; step < steps; step += 1) {
      const states = [], order = directed(ids, profile.direction, Math.floor(step / Math.max(1, steps / repeats)));
      for (let bucket = 0; bucket < buckets; bucket += 1) {
        const fixtureIds = order.filter((_id, index) => index % buckets === bucket), phase = (step / steps * repeats + bucket / Math.max(1, buckets)) % 1;
        const color = profile.presetId === "rainbow-flow" ? rainbowColor(phase) : mixColor(profile.primary, profile.secondary, (Math.sin(phase * Math.PI * 2) + 1) / 2);
        const level = Math.round(floor + (bright - floor) * ((Math.cos(phase * Math.PI * 2) + 1) / 2));
        if (fixtureIds.length) states.push(rgb(color, level, fixtureIds));
      }
      add(step / steps, states, interval);
    }
  }
  return { ok: true, profile, durationMs: duration, frames: frames.sort((left, right) => left.atMs - right.atMs) };
}

function abortedError() { return Object.assign(new Error("animation_canceled"), { code: "animation_canceled" }); }
function waitUntil(deadline, clock, signal, setTimeoutFn = setTimeout) {
  if (signal.aborted) return Promise.reject(abortedError());
  const delay = Math.max(0, Math.round(deadline - clock()));
  if (!delay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeoutFn(done, delay); timer?.unref?.();
    function done() { signal.removeEventListener("abort", cancel); resolve(); }
    function cancel() { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(abortedError()); }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function createAnimationEngine(options = {}) {
  const apply = options.apply;
  if (typeof apply !== "function") throw new Error("animation apply boundary is required");
  const clock = typeof options.clock === "function" ? options.clock : () => performance.now();
  const wallClock = typeof options.wallClock === "function" ? options.wallClock : Date.now;
  const uuid = typeof options.uuid === "function" ? options.uuid : crypto.randomUUID;
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
  let revision = 0, profiles = [], history = [];
  let streamSession = { id: "", online: false, startedAt: 0, endedAt: 0, gifts: 0, bits: 0, follows: 0, recentEventIds: [] };
  const active = new Map();
  const triggerAcceptedAt = new Map();

  function normalizeStreamSession(raw = {}) {
    const recent = Array.isArray(raw.recentEventIds) ? [...new Set(raw.recentEventIds.map(value => text(value, 160)).filter(Boolean))].slice(-128) : [];
    return {
      id: text(raw.id, 160), online: raw.online === true,
      startedAt: Math.max(0, Math.trunc(Number(raw.startedAt) || 0)), endedAt: Math.max(0, Math.trunc(Number(raw.endedAt) || 0)),
      gifts: Math.max(0, Math.min(1000000, Math.trunc(Number(raw.gifts) || 0))),
      bits: Math.max(0, Math.min(1000000, Math.trunc(Number(raw.bits) || 0))),
      follows: Math.max(0, Math.min(1000000, Math.trunc(Number(raw.follows) || 0))), recentEventIds: recent
    };
  }
  function counterForTrigger(triggerId) {
    return { "event:channel.subscription.gift": "gifts", "event:channel.cheer": "bits", "event:channel.follow": "follows" }[triggerId] || "";
  }
  function observeTrigger(payload = {}) {
    const triggerId = text(payload.triggerId, 180), eventId = text(payload.eventId, 160);
    if (eventId && streamSession.recentEventIds.includes(eventId)) return { ok: true, duplicate: true, code: "automation_twitch_event_duplicate" };
    if (triggerId === "event:stream.online") {
      const streamId = text(payload.streamId, 160) || `stream-${wallClock()}`;
      if (streamSession.id !== streamId) streamSession = { id: streamId, online: true, startedAt: wallClock(), endedAt: 0, gifts: 0, bits: 0, follows: 0, recentEventIds: [] };
      else streamSession.online = true;
    } else if (triggerId === "event:stream.offline") {
      if (!streamSession.id) streamSession.id = "unidentified";
      streamSession.online = false; streamSession.endedAt = wallClock();
    } else {
      const counter = counterForTrigger(triggerId);
      if (counter) {
        if (!streamSession.id) streamSession = { id: "unidentified", online: true, startedAt: wallClock(), endedAt: 0, gifts: 0, bits: 0, follows: 0, recentEventIds: [] };
        const amount = triggerId === "event:channel.follow" ? 1 : Math.max(0, Math.min(1000000, Math.round(Number(payload.amount) || 0)));
        streamSession[counter] = Math.min(1000000, streamSession[counter] + amount);
      }
    }
    if (eventId) streamSession.recentEventIds = [...streamSession.recentEventIds, eventId].slice(-128);
    revision += 1; onChange("automation_trigger_observed");
    return { ok: true, duplicate: false, code: "automation_twitch_event_observed" };
  }

  function snapshot(fixtures = []) {
    return {
      ok: true, revision, builtInPresets: clone(BUILT_IN_PRESETS), profiles: clone(profiles), fixtures: clone(fixtures),
      activeRuns: [...active.values()].map(row => ({ runId: row.runId, profileId: row.profileId, profileName: row.profileName, startedAt: row.startedAt })),
      history: clone(history), streamSession: clone(streamSession), limits: { maximumProfiles: MAX_PROFILES, maximumActiveRuns: MAX_ACTIVE, maximumHistoryEntries: MAX_HISTORY }
    };
  }
  function matchTrigger(payload = {}) {
    const id = text(payload.triggerId, 180), suppliedAmount = Number(payload.amount), counter = counterForTrigger(id);
    const eventAmount = Number.isFinite(suppliedAmount) ? Math.max(0, Math.min(1000000, Math.round(suppliedAmount))) : id === "event:channel.follow" ? 1 : null;
    const assigned = profiles.filter(row => row.triggerEnabled && row.triggerId === id);
    if (!assigned.length) return { ok: true, handled: false, code: "automation_twitch_trigger_unassigned" };
    const eligible = assigned.filter(row => {
      if (!row.triggerMinimum && !row.triggerMaximum) return true;
      const amount = row.triggerAggregate === "stream" && counter ? streamSession[counter] : eventAmount;
      return amount !== null && amount >= row.triggerMinimum && (!row.triggerMaximum || amount <= row.triggerMaximum);
    }).sort((left, right) => right.triggerMinimum - left.triggerMinimum || (left.triggerMaximum || 1000001) - (right.triggerMaximum || 1000001) || left.name.localeCompare(right.name));
    if (!eligible.length) return { ok: true, handled: true, code: "automation_twitch_condition_not_met" };
    const profile = eligible[0], lastAcceptedAt = triggerAcceptedAt.get(profile.id);
    const elapsed = lastAcceptedAt === undefined ? Number.POSITIVE_INFINITY : wallClock() - lastAcceptedAt;
    if (profile.triggerCooldownMs && elapsed < profile.triggerCooldownMs) {
      return { ok: false, handled: true, code: "automation_twitch_cooldown_active", profile, retryAfterMs: profile.triggerCooldownMs - elapsed };
    }
    return { ok: true, handled: true, code: "automation_twitch_trigger_matched", profile };
  }
  function acceptTrigger(profileId) { triggerAcceptedAt.set(text(profileId, 64), wallClock()); }
  function exportSnapshot() { return { version: 1, revision, profiles: clone(profiles), history: clone(history), streamSession: clone(streamSession) }; }
  function importSnapshot(raw) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.profiles)) return { ok: false, code: "animation_snapshot_invalid" };
    const restored = raw.profiles.slice(0, MAX_PROFILES).map(normalizeProfile);
    if (restored.some(row => !row) || new Set(restored.map(row => row.id)).size !== restored.length) return { ok: false, code: "animation_snapshot_invalid" };
    profiles = restored;
    streamSession = normalizeStreamSession(raw.streamSession);
    history = (Array.isArray(raw.history) ? raw.history : []).slice(0, MAX_HISTORY).filter(row => row && typeof row === "object").map(row => ({
      runId: text(row.runId, 64), profileId: text(row.profileId, 64), profileName: text(row.profileName, 80),
      status: ["succeeded", "failed", "canceled", "simulated"].includes(row.status) ? row.status : "failed",
      startedAt: Math.max(0, Number(row.startedAt) || 0), finishedAt: Math.max(0, Number(row.finishedAt) || 0),
      completedFrames: Math.max(0, Math.min(128, Number(row.completedFrames) || 0)), error: text(row.error, 100),
      restoration: ["not_requested", "restored", "guarded", "failed", "simulated"].includes(row.restoration) ? row.restoration : "not_requested"
    })).filter(row => row.runId && row.profileId);
    revision = Math.max(0, Number(raw.revision) || 0);
    return { ok: true, code: "animation_snapshot_restored" };
  }
  function mutate(payload = {}) {
    const action = text(payload.action, 20);
    if (action === "save") {
      const profile = normalizeProfile(payload.profile);
      if (!profile) return { ok: false, code: "animation_profile_invalid", revision };
      const index = profiles.findIndex(row => row.id === profile.id);
      if (profile.triggerEnabled && profile.triggerMaximum && profile.triggerMaximum < profile.triggerMinimum) {
        return { ok: false, code: "animation_trigger_range_invalid", revision };
      }
      if (profile.triggerEnabled && profiles.some(row => row.id !== profile.id && row.triggerEnabled && row.triggerId === profile.triggerId && row.triggerAggregate === profile.triggerAggregate && row.triggerMinimum === profile.triggerMinimum && row.triggerMaximum === profile.triggerMaximum)) {
        return { ok: false, code: "animation_trigger_range_already_assigned", revision };
      }
      if (index < 0 && profiles.length >= MAX_PROFILES) return { ok: false, code: "animation_profile_limit_reached", revision };
      if (index >= 0) profiles[index] = profile; else profiles.push(profile);
      profiles.sort((left, right) => left.name.localeCompare(right.name)); revision += 1; onChange("animation_profile_saved");
      return { ok: true, code: index >= 0 ? "animation_profile_updated" : "animation_profile_created", revision, profile: clone(profile) };
    }
    if (action === "delete") {
      const profileId = text(payload.profileId, 64);
      if ([...active.values()].some(row => row.profileId === profileId)) return { ok: false, code: "animation_profile_active", revision };
      const next = profiles.filter(row => row.id !== profileId);
      if (next.length === profiles.length) return { ok: false, code: "animation_profile_not_found", revision };
      profiles = next; revision += 1; onChange("animation_profile_deleted");
      return { ok: true, code: "animation_profile_deleted", revision };
    }
    if (action === "reset_accumulators") {
      streamSession = { id: "", online: false, startedAt: 0, endedAt: 0, gifts: 0, bits: 0, follows: 0, recentEventIds: [] };
      revision += 1; onChange("automation_accumulators_reset");
      return { ok: true, code: "automation_accumulators_reset", revision };
    }
    return { ok: false, code: "animation_mutation_invalid", revision };
  }
  function record(run) { history.unshift(run); history = history.slice(0, MAX_HISTORY); revision += 1; }
  function canStart(profileId) {
    const profile = profiles.find(row => row.id === text(profileId, 64));
    if (!profile) return { ok: false, code: "animation_profile_not_found" };
    if (active.size >= MAX_ACTIVE) return { ok: false, code: "animation_busy" };
    const targets = new Set(profile.fixtureIds);
    if ([...active.values()].some(row => row.fixtureIds.some(id => targets.has(id)))) return { ok: false, code: "animation_targets_busy" };
    return { ok: true, code: "animation_ready" };
  }
  async function start(payload = {}) {
    const profile = payload.profile ? normalizeProfile(payload.profile) : profiles.find(row => row.id === text(payload.profileId, 64));
    if (!profile) return { ok: false, code: "animation_profile_not_found" };
    const compiled = compileProfile(profile);
    if (!compiled.ok) return compiled;
    if (payload.dryRun === true) return { ok: true, code: "animation_simulated", plan: compiled, run: { profileId: profile.id, status: "simulated" } };
    if (active.size >= MAX_ACTIVE) return { ok: false, code: "animation_busy" };
    const targets = new Set(profile.fixtureIds);
    if ([...active.values()].some(row => row.fixtureIds.some(id => targets.has(id)))) return { ok: false, code: "animation_targets_busy" };
    const run = { runId: uuid(), profileId: profile.id, profileName: profile.name, status: "failed", startedAt: wallClock(), finishedAt: 0,
      completedFrames: 0, error: "", restoration: profile.restorePrevious ? "failed" : "not_requested" };
    const controller = new AbortController();
    active.set(run.runId, { runId: run.runId, profileId: profile.id, profileName: profile.name, fixtureIds: [...profile.fixtureIds], startedAt: run.startedAt, controller });
    onChange("animation_started");
    let captureId = "";
    let captureUnavailable = 0;
    try {
      if (profile.restorePrevious) {
        const captured = await apply({ action: "capture", actions: [{ action: "state", fixtureIds: profile.fixtureIds }] }, { signal: controller.signal });
        if (!captured?.ok || !captured.captureId) throw new Error(captured?.error || "lighting_state_capture_failed");
        captureId = captured.captureId;
        captureUnavailable = Math.max(0, Number(captured.unavailable) || 0);
      }
      const origin = clock();
      for (const frame of compiled.frames) {
        await waitUntil(origin + frame.atMs, clock, controller.signal, options.setTimeout);
        const results = await Promise.all(frame.states.map(row => apply({ action: "state", fixtureIds: row.fixtureIds, state: row.state, transitionMs: frame.transitionMs || 0, captureId }, { signal: controller.signal })));
        const failed = results.find(result => !result || result.ok === false);
        if (failed) throw new Error(failed?.error?.code || failed?.error || "animation_frame_failed");
        run.completedFrames += 1;
      }
      await waitUntil(origin + compiled.durationMs, clock, controller.signal, options.setTimeout);
      run.status = "succeeded";
    } catch (error) {
      run.error = text(error?.code || error?.message || "animation_failed", 100);
      run.status = run.error === "animation_canceled" ? "canceled" : "failed";
    } finally {
      if (captureId) {
        try {
          const restored = await apply({ action: "restore", captureId });
          if (restored?.ok === false) throw new Error(restored.error?.code || restored.error || "lighting_restore_failed");
          run.restoration = Number(restored?.superseded || 0) > 0 || Number(restored?.unavailable || captureUnavailable) > 0 ? "guarded" : "restored";
        } catch (error) {
          run.restoration = "failed";
          if (!run.error) run.error = text(error?.code || error?.message || "lighting_restore_failed", 100);
          if (run.status === "succeeded") run.status = "failed";
        }
      }
      active.delete(run.runId); run.finishedAt = wallClock(); record(run); onChange("animation_finished");
    }
    return { ok: run.status === "succeeded", code: `animation_${run.status}`, run: clone(run) };
  }
  function cancel(payload = {}) {
    const runId = text(payload.runId, 64), profileId = text(payload.profileId, 64);
    const rows = [...active.values()].filter(row => runId ? row.runId === runId : profileId ? row.profileId === profileId : false);
    for (const row of rows) row.controller.abort();
    return { ok: rows.length > 0, code: rows.length ? "animation_cancel_requested" : "animation_run_not_found", canceled: rows.length };
  }
  function cancelAll() {
    const count = active.size;
    for (const row of active.values()) row.controller.abort();
    if (count) onChange("animation_cancel_all_requested");
    return { ok: count > 0, code: count ? "animation_cancel_all_requested" : "animation_run_not_found", canceled: count };
  }

  return Object.freeze({ acceptTrigger, cancel, cancelAll, canStart, compileProfile, exportSnapshot, importSnapshot, matchTrigger, mutate, observeTrigger, snapshot, start });
}

module.exports = { BUILT_IN_PRESETS, compileProfile, createAnimationEngine, normalizeProfile };
