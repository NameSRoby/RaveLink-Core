/** One bounded music rendering lifetime. Preview has no output capability.
 * The optional injected broker is a server capability, not a browser-supplied
 * setting. Core owns this session through its native Music-to-Light service.
 * No capture, timer or fixture lease exists until start(explicitProbe).
 */
const crypto = require("node:crypto");
const createMapper = require("./mapper.cjs");
const createCadence = require("./output-cadence.cjs");
const createOutputMotion = require("./output-motion.cjs");
const { opening, choose: chooseTransitions } = require("./lifecycle-motion.cjs");
const recipe = require("./recipe.cjs");
const { validate: validateBehavior, sceneFrame } = require("./fixture-behavior.cjs");
const { fault, settings: validateSettings } = require("./mapping-settings.cjs");
const {
  createHueStateFromRgb,
  createWizStateFromRgb,
} = require("../../src/domains/colors/color-space");
const CADENCE_MS = 250,
  WATCHDOG_MS = 25;
function targets(output, previewFixtures) {
  if (!output)
    return ["all", "low", "mid", "high"].map((role, i) => ({
      role,
      position: i / 3,
      outOfSync: previewFixtures[i % previewFixtures.length]?.outOfSync || 0,
      contrastSourceId: previewFixtures[i % previewFixtures.length]?.id,
    }));
  if (
    !output.ownership ||
    ["acquire", "write", "release", "releaseOwner", "has"].some(
      (method) => typeof output.ownership[method] !== "function",
    ) ||
    !Array.isArray(output.fixtures) ||
    !output.fixtures.length ||
    output.fixtures.length > 64
  )
    throw fault("invalid_music_output_capability");
  const ids = new Set();
  return output.fixtures.map((f) => {
    if (
      !f ||
      typeof f.id !== "string" ||
      !/^[a-zA-Z0-9._-]{1,64}$/.test(f.id) ||
      ids.has(f.id) ||
      !["hue", "wiz", "govee"].includes(f.brand) ||
      !["all", "low", "mid", "high"].includes(f.role) ||
      !Number.isFinite(f.position) ||
      f.position < 0 ||
      f.position > 1
    )
      throw fault("invalid_music_fixture_selection");
    ids.add(f.id);
    validateBehavior(f);
    return { ...f, raveBehavior: f.raveBehavior || "reactive" };
  });
}
module.exports = function createMusicSession({
  settings,
  recipeHistory = null,
  output = null,
  previewFixtures = [],
  onFrame = () => {},
  now = () => performance.now(),
  setTimeout: schedule = setTimeout,
  clearTimeout: cancel = clearTimeout,
} = {}) {
  if (typeof onFrame !== "function") throw fault("invalid_music_preview_callback");
  const mapper = createMapper(settings, { history: recipeHistory }),
    transitionPlan = chooseTransitions(
      mapper.settings().behaviors,
      Math.random,
      mapper.settings().behaviors.shuffleChoicesEnabled ? recipeHistory : null,
    ),
    selected = require("./fixture-contrast.cjs").plan(
      recipe.fixtures(
        targets(output, previewFixtures),
        mapper.settings(),
        output?.kind === "effect",
        Math.random,
        mapper.settings().behaviors.expressiveEnabled &&
          mapper.settings().behaviors.shuffleChoicesEnabled
          ? recipeHistory
          : null,
      ),
    ),
    cadence = createCadence(selected),
    motion = createOutputMotion(),
    deliveries = new Map(
      selected.map((f) => [
        f.id,
        {
          attempted: 0,
          completed: 0,
          suppressed: 0,
          failed: 0,
          busySkipped: 0,
          times: [],
          lastLatencyMs: null,
          lastCommand: null,
          lastBrightness: null,
        },
      ]),
    ),
    lastSentAt = new Map(),
    leases = new Map(),
    baselines = new Map(),
    admittedAt = new Map(),
    writing = new Map();
  mapper.setPositions(require("./composition.cjs").reactivePositions(selected));
  const owner = "music." + crypto.randomBytes(12).toString("hex");
  function outputSettings(config) {
    if (!output) return;
    for (const fixture of selected) {
      const scale = fixture.brand === "hue" ? 254 / 100 : 1;
      if (
        (fixture.brand === "wiz" && config.minimumBrightness < 10) ||
        Math.ceil(config.minimumBrightness * scale) > Math.floor(config.maximumBrightness * scale)
      )
        throw fault("music_brightness_limits_unrepresentable");
    }
  }
  outputSettings(mapper.settings());
  let probe,
    generation,
    timer,
    startedAt,
    sampledAt = null,
    lastOutputAt = null,
    acquiring = null,
    state = "idle",
    reason = null,
    closed = false,
    stopPromise = null,
    frames = 0,
    targetHz = mapper.settings().outputHz,
    busySkipped = 0,
    lastPreview = null,
    failed = 0,
    paused = 0,
    lastUsableAt = null;
  let endingAt = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  function arm() {
    if (closed) return;
    // Wake at the next render deadline, with a 25 ms freshness/rate watchdog.
    // A late callback renders current audio once; there is no catch-up queue.
    const remaining = lastOutputAt === null ? WATCHDOG_MS : lastOutputAt + 1000 / targetHz - now();
    timer = schedule(
      () => {
        cancel(timer);
        timer = undefined;
        tick();
        arm();
      },
      Math.max(1, Math.min(WATCHDOG_MS, Math.ceil(remaining))),
    );
    timer?.unref?.();
  }
  function stop(code = "operator_stop", failure = false) {
    if (stopPromise) return stopPromise;
    closed = true;
    state = "stopping";
    reason = code;
    if (timer !== undefined) cancel(timer);
    probe?.events.off("update", update);
    stopPromise = (async () => {
      try {
        probe?.stop();
      } catch {
        failure = true;
        reason = "music_capture_stop_failed";
      }
      await acquiring;
      await Promise.allSettled([...writing.values()]);
      try {
        await output?.stopTransport?.(owner);
      } catch {
        failed++;
      }
      if (output) {
        try {
          const graceful =
            !failure &&
            [
              "operator_stop",
              "capture_ended",
              "music_song_ended",
              "music_timer_ended",
              "music_playback_stopped",
            ].includes(code);
          if (graceful && transitionPlan.endingStyle) endingAt = now();
          const results = await output.ownership.releaseOwner(owner, {
            fadeMs:
              graceful && transitionPlan.endingStyle ? Math.round(transitionPlan.endingMs) : 0,
            style: transitionPlan.endingStyle || 1,
            maxHz: mapper.settings().outputHz,
            fixtureOrder: [...selected]
              .sort((a, b) => a.position - b.position)
              .map((fixture) => fixture.id),
          });
          failed += results.filter((r) => r.failed > 0).length;
        } catch {
          failed++;
        }
      }
      if (probe) {
        let timeout;
        try {
          await Promise.race([
            probe.done,
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(fault("music_capture_stop_unconfirmed")), 2500);
            }),
          ]);
        } catch {
          if (!failure) reason = "music_capture_stop_unconfirmed";
          failure = true;
        } finally {
          clearTimeout(timeout);
        }
      }
      leases.clear();
      state = failure || failed ? "failed" : "stopped";
      const result = snapshot();
      resolveDone(result);
      return result;
    })();
    return stopPromise;
  }
  function acquire() {
    if (!output || acquiring || leases.size || closed) return;
    state = output.prepare ? "preheating" : "acquiring";
    acquiring = Promise.resolve()
      .then(async () => {
        const prepared = await output.prepare?.(selected, owner);
        if (closed) return [];
        if (prepared && !prepared.ok)
          throw fault(prepared.error || "music_transport_preheat_failed");
        for (const f of selected)
          f.entertainmentActive = prepared?.activeIds?.includes(f.id) === true;
        state = "acquiring";
        return Promise.allSettled(
          selected.map((f) =>
            output.ownership.acquire({
              fixtureId: f.id,
              owner,
              kind: output.kind || "music",
              ttlMs: 1500,
            }),
          ),
        );
      })
      .then((results) => {
        if (closed) return;
        if (results.some((r) => r.status === "rejected"))
          throw fault("music_fixture_admission_failed");
        results.forEach((r, i) => {
          leases.set(selected[i].id, r.value.token);
          baselines.set(selected[i].id, r.value.startingState || r.value.baseline);
          admittedAt.set(selected[i].id, now());
        });
        state = "running";
      })
      .catch((error) => {
        void stop(error.code || "music_fixture_admission_failed", true);
      });
  }
  function update(event) {
    if (closed) return;
    try {
      if (event.generation !== generation) throw fault("music_generation_mismatch");
      if (event.type === "ended") {
        void stop(
          event.reason === "source_exited" ? "music_source_lost" : "capture_ended",
          event.reason === "source_exited",
        );
        return;
      }
      if (event.type === "status" && event.signal === "stale") throw fault("music_source_stale");
      if (event.type !== "level") return;
      if (event.signal === "invalid" || event.invalidSamples) throw fault("music_invalid_input");
      // The supervisor bounds clock uncertainty. Unknown startup timestamps do
      // not acquire fixtures or invent fresh silence; the startup deadline applies.
      if (!event.freshness?.verified) return;
      const age = event.freshness.maxAgeMs;
      if (!Number.isFinite(age) || age < 0 || age > 250 || event.freshness.stale)
        throw fault("music_source_stale");
      sampledAt = now() - age;
      mapper.update(event, sampledAt);
      if (!output) state = "preview";
      const ready = selected.every((f) => mapper.render(now(), f));
      if (ready) {
        lastUsableAt = now();
        acquire();
      }
    } catch (error) {
      void stop(error.code || "music_input_failed", true);
    }
  }
  function dispatch(fixture, frame) {
    if (closed || !leases.has(fixture.id)) return;
    const delivery = deliveries.get(fixture.id);
    const at = now();
    if (
      at - (lastSentAt.get(fixture.id) ?? -Infinity) <
      1000 / cadence.fixtureRate(fixture, targetHz)
    )
      return;
    if (writing.has(fixture.id)) {
      busySkipped++;
      delivery.busySkipped++;
      return;
    }
    lastSentAt.set(fixture.id, at);
    const token = leases.get(fixture.id);
    if (output.allowed && !output.allowed(fixture.id)) {
      leases.delete(fixture.id);
      paused++;
      const release = output.ownership
        .release(token)
        .catch(() => {
          failed++;
        })
        .finally(() => writing.delete(fixture.id));
      writing.set(fixture.id, release);
      return;
    }
    if (!output.ownership.has(token)) {
      leases.delete(fixture.id);
      paused++;
      return;
    }
    const config = mapper.settings();
    const falling = delivery.lastBrightness !== null && frame.brightness < delivery.lastBrightness;
    let native =
      frame.sceneNative ||
      (fixture.brand === "hue"
        ? createHueStateFromRgb(frame.rgb, {
            brightness: Math.round((frame.brightness * 254) / 100),
            // Only falling Pulse/Bands targets get the optional native glide.
            // Rising accents remain immediate; no brand-sync delay is added.
            transitiontime:
              config.interpretation === "musical" &&
              config.behaviors.loudnessBrightness &&
              !config.behaviors.steadyBrightness
                ? 0
                : falling && config.behaviors.hueGlideMs > 0
                  ? Math.round(config.behaviors.hueGlideMs / 100)
                  : config.interpretation === "musical" && mapper.preset() === "ambient"
                    ? 1
                    : 0,
          })
        : createWizStateFromRgb(frame.rgb, { dimming: frame.brightness }));
    if (frame.entranceMix !== undefined && baselines.has(fixture.id)) {
      const initial = { ...baselines.get(fixture.id) };
      const key = fixture.brand === "hue" ? "bri" : "dimming";
      const scale = fixture.brand === "hue" ? 2.54 : 1;
      initial[key] = Math.min(
        Number.isFinite(initial[key]) ? initial[key] : config.minimumBrightness * scale,
        config.maximumBrightness * scale,
      );
      native = require("../../src/domains/fixtures/fixture-output-transition").interpolate(
        initial,
        native,
        frame.entranceMix,
      );
    }
    if (fixture.entertainmentActive) {
      native.__entertainment = true;
      // Keep the mapped RGB through streaming; an xy round trip normalizes
      // lightness and can alter the same color sent directly to WiZ.
      if (!frame.sceneNative && (frame.entranceMix === undefined || frame.entranceMix >= 1))
        native.__rgb = { ...frame.rgb };
    }
    const task = Promise.resolve()
      .then(() => {
        if (closed) return;
        delivery.attempted++;
        delivery.lastCommand = {
          atMs: Math.max(0, at - startedAt),
          // Transport markers authorize adapter behavior; they are not part of
          // the public, contract-validated native light-state diagnostics.
          state: Object.fromEntries(
            Object.entries(structuredClone(native)).filter(([key]) => !key.startsWith("__")),
          ),
        };
        delivery.lastBrightness = frame.brightness;
        return output.ownership.write(token, native, { sampledAt: frame.sampledAt });
      })
      .then((result) => {
        if (!result) return;
        if (result.sent === 1) {
          delivery.completed++;
          delivery.lastLatencyMs = Math.max(0, now() - at);
          delivery.times.push(now());
          if (delivery.times.length > 64) delivery.times.shift();
        } else delivery.suppressed++;
      })
      .catch(async () => {
        // Isolate an offline fixture. Do not stall another brand or silently
        // reacquire a manual takeover; a new explicit session is required.
        failed++;
        delivery.failed++;
        leases.delete(fixture.id);
        const result = await output.ownership.release(token);
        if (result.failed) failed++;
      })
      .catch(() => {
        failed++;
      })
      .finally(() => writing.delete(fixture.id));
    writing.set(fixture.id, task);
  }
  function tick() {
    if (closed) return;
    try {
      const at = now();
      if (lastUsableAt === null && at - startedAt > 7500) {
        void stop("music_startup_timeout", true);
        return;
      }
      if (sampledAt === null) {
        if (at - startedAt > 7500) void stop("music_startup_timeout", true);
        return;
      }
      if (at - sampledAt > 250) {
        void stop("music_source_stale", true);
        return;
      }
      if (output && state === "preheating") return;
      const config = mapper.settings();
      targetHz = cadence.rate(config, mapper.inspect(at), at);
      const openingStart = output ? Math.min(...admittedAt.values()) : startedAt;
      if (
        transitionPlan.openingStyle &&
        at - openingStart < transitionPlan.openingMs &&
        selected.some((fixture) => !fixture.raveBehavior || fixture.raveBehavior === "reactive")
      )
        targetHz = config.outputHz;
      if (lastOutputAt !== null && at - lastOutputAt < 1000 / targetHz) return;
      const rendered = selected.map((f) => {
        // Each fixture retains a new measured attack until its own output slot.
        // A faster WiZ slot cannot consume a slower Hue fixture's attack. Bound
        // retention so a stalled writer never replays a stale onset backlog.
        const retainedSince = output
          ? Math.max(lastSentAt.get(f.id) ?? startedAt - 1, at - cadence.retentionMs(f, targetHz))
          : (lastOutputAt ?? startedAt - 1);
        let frame = mapper.render(at, { ...f, onsetSince: retainedSince });
        if (!frame) return frame;
        if (!output)
          return opening(
            motion.render(f.id || f.position, frame, at, config),
            f,
            config,
            at - startedAt,
            undefined,
            transitionPlan,
          );
        if (f.raveBehavior && f.raveBehavior !== "reactive") {
          if (!baselines.has(f.id)) return frame;
          frame = sceneFrame(f, frame, config, baselines.get(f.id), at - admittedAt.get(f.id));
          if (frame.sceneNative) return frame;
        }
        if (f.raveBehavior === "reactive") frame = motion.render(f.id, frame, at, config);
        frame = opening(
          frame,
          f,
          config,
          at - (admittedAt.get(f.id) ?? startedAt),
          baselines.get(f.id),
          transitionPlan,
        );
        const scale = f.brand === "hue" ? 254 / 100 : 1;
        const units = Math.max(
          Math.ceil(
            (f.raveBehavior === "steady"
              ? f.brand === "wiz"
                ? 10
                : 1
              : config.minimumBrightness) * scale,
          ),
          Math.min(
            Math.floor(config.maximumBrightness * scale),
            Math.round(frame.brightness * scale),
          ),
        );
        return { ...frame, brightness: units / scale };
      });
      if (rendered.some((f) => !f)) {
        if (leases.size && at - lastUsableAt > 250) void stop("music_analysis_unavailable", true);
        return;
      }
      frames++;
      lastOutputAt = at;
      lastPreview = {
        sequence: frames,
        preset: mapper.preset(),
        frames: rendered.map((f) => ({
          role: f.role,
          rgb: f.rgb,
          brightness: f.brightness,
          quiet: f.quiet,
        })),
      };
      const callback = onFrame(structuredClone(lastPreview));
      if (callback && typeof callback.then === "function") {
        Promise.resolve(callback).catch(() => {});
        throw fault("music_preview_callback_must_be_sync");
      }
      if (output && state === "running") {
        selected.forEach((f, i) => dispatch(f, rendered[i]));
        if (!leases.size) void stop("music_ownership_lost");
      }
    } catch (error) {
      void stop(error.code || "music_render_failed", true);
    }
  }
  function snapshot() {
    const capture = probe?.snapshot();
    const usable =
      !closed &&
      capture?.freshness?.verified &&
      !capture.freshness.stale &&
      capture.freshness.maxAgeMs <= 250;
    const rms = usable ? capture.lastLevel?.rms : null;
    const start = output ? Math.min(...admittedAt.values()) : startedAt;
    const phase =
      state === "stopping" && endingAt !== null
        ? "ending"
        : ["running", "preview"].includes(state) &&
            transitionPlan.openingStyle &&
            selected.some((f) => !f.raveBehavior || f.raveBehavior === "reactive") &&
            now() - start < transitionPlan.openingMs
          ? "opening"
          : "none";
    return {
      state,
      reason,
      output: output ? "broker" : "preview",
      frames,
      failedOperations: failed,
      pausedFixtures: paused,
      ownedFixtures: leases.size,
      transition: {
        phase,
        openingStyle: transitionPlan.openingStyle,
        endingStyle: transitionPlan.endingStyle,
        progress:
          phase === "none"
            ? 1
            : Math.max(
                0,
                Math.min(
                  1,
                  (now() - (phase === "ending" ? endingAt : start)) /
                    (phase === "ending" ? transitionPlan.endingMs : transitionPlan.openingMs),
                ),
              ),
      },
      outputCadence: {
        mode: mapper.settings().outputRateMode,
        requestedHz: mapper.settings().outputHz,
        targetHz,
        busySkipped,
        fixtureHz: selected.map((f) => ({
          role: f.role,
          brand: f.brand || "preview",
          hz: cadence.fixtureRate(f, targetHz),
          delivery: (() => {
            const d = deliveries.get(f.id),
              at = closed ? (d.times.at(-1) ?? now()) : now();
            const times = d.times.filter((t) => at - t <= 2000);
            return {
              attempted: d.attempted,
              completed: d.completed,
              suppressed: d.suppressed,
              failed: d.failed,
              busySkipped: d.busySkipped,
              completedHz:
                times.length > 1 && times.at(-1) > times[0]
                  ? ((times.length - 1) * 1000) / (times.at(-1) - times[0])
                  : 0,
              lastLatencyMs: d.lastLatencyMs,
              lastCommand: structuredClone(d.lastCommand),
            };
          })(),
        })),
      },
      lastPreview: structuredClone(lastPreview),
      inputDb:
        Number.isFinite(rms) && rms > 0 ? Math.max(-120, Math.min(18, 20 * Math.log10(rms))) : null,
    };
  }
  return Object.freeze({
    start(explicitProbe) {
      if (state !== "idle" || closed) throw fault("music_session_already_started");
      if (
        !explicitProbe?.events?.on ||
        !explicitProbe.done?.then ||
        typeof explicitProbe.stop !== "function"
      )
        throw fault("invalid_music_capture");
      generation = explicitProbe.snapshot()?.generation;
      if (typeof generation !== "string" || !/^[0-9a-f]{16,64}$/.test(generation))
        throw fault("invalid_music_generation");
      probe = explicitProbe;
      startedAt = now();
      state = "waiting";
      probe.events.on("update", update);
      probe.done.then(
        () => {
          void stop("capture_ended");
        },
        (error) => {
          void stop(
            /^[a-z_]{1,80}$/.test(error?.code || "") ? error.code : "music_capture_failed",
            true,
          );
        },
      );
      arm();
      return snapshot();
    },
    setContrast(ids, percent) {
      if (closed) throw fault("music_session_closed");
      if (!Number.isInteger(percent) || percent < 0 || percent > 100)
        throw fault("invalid_music_fixture_selection");
      for (const f of selected)
        if (
          (!f.raveBehavior || f.raveBehavior === "reactive") &&
          (ids === null || ids.includes(f.id || f.contrastSourceId))
        )
          f.outOfSync = percent;
    },
    stop,
    done,
    snapshot,
    inspect: () =>
      closed
        ? null
        : {
            ...mapper.inspect(now()),
            outputCadence: snapshot().outputCadence,
            assignments: selected.map(
              ({
                id,
                role,
                position,
                raveBehavior,
                sceneBrightness,
                sceneFadeMs,
                colorSlot,
                outOfSync = 0,
              }) => ({
                id,
                role,
                position,
                raveBehavior,
                sceneBrightness,
                sceneFadeMs,
                colorSlot,
                outOfSync,
              }),
            ),
          },
    validate(input) {
      const config = validateSettings(input);
      outputSettings(config);
      return config;
    },
    tick,
    configure(input) {
      if (closed) throw fault("music_session_closed");
      const config = validateSettings(input);
      outputSettings(config);
      const inspection = mapper.inspect(now()),
        scenario = inspection.scenario;
      const choiceBlocked = Object.entries(inspection.recipe || {}).some(
        ([axis, value]) =>
          typeof value === "string" &&
          config.recipeOptions[axis]?.mode !== "configured" &&
          config.recipeOptions[axis] &&
          !config.recipeOptions[axis].allowed.includes(value),
      );
      const fixtureBlocked = selected.some(
        (f) =>
          (config.recipeOptions.role &&
            config.recipeOptions.role.mode !== "configured" &&
            !config.recipeOptions.role.allowed.includes(f.role)) ||
          (output?.kind === "effect" &&
            config.recipeOptions.task &&
            config.recipeOptions.task.mode !== "configured" &&
            !config.recipeOptions.task.allowed.includes(f.raveBehavior)),
      );
      if (
        inspection.recipeLocked &&
        ((scenario && !Object.values(config.scenarioWeights).some((v) => v > 0)) ||
          (scenario && config.scenarioWeights[scenario.id] === 0) ||
          choiceBlocked ||
          fixtureBlocked ||
          inspection.layers.some((layer) => layer.selected && config.behaviors[layer.id] === false))
      )
        void stop("music_scenario_disabled");
      return mapper.configure(config);
    },
  });
};
module.exports.CADENCE_MS = CADENCE_MS;
