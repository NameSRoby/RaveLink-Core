/**
 * Dynamic lighting ownership and timing.
 * New programs replace prior ownership through the serialized dispatch boundary,
 * including already-started asynchronous fixture writes. Derive frame deadlines
 * from one common start clock; accumulating intervals causes unlike brands to drift.
 * REST transition targets and streaming frames intentionally use different cadence.
 */
// [TITLE] Module: domains/twitch/twitch-light-effects.service.js
// [TITLE] Purpose: bounded, fixture-scoped channel-point lighting effects

const fs = require("node:fs");
const createLightEffectCommand = require("./light-effect-command");
const { writeJsonFile } = require("../../shared/fs/json-file-store");
const { createHueStateFromRgb, createWizStateFromRgb } = require("../colors/color-space");

const DEFAULT = Object.freeze({
  version: 1,
  revision: 0,
  enabled: false,
  returnEffect: false,
  fixtureIds: [],
  prefixes: {},
});
const ENGINE_TICK_MS = 50;
const STREAM_CADENCE_MS = 250;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value)));
}
function mix(a, b, amount) {
  const t = clamp(amount, 0, 1);
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

module.exports = function createTwitchLightEffectsService(options = {}) {
  const { storePath, fixtureRegistry, directiveService, adapters = {} } = options;
  const lightingLayout = options.lightingLayout;
  const lightingLab = options.lightingLab;
  const outputOwnership = options.outputOwnership;
  if (!storePath || !fixtureRegistry || !directiveService?.parseTwitchColorDirective)
    throw new Error(
      "createTwitchLightEffectsService requires storage, fixtures, and directive service",
    );
  const now = typeof options.now === "function" ? options.now : Date.now;
  const schedule = typeof options.setInterval === "function" ? options.setInterval : setInterval;
  const unschedule =
    typeof options.clearInterval === "function" ? options.clearInterval : clearInterval;
  let config = structuredClone(DEFAULT),
    invalid = false,
    timer = null,
    ticking = false,
    sessionSequence = 0,
    shuttingDown = false;
  let faultCount = 0,
    lastFault = null;
  let musicHandler = null,
    effectRevision = 0,
    ravePending = false;
  const isRaveActive = () => ravePending || (musicHandler?.ids() || []).length > 0;
  function isRaveStop(rawText) {
    const route = resolve(rawText);
    return parse(route.matched ? route.text : rawText).type === "stop";
  }
  const active = new Map(),
    cooldownUntil = new Map(),
    restoreGenerations = new Map(),
    restoring = new Map(),
    pendingTasks = new Set(),
    delayedTimers = new Set(),
    faultReportAfter = new Map();
  // Core uses one broker queue for frames, manual writes and returns. Retain the
  // standalone scheduler adapter for consumers that have not composed Core.
  const dispatchLatest = outputOwnership
    ? Object.assign(
        (entry, frame, transitionMs) => {
          if (!shuttingDown && active.get(entry.fixture.id) === entry) {
            const task = supervise(
              () => dispatch(entry.fixture, frame, transitionMs, entry),
              "dispatch",
              entry.fixture.id,
            );
            entry.firstDelivery ||= task;
          }
        },
        {
          afterCurrent: (_id, action) => Promise.resolve().then(action),
          // A manual write enters the broker itself; waiting here would delay
          // invalidation and let another old frame slip in before takeover.
          settled: () => Promise.resolve(),
        },
      )
    : require("./fixture-effect-dispatch")({
        isCurrent: (entry) => !shuttingDown && active.get(entry.fixture.id) === entry,
        dispatch,
        reportFault,
      });
  const scheduleOnce = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const unscheduleOnce =
    typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const shutdownWaitMs = clamp(options.shutdownWaitMs || 2000, 1, 10000);

  for (const file of [storePath, `${storePath}.bak`]) {
    if (!fs.existsSync(file)) continue;
    try {
      if (fs.statSync(file).size > 65536) throw new Error();
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!validConfig(value)) throw new Error();
      config = value;
      invalid = false;
      break;
    } catch {
      invalid = true;
    }
  }

  function validConfig(value) {
    return Boolean(
      value &&
      value.version === 1 &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0 &&
      typeof value.enabled === "boolean" &&
      (value.returnEffect === undefined || typeof value.returnEffect === "boolean") &&
      Array.isArray(value.fixtureIds) &&
      value.fixtureIds.length <= 64 &&
      new Set(value.fixtureIds).size === value.fixtureIds.length &&
      value.fixtureIds.every(
        (id) =>
          typeof id === "string" && id.trim() && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id),
      ) &&
      (value.prefixes === undefined ||
        (value.prefixes &&
          typeof value.prefixes === "object" &&
          !Array.isArray(value.prefixes) &&
          Object.entries(value.prefixes).length <= 64 &&
          Object.entries(value.prefixes).every(
            ([id, prefix]) =>
              value.fixtureIds.includes(id) &&
              prefix !== "all" &&
              /^[a-z][a-z0-9_-]{0,31}$/.test(prefix),
          ))) &&
      Object.keys(value).every((key) =>
        ["version", "revision", "enabled", "returnEffect", "fixtureIds", "prefixes"].includes(key),
      ),
    );
  }
  function snapshot() {
    return {
      ok: !invalid,
      ...structuredClone(config),
      returnEffect: config.returnEffect === true,
      prefixes: structuredClone(config.prefixes || {}),
      activeFixtureIds: [...new Set([...active.keys(), ...(musicHandler?.ids() || [])])].sort(),
      supportedCommands: [...createLightEffectCommand.supportedCommands],
      diagnostics: { faultCount, lastFault },
      ...(invalid ? { error: "twitch_effects_storage_invalid" } : {}),
    };
  }
  function save(input = {}) {
    if (invalid) return { ok: false, error: "twitch_effects_storage_invalid" };
    if (input.revision !== config.revision) return { ok: false, error: "twitch_effects_conflict" };
    const next = {
      version: 1,
      revision: config.revision + 1,
      enabled: input.enabled,
      returnEffect: input.returnEffect === true,
      fixtureIds: input.fixtureIds,
      prefixes:
        input.prefixes && typeof input.prefixes === "object" && !Array.isArray(input.prefixes)
          ? input.prefixes
          : {},
    };
    if (!validConfig(next)) return { ok: false, error: "invalid_twitch_effects_config" };
    if (!next.enabled) stopAll();
    try {
      writeJsonFile(storePath, next, { backup: true });
    } catch {
      return { ok: false, error: "twitch_effects_write_failed" };
    }
    config = structuredClone(next);
    effectRevision++;
    require("./music-light-effect-command").cancelRemoved(musicHandler, next, supervise);
    return snapshot();
  }

  const parse = createLightEffectCommand(directiveService);

  function resolve(rawText) {
    const source = String(rawText || "")
      .replace(/\s+/g, " ")
      .trim();
    const lower = source.toLowerCase(),
      prefixes = config.prefixes || {};
    if (
      lower === "all" ||
      lower.startsWith("all ") ||
      lower.startsWith("all:") ||
      lower.startsWith("all=")
    ) {
      const text = source
        .slice(3)
        .replace(/^[ :=-]+/, "")
        .trim();
      if (parse(text).matched)
        return {
          matched: true,
          prefix: "all",
          text,
          fixtureIds: [...config.fixtureIds],
        };
    }
    const candidates = [...new Set(Object.values(prefixes))].sort((a, b) => b.length - a.length);
    for (const prefix of candidates) {
      if (!(
        lower === prefix ||
        (lower.startsWith(prefix) && /^[ :=-]/.test(source.slice(prefix.length)))
      ))
        continue;
      const text = source
        .slice(prefix.length)
        .replace(/^[ :=-]+/, "")
        .trim();
      if (!parse(text).matched) continue;
      return {
        matched: true,
        prefix,
        text,
        fixtureIds: config.fixtureIds.filter((id) => prefixes[id] === prefix),
      };
    }
    if (!parse(source).matched) return { matched: false };
    return {
      matched: true,
      prefix: "",
      text: source,
      fixtureIds: [...config.fixtureIds],
    };
  }

  function selectedFixtures(fixtureIds) {
    const routed = new Set(Array.isArray(fixtureIds) ? fixtureIds : []);
    const allowed = new Set(config.fixtureIds);
    return fixtureRegistry
      .listTwitchBy()
      .filter(
        (row) =>
          routed.has(row.id) &&
          allowed.has(row.id) &&
          !lightingLab?.isExcluded?.(row.id) &&
          ["hue", "wiz", "govee"].includes(String(row.brand).toLowerCase()),
      );
  }
  function invalidateRestore(id) {
    restoring.delete(String(id));
    restoreGenerations.set(String(id), Number(restoreGenerations.get(String(id)) || 0) + 1);
  }
  function reportFault(error, stage, fixtureId = "") {
    faultCount += 1;
    lastFault = {
      stage,
      fixtureId: String(fixtureId || ""),
      code: String(error?.code || error?.name || "effect_operation_failed"),
      at: now(),
    };
    const reportKey = `${stage}:${lastFault.fixtureId}`,
      reportAt = Number(faultReportAfter.get(reportKey) || 0);
    if (lastFault.at >= reportAt) {
      if (!faultReportAfter.has(reportKey) && faultReportAfter.size >= 256)
        faultReportAfter.delete(faultReportAfter.keys().next().value);
      faultReportAfter.set(reportKey, lastFault.at + 5000);
      try {
        lightingLab?.record?.({
          source: "effect",
          command: stage,
          ok: false,
          targets: fixtureId ? [String(fixtureId)] : [],
          sent: 0,
          detail: lastFault.code,
        });
      } catch {}
    }
  }
  function supervise(action, stage, fixtureId = "", track = true) {
    let task;
    try {
      task = Promise.resolve(action());
    } catch (error) {
      reportFault(error, stage, fixtureId);
      return Promise.resolve();
    }
    if (track) pendingTasks.add(task);
    task.then(
      () => {
        if (track) pendingTasks.delete(task);
      },
      (error) => {
        if (track) pendingTasks.delete(task);
        reportFault(error, stage, fixtureId);
      },
    );
    return task;
  }
  function later(id, generation, delayMs, action) {
    if (shuttingDown) return;
    let timerHandle = null,
      fired = false;
    timerHandle = scheduleOnce(
      () => {
        fired = true;
        if (timerHandle !== null) delayedTimers.delete(timerHandle);
        if (!shuttingDown && restoreGenerations.get(String(id)) === generation)
          supervise(action, "delayed_restore", id);
      },
      Math.max(0, Math.round(delayMs)),
    );
    if (!fired) delayedTimers.add(timerHandle);
    timerHandle?.unref?.();
  }
  const entertainment = require("./effect-entertainment")({ adapter: adapters.hue, active });
  const releaseEntertainment = entertainment.release;
  const restoreEntry = require("./effect-restoration")({
    outputOwnership,
    adapters,
    lightingLayout,
    active,
    restoring,
    restoreGenerations,
    later,
    dispatch,
    dispatchLatest,
    returnEffect: () => config.returnEffect === true,
  });

  const restore = (entry, options) => entertainment.restore(entry, options, restoreEntry);

  function stopFixtures(fixtureIds, options = {}) {
    let stopped = 0;
    for (const id of fixtureIds) {
      const key = String(id),
        entry = active.get(key);
      if (!entry) continue;
      active.delete(key);
      stopped += 1;
      if (entry.settings.cooldownSeconds > 0)
        cooldownUntil.set(key, now() + entry.settings.cooldownSeconds * 1000);
      if (outputOwnership || (options.restore !== false && !shuttingDown))
        supervise(() => restore(entry, options), "restore", key);
      else invalidateRestore(key);
    }
    if (!active.size && timer) {
      unschedule(timer);
      timer = null;
    }
    return stopped;
  }
  function stopAll() {
    return stopFixtures([...active.keys()]);
  }
  function cancelForStaticTargets(fixtureIds) {
    const targets = new Set((Array.isArray(fixtureIds) ? fixtureIds : []).map(String));
    // The effect may already have expired while its animated return is pending.
    // Static writes own their targets even when no active entry remains.
    for (const id of targets) invalidateRestore(id);
    const sessions = new Set(
      [...targets].map((id) => active.get(id)?.sessionId).filter((value) => value !== undefined),
    );
    const affected = [...active.values()].filter((entry) => sessions.has(entry.sessionId));
    for (const entry of affected) {
      active.delete(entry.fixture.id);
      if (targets.has(entry.fixture.id)) {
        invalidateRestore(entry.fixture.id);
        if (outputOwnership)
          supervise(
            () => restore(entry, { restore: false, animate: false }),
            "static_override_release",
            entry.fixture.id,
          );
      } else if (!shuttingDown)
        supervise(
          () => restore(entry, { force: true, animate: true }),
          "static_override_restore",
          entry.fixture.id,
        );
    }
    if (!active.size && timer) {
      unschedule(timer);
      timer = null;
    }
    return {
      stopped: affected.length,
      restoredFixtureIds: affected
        .filter((entry) => !targets.has(entry.fixture.id) && entry.previousState?.value)
        .map((entry) => entry.fixture.id),
    };
  }
  function ensureTimer() {
    if (timer) return;
    timer = schedule(() => {
      supervise(() => tick(), "engine_tick");
    }, ENGINE_TICK_MS);
    timer?.unref?.();
  }

  function isSmooth(command) {
    return ["fade", "rainbow", "wave", "sweep", "ripple", "breathe"].includes(command.type);
  }
  const nextAbsoluteDeadline = require("./fixture-effect-dispatch").nextDeadline;

  function render(entry, at) {
    const { command, fixtureIndex, fixtureCount } = entry;
    const duration = command.durationMs;
    let elapsed = Math.max(0, at - entry.startedAt);
    const spatialOffset =
      lightingLayout?.spatialOffset?.(
        entry.fixture.id,
        command.type,
        fixtureIndex,
        fixtureCount,
        entry.settings,
      ) ?? fixtureIndex / Math.max(1, fixtureCount - 1);
    if (["wave", "rainbow"].includes(command.type))
      elapsed += duration * clamp(spatialOffset, 0, 1);
    if (command.type === "chase") {
      elapsed = Math.max(
        0,
        elapsed -
          entry.settings.chaseGapMs * clamp(spatialOffset, 0, 1) * Math.max(1, fixtureCount - 1),
      );
    }
    if (["sweep", "ripple"].includes(command.type)) {
      const travel = (elapsed % duration) / duration,
        offset = clamp(spatialOffset, 0, 1);
      const rawDistance = Math.abs(travel - offset);
      const distance =
        command.type === "sweep" ? Math.min(rawDistance, 1 - rawDistance) : rawDistance;
      const width = command.type === "sweep" ? 0.3 : 0.22;
      const strength = Math.max(0, 1 - distance / width);
      const colorIndex = Math.floor(elapsed / duration) % command.colors.length;
      return {
        rgb: command.colors[colorIndex],
        brightness: Math.round(
          Math.min(entry.settings.brightnessLimit, 8 + 92 * strength * strength),
        ),
        phase: Math.floor(elapsed / 125),
      };
    }
    if (command.type === "breathe") {
      const phase = (elapsed % duration) / duration;
      return {
        rgb: command.colors[0],
        brightness: Math.min(
          entry.settings.brightnessLimit,
          Math.round(30 + 70 * ((1 - Math.cos(phase * Math.PI * 2)) / 2)),
        ),
        phase: Math.floor(elapsed / (duration / 2)),
      };
    }
    const position = elapsed / duration,
      index = Math.floor(position) % command.colors.length;
    const next = (index + 1) % command.colors.length;
    const smooth = ["fade", "rainbow", "wave"].includes(command.type);
    return {
      rgb: smooth
        ? mix(command.colors[index], command.colors[next], position - Math.floor(position))
        : command.colors[index],
      brightness: entry.settings.brightnessLimit,
      phase: smooth ? Math.floor(elapsed / 333) : Math.floor(position),
    };
  }
  function dispatch(fixture, frame, transitionMs, entry) {
    const brand = String(fixture.brand).toLowerCase();
    if (brand === "hue") {
      const state = createHueStateFromRgb(frame.rgb, {
        brightness: Math.round((frame.brightness * 254) / 100),
        transitiontime: Math.round(clamp(transitionMs / 100, 0, 30)),
      });
      entertainment.decorateState(state, entry);
      const delivery = outputOwnership
        ? outputOwnership.write(entry?.leaseToken, state)
        : adapters.hue?.sendState?.([fixture], state);
      return entertainment.guardDelivery(delivery, entry, () => {
        stopFixtures(
          [...active.values()]
            .filter((e) => e.sessionId === entry.sessionId)
            .map((e) => e.fixture.id),
          { force: true, animate: false },
        );
      });
    }
    const state = createWizStateFromRgb(frame.rgb, {
      dimming: frame.brightness,
    });
    return outputOwnership
      ? outputOwnership.write(entry?.leaseToken, state)
      : adapters[brand]?.sendState?.([fixture], state);
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const at = now();
      for (const [id, entry] of active) {
        try {
          if (entry.capturing) continue;
          if (outputOwnership && !outputOwnership.has(entry.leaseToken)) {
            active.delete(id);
            supervise(() => releaseEntertainment(entry.sessionId), "transport_release", id);
            continue;
          }
          if (
            outputOwnership &&
            (!config.fixtureIds.includes(id) || lightingLab?.isExcluded?.(id))
          ) {
            stopFixtures([id], { force: true, animate: false });
            continue;
          }
          const limits = [
            entry.settings.durationSeconds > 0 ? entry.settings.durationSeconds * 1000 : 0,
            entry.settings.repeatCount > 0
              ? entry.command.durationMs * entry.command.colors.length * entry.settings.repeatCount
              : 0,
          ].filter(Boolean);
          const durationMs = limits.length ? Math.min(...limits) : 0;
          if (durationMs > 0 && at >= entry.startedAt + durationMs) {
            stopFixtures([id]);
            continue;
          }
          const cadence = isSmooth(entry.command)
            ? entry.entertainmentActive
              ? ENGINE_TICK_MS
              : STREAM_CADENCE_MS
            : entry.command.durationMs;
          if (at < entry.nextSentAt) continue;
          // Every transport receives the current frame immediately. Do not
          // predict a future Hue target or delay another brand to compensate.
          const frame = render(entry, at);
          entry.lastSentAt = at;
          entry.lastPhase = frame.phase;
          entry.lastFrame = frame;
          // Every deadline is derived from the common start time. Never add a
          // cadence to the previous (possibly late) dispatch, because that makes
          // unlike device cadences beat against each other and periodically swap
          // which brand appears to lead.
          entry.nextSentAt = nextAbsoluteDeadline(entry, at, cadence);
          // Start every due adapter in this same engine turn. A slow Hue HTTP
          // response must not hold the WiZ/Govee clock; adapter failures remain
          // isolated and a later absolute deadline catches up without drift.
          dispatchLatest(entry, frame, 0);
        } catch (error) {
          reportFault(error, "render", id);
        }
      }
    } finally {
      ticking = false;
      if (!active.size && timer) {
        unschedule(timer);
        timer = null;
      }
    }
  }

  async function handle(rawText, context = {}) {
    if (shuttingDown) return { matched: true, ok: false, error: "lighting_shutting_down" };
    const command = parse(rawText);
    const libraryResult = require("./music-light-effect-command").libraryCommand(
      command,
      context,
      musicHandler,
    );
    if (!command.matched || !command.ok || libraryResult) return libraryResult || command;
    // Admission precedes revision changes: a rejected redemption must not
    // invalidate the in-flight Rave that it was refused permission to replace.
    if (command.type !== "stop" && isRaveActive())
      return { matched: true, ok: false, error: "music_rave_active", refundRecommended: true };
    const requestRevision = context.preview ? effectRevision : ++effectRevision;
    const routedIds = Array.isArray(context.fixtureIds) ? context.fixtureIds : [];
    if (command.type === "stop") {
      const relevant = command.raveOnly ? [] : routedIds.filter((id) => active.has(id));
      const musicIds = await require("./music-light-effect-command").stopRouted(
        musicHandler,
        command.raveOnly ? musicHandler?.ids() || [] : routedIds,
        context.preview,
      );
      return {
        matched: true,
        ok: true,
        effect: "stop",
        stopped: (context.preview ? relevant.length : stopFixtures(relevant)) + musicIds.length,
        targets: [...new Set([...relevant, ...musicIds])],
      };
    }
    if (!config.enabled)
      return {
        matched: true,
        ok: false,
        error: "dynamic_light_effects_disabled",
      };
    const settings = lightingLab?.settings?.() || {
      brightnessLimit: 100,
      durationSeconds: 0,
      repeatCount: 0,
      cooldownSeconds: 0,
      restorePrevious: false,
      spatialDirection: "left-right",
      spatialOriginFixtureId: "",
      chaseGapMs: 250,
    };
    const fixtures = selectedFixtures(routedIds)
      .filter((row) => Number(cooldownUntil.get(row.id) || 0) <= now())
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (!fixtures.length)
      return {
        matched: true,
        ok: false,
        error: "no_effect_enabled_fixtures_matched",
      };
    if (context.preview)
      return {
        matched: true,
        ok: true,
        preview: true,
        effect: command.type,
        speed: command.speed,
        targets: fixtures.map((row) => row.id),
        sent: 0,
        failed: 0,
      };
    if (command.type === "rave") {
      ravePending = true;
      try {
        return await require("./music-light-effect-command")({
          handler: musicHandler,
          command,
          fixtures,
          settings,
          isCurrent: () => requestRevision === effectRevision,
          stopFixtures,
          setCooldown: (id, until) => cooldownUntil.set(id, until),
          now,
        });
      } finally {
        ravePending = false;
      }
    }
    let startedAt = now();
    const sessionId = ++sessionSequence;
    const entries = fixtures.map((fixture, fixtureIndex) => {
      const previous = active.get(fixture.id);
      const entry = {
        fixture,
        command,
        fixtureIndex,
        fixtureCount: fixtures.length,
        settings,
        previousState: previous?.previousState || null,
        sessionId,
        startedAt,
        capturing: true,
        lastSentAt: -Infinity,
        nextSentAt: -Infinity,
        lastPhase: -1,
        lastFrame: null,
      };
      active.set(fixture.id, entry);
      entry.baseline =
        (outputOwnership
          ? outputOwnership
              .replaceOwned({
                fixtureId: fixture.id,
                owner: "core.effects",
                kind: "effect",
                ttlMs: 15000,
              })
              .then((grant) => {
                entry.leaseToken = grant.token;
                return { brand: fixture.brand, value: grant.baseline };
              })
          : null) ||
        previous?.baseline ||
        (restoring.has(fixture.id) ? Promise.resolve(restoring.get(fixture.id)) : null) ||
        (async () => {
          await dispatchLatest.settled(fixture.id);
          const reader = adapters[String(fixture.brand).toLowerCase()]?.readState;
          if (typeof reader !== "function") return lightingLab?.previousState?.(fixture.id);
          const read = await reader(fixture);
          return read?.ok && read.state ? { brand: fixture.brand, value: read.state } : null;
        })();
      return entry;
    });
    fixtures.forEach((fixture) => invalidateRestore(fixture.id));
    await Promise.all(
      entries.map(async (entry) => {
        try {
          entry.previousState = await entry.baseline;
        } catch (error) {
          // A newer command can replace the reservation while the shared native
          // read is pending. Report once below, only if this entry still owns
          // the required baseline. Obsolete reservations are not device faults.
          entry.captureError = error;
        }
        if (
          (outputOwnership || config.returnEffect || settings.restorePrevious) &&
          !entry.previousState?.value &&
          active.get(entry.fixture.id) === entry
        ) {
          active.delete(entry.fixture.id);
          reportFault(
            entry.captureError ||
              Object.assign(Error("previous_state_unavailable"), {
                code: "previous_state_unavailable",
              }),
            "capture",
            entry.fixture.id,
          );
        }
      }),
    );
    const owned = entries.filter((entry) => active.get(entry.fixture.id) === entry);
    if (!owned.length)
      return {
        matched: true,
        ok: false,
        error: "effect_baseline_unavailable_or_superseded",
        targets: [],
        sent: 0,
        failed: fixtures.length,
      };
    const prepared = await entertainment.prepare(owned, sessionId);
    if (
      prepared &&
      (!prepared.ok ||
        shuttingDown ||
        owned.some((entry) => active.get(entry.fixture.id) !== entry))
    ) {
      stopFixtures(
        owned.filter((e) => active.get(e.fixture.id) === e).map((e) => e.fixture.id),
        { force: true, animate: false },
      );
      await releaseEntertainment(sessionId);
      return {
        matched: true,
        ok: false,
        error: prepared.error || "effect_superseded",
        sent: 0,
        failed: owned.length,
        targets: [],
      };
    }
    startedAt = now();
    owned.forEach((entry) => {
      entry.capturing = false;
      entry.startedAt = startedAt;
    });
    ensureTimer();
    await tick();
    let delivered = owned.length;
    if (outputOwnership) {
      const receipts = await Promise.allSettled(owned.map((entry) => entry.firstDelivery));
      delivered = receipts.filter(
        (row) => row.status === "fulfilled" && row.value?.sent === 1 && !row.value.failed,
      ).length;
      receipts.forEach((row, index) => {
        if (
          (row.status !== "fulfilled" || row.value?.sent !== 1 || row.value.failed) &&
          active.get(owned[index].fixture.id) === owned[index]
        )
          stopFixtures([owned[index].fixture.id], { force: true, animate: false });
      });
    }
    const result = {
      matched: true,
      ok: delivered > 0,
      effect: command.type,
      speed: command.speed,
      synchronized: false,
      startsAt: startedAt,
      targets: owned.map((entry) => entry.fixture.id),
      sent: delivered,
      failed: fixtures.length - delivered,
      ...(!delivered ? { error: "effect_delivery_unconfirmed" } : {}),
    };
    lightingLab?.record?.({
      source: "effect",
      command: rawText,
      ok: result.ok,
      targets: result.targets,
      sent: result.sent,
      detail: `${command.type}:${command.speed}`,
    });
    return result;
  }
  function cancelFixtureIds(ids) {
    return stopFixtures(Array.isArray(ids) ? ids : []);
  }
  async function shutdown() {
    shuttingDown = true;
    if (timer) {
      unschedule(timer);
      timer = null;
    }
    for (const handle of delayedTimers) unscheduleOnce(handle);
    delayedTimers.clear();
    stopFixtures(
      [...active.keys()],
      outputOwnership ? { force: true, animate: false } : { restore: false },
    );
    if (pendingTasks.size) {
      let deadline;
      await Promise.race([
        Promise.allSettled([...pendingTasks]),
        new Promise((resolve) => {
          deadline = setTimeout(resolve, shutdownWaitMs);
        }),
      ]);
      clearTimeout(deadline);
    }
  }

  return Object.freeze({
    setMusicHandler: (handler) => {
      musicHandler = handler;
    },
    isRaveActive,
    isRaveStop,
    isRaveLibraryCommand: (text) => {
      const route = resolve(text);
      return ["rave-save", "rave-remember"].includes(parse(route.matched ? route.text : text).type);
    },
    snapshot,
    save,
    parse,
    resolve,
    handle,
    cancelFixtureIds,
    cancelForStaticTargets,
    waitForFixtureWrites: (ids) => Promise.all((ids || []).map((id) => dispatchLatest.settled(id))),
    tick,
    shutdown,
  });
};
