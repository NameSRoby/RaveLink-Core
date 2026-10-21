/** Core-owned capture policy and bounded artistic rendering lifetimes.
 * Only operator methods grant access or select bindings. The frozen client cannot
 * nominate a process, fixture, executable, permission or lease owner at Start.
 * Only the trusted operator can invoke viewer Rave or borrow a granted probe.
 */
const defaultProbe = require("./probe.cjs");
const createSession = require("./session.cjs");
const { createLifetime } = require("./song-duration.cjs");
const createSharedCapture = require("./shared-capture.cjs");
const fixtureBehavior = require("./fixture-behavior.cjs");
const { settings: validateSettings, fault } = require("./mapping-settings.cjs");
const { validateSource } = require("./protocol.cjs");
const { validateValue } = require("../../src/shared/contracts/bounded-json-schema");
const descriptors = require("./contracts/music-controller-v1.contracts.json").contracts;
const contracts = new Map(descriptors.map((row) => [row.capability, row]));
function sourcePlan(rows) {
  if (!Array.isArray(rows) || rows.length !== 3) throw fault("invalid_music_source_priorities");
  const sources = rows.map((row) => (row === null ? null : validateSource(row)));
  const ids = sources.filter(Boolean).map((row) => row.id);
  if (new Set(ids).size !== ids.length) throw fault("invalid_music_source_priorities");
  return sources;
}
function keys(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw fault("invalid_music_request");
}
module.exports = function createMusicController({
  probeApi = defaultProbe,
  sessionFactory = createSession,
  output = null,
  now = () => performance.now(),
  initialSettings,
  savedEffects = null,
  readPlayback = async () => null,
  wallNow = () => Date.now(),
} = {}) {
  let design = validateSettings(initialSettings),
    active = false,
    closed = false,
    epoch = 0,
    grants = { capture: false, output: false },
    source = null,
    sourceSlots = [null, null, null],
    selection = [],
    catalog = null,
    context = null,
    stopPromise = null,
    shutdownPromise = null,
    lastResult = null;
  let raveRevision = 0,
    raveContext = null,
    pendingRave = null,
    raveQueue = Promise.resolve();
  const captures = createSharedCapture(probeApi);
  const recipeHistory = require("./recipe-history.cjs")();
  const queries = new Set(),
    subscribers = new Set();
  function enabled() {
    if (!active || closed) throw fault("music_feature_inactive");
  }
  function capturePermission() {
    enabled();
    if (!grants.capture) throw fault("music_capture_permission_required");
  }
  function notify(frame, ctx) {
    if (closed || (context !== ctx && raveContext !== ctx) || ctx.epoch !== epoch) return;
    for (const listener of [...subscribers]) {
      try {
        const value = listener(structuredClone(frame));
        if (value && typeof value.then === "function") {
          Promise.resolve(value).catch(() => {});
          subscribers.delete(listener);
        }
      } catch {
        subscribers.delete(listener);
      }
    }
  }
  async function stop(reason = "operator_stop") {
    raveRevision++;
    const raveStop = stopRave(reason);
    if (stopPromise) return stopPromise;
    const ctx = context;
    if (!ctx) {
      await raveStop;
      return status();
    }
    // Fence publication immediately; the drain still owns this slot until done.
    ctx.epoch = -1;
    const task = Promise.all([ctx.session.stop(reason), raveStop])
      .then(([result]) => {
        lastResult = result;
        return status();
      })
      .finally(() => {
        if (context === ctx) context = null;
        if (stopPromise === task) stopPromise = null;
      });
    stopPromise = task;
    return task;
  }
  async function cancelQueries() {
    const running = [...queries];
    running.forEach((q) => q.abort.abort());
    await Promise.allSettled(running.map((q) => q.task));
  }
  async function sources() {
    capturePermission();
    if (queries.size) throw fault("music_source_query_busy");
    const revision = epoch,
      abort = new AbortController(),
      query = { abort, task: null };
    queries.add(query);
    query.task = Promise.resolve()
      .then(() => probeApi.listSources({ signal: abort.signal }))
      .then((items) => {
        capturePermission();
        if (revision !== epoch) throw fault("music_policy_changed");
        if (!Array.isArray(items) || items.length > 257) throw fault("invalid_music_catalog");
        const entries = items.map(validateSource);
        if (new Set(entries.map((row) => row.id)).size !== entries.length)
          throw fault("invalid_music_catalog");
        catalog = { entries, expiresAt: now() + 30000 };
        return structuredClone(entries);
      })
      .finally(() => queries.delete(query));
    return query.task;
  }
  function fixtureBindings(input) {
    if (!output?.resolveFixtures || !output.ownership) throw fault("music_output_unavailable");
    if (!Array.isArray(input) || !input.length || input.length > 64)
      throw fault("invalid_music_fixture_selection");
    const selected = new Set();
    const resolved = output.resolveFixtures();
    if (!Array.isArray(resolved) || resolved.length > 256)
      throw fault("invalid_music_fixture_catalog");
    const available = new Map(resolved.map((f) => [f.id, f]));
    return input.map((row) => {
      keys(row, [
        "id",
        "role",
        "position",
        "raveBehavior",
        "sceneBrightness",
        "sceneFadeMs",
        "colorSlot",
        "outOfSync",
      ]);
      fixtureBehavior.validate(row);
      if (
        typeof row.id !== "string" ||
        !/^[a-zA-Z0-9._-]{1,64}$/.test(row.id) ||
        selected.has(row.id) ||
        !["all", "low", "mid", "high"].includes(row.role) ||
        !Number.isFinite(row.position) ||
        row.position < 0 ||
        row.position > 1
      )
        throw fault("invalid_music_fixture_selection");
      const fixture = available.get(row.id);
      if (!fixture || fixture.enabled !== true || !["hue", "wiz"].includes(fixture.brand))
        throw fault("music_fixture_not_available");
      selected.add(row.id);
      return { ...row, brand: fixture.brand };
    });
  }
  function status() {
    const current = raveContext || context;
    return {
      version: 1,
      active: active && !closed,
      permissions: { ...grants },
      sourceSelected: !!source,
      sourceLabel: probeApi.current?.()?.label || null,
      sourcePriority: probeApi.current?.()?.priority ?? null,
      musicFixtureCount: selection.length,
      state: current
        ? stopPromise
          ? "stopping"
          : current.session.snapshot().state
        : closed
          ? "closed"
          : active
            ? "idle"
            : "inactive",
      session: current
        ? current.session.snapshot()
        : lastResult
          ? structuredClone(lastResult)
          : null,
      duration: current?.lifetime?.snapshot(now()) || null,
    };
  }
  async function stopRave(reason = "operator_stop") {
    const ctx = raveContext;
    if (!ctx) return;
    await ctx.session.stop(reason);
    if (raveContext === ctx) raveContext = null;
  }
  function prepareRave(request) {
    capturePermission();
    savedEffects?.check?.();
    if (!design.raveEnabled) throw fault("music_rave_disabled");
    if (!grants.output) throw fault("music_output_permission_required");
    if (!source) throw fault("music_source_selection_required");
    keys(request, [
      "fixtureIds",
      "palette",
      "feel",
      "seconds",
      "brightnessLimit",
      "origin",
      "effectPolicy",
      "intensity",
      "songOnly",
    ]);
    if (request.origin !== undefined && !["auto", "manual", "viewer"].includes(request.origin))
      throw fault("invalid_music_start");
    if (
      !Array.isArray(request.fixtureIds) ||
      request.fixtureIds.some((id) => typeof id !== "string")
    )
      throw fault("invalid_music_fixture_selection");
    const wanted = new Set(request.fixtureIds);
    const viewer = !request.origin || request.origin === "viewer";
    const routed = selection.filter(
      (f) => wanted.has(f.id) && (!viewer || output.isRaveAllowed?.(f.id) !== false),
    );
    // The operator's background scene accompanies a viewer Rave, but cannot
    // turn an unrouted reactive light into a viewer-controlled effect target.
    const companions =
      routed.length && viewer
        ? selection.filter(
            (f) => !wanted.has(f.id) && f.raveBehavior && f.raveBehavior !== "reactive",
          )
        : [];
    const fixtures = fixtureBindings(
      [...routed, ...companions].map(({ brand, ...binding }) => binding),
    );
    const maximum = Math.min(design.maximumBrightness, request.brightnessLimit ?? 100);
    const config = validateSettings({
      ...design,
      ...(request.intensity === undefined ? {} : { intensity: request.intensity }),
      ...(request.songOnly ? { raveDurationMode: "song" } : {}),
      scenarioMode: "random",
      layerMode: design.raveLayerMode,
      colorMode:
        design.raveColorPlan === "frequency"
          ? "roles"
          : design.raveColorPlan === "energy"
            ? "energy"
            : design.colorMode,
      scenarioWeights:
        design.raveScenario === "random"
          ? design.scenarioWeights
          : Object.fromEntries(
              Object.keys(design.scenarioWeights).map((id) => [
                id,
                id === design.raveScenario ? design.scenarioWeights[id] : 0,
              ]),
            ),
      palette: request.palette?.length ? request.palette : design.palette,
      feel: request.feel || "normal",
      recipeOptions: {
        ...design.recipeOptions,
        ...(request.palette?.length
          ? { palette: { mode: "configured", value: "configured", allowed: ["configured"] } }
          : {}),
        ...(request.feel
          ? { feel: { mode: "configured", value: request.feel, allowed: [request.feel] } }
          : {}),
      },
      maximumBrightness: maximum,
      minimumBrightness: Math.min(design.minimumBrightness, maximum),
    });
    if (!savedEffects?.restricted?.() && !Object.values(config.scenarioWeights).some((v) => v > 0))
      throw fault("music_no_scenarios_enabled");
    const seconds = request.seconds ?? design.raveSeconds;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
      throw fault("invalid_music_start");
    return {
      fixtures,
      config,
      seconds,
      routedIds: routed.map((f) => f.id),
      companionIds: new Set(companions.map((f) => f.id)),
    };
  }
  async function startRave(request, revision, command) {
    if (revision !== epoch || command !== raveRevision) throw fault("music_request_superseded");
    let { fixtures, config, routedIds, companionIds } = prepareRave(request);
    const sceneBindings = new Map(
      fixtures.filter((f) => companionIds.has(f.id)).map((f) => [f.id, f]),
    );
    const chosen = savedEffects?.choose(config, fixtures, request.effectPolicy);
    if (chosen) {
      config = chosen.design;
      fixtures = chosen.fixtures.map((f) => sceneBindings.get(f.id) || f);
    }
    let playback = null;
    try {
      playback = await readPlayback();
    } catch {}
    // Availability and saved priority choose capture; missing metadata or silence
    // must never replace an open player with a game or another application.
    const raveSource = source;
    const lifetime = createLifetime({
      design: config,
      request,
      source: raveSource,
      playback,
      now: now(),
      wallNow: wallNow(),
    });
    const seconds = lifetime.seconds;
    if (revision !== epoch || command !== raveRevision) throw fault("music_request_superseded");
    if (!context?.probe) await probeApi.ensureAvailable?.(raveSource.id);
    if (revision !== epoch || command !== raveRevision) throw fault("music_request_superseded");
    await stopRave("rave_replaced");
    capturePermission();
    if (revision !== epoch || command !== raveRevision) throw fault("music_request_superseded");
    const ctx = {
      epoch,
      fixtures,
      design: config,
      limit: request.brightnessLimit ?? 100,
      routedIds,
      session: null,
      probe: null,
      lifetime,
      profile: chosen?.profile || null,
      origin: request.origin || "viewer",
    };
    ctx.session = sessionFactory({
      settings: config,
      recipeHistory,
      now,
      output: {
        ownership: output.ownership,
        prepare: output.prepare,
        stopTransport: output.stopTransport,
        fixtures,
        kind: "effect",
        allowed:
          request.origin && request.origin !== "viewer"
            ? output.isAutoAllowed
            : (id) =>
                companionIds.has(id)
                  ? output.isAutoAllowed?.(id) !== false
                  : output.isRaveAllowed?.(id) !== false,
      },
      onFrame: (f) => notify(f, ctx),
    });
    raveContext = ctx;
    try {
      ctx.probe = captures.acquire(raveSource.id, seconds);
      ctx.session.start(ctx.probe);
    } catch (error) {
      await ctx.session.stop("music_start_failed");
      if (raveContext === ctx) raveContext = null;
      throw error;
    }
    ctx.session.done.then((result) => {
      clearTimeout(ctx.durationTimer);
      if (raveContext === ctx) {
        lastResult = result;
        raveContext = null;
      }
    });
    const watch = async () => {
      if (raveContext !== ctx) return;
      let value = null;
      try {
        value = await readPlayback();
      } catch {}
      if (raveContext !== ctx) return;
      const reason = lifetime.update(value, now(), wallNow());
      if (reason) {
        await ctx.session.stop(reason);
        return;
      }
      ctx.durationTimer = setTimeout(
        () => void watch().catch(() => ctx.session.stop("music_duration_failed")),
        1000,
      );
      ctx.durationTimer.unref?.();
    };
    if (lifetime.snapshot(now()).mode === "song") {
      ctx.durationTimer = setTimeout(
        () => void watch().catch(() => ctx.session.stop("music_duration_failed")),
        1000,
      );
      ctx.durationTimer.unref?.();
    }
    return {
      ok: true,
      targets: fixtures.map((f) => f.id),
      seconds,
      duration: lifetime.snapshot(now()),
    };
  }
  function start(request, renderDesign = design) {
    capturePermission();
    if (
      !savedEffects?.restricted?.() &&
      renderDesign.scenarioMode === "random" &&
      !Object.values(renderDesign.scenarioWeights).some((v) => v > 0)
    )
      throw fault("music_no_scenarios_enabled");
    keys(request, ["mode", "seconds"]);
    if (
      !["preview", "live"].includes(request.mode) ||
      (request.seconds != null &&
        (!Number.isInteger(request.seconds) || request.seconds < 1 || request.seconds > 120))
    )
      throw fault("invalid_music_start");
    if (context || raveContext || stopPromise) throw fault("music_session_busy");
    if (!source) throw fault("music_source_selection_required");
    if (request.mode === "live" && !grants.output) throw fault("music_output_permission_required");
    if (request.mode === "live" && !selection.length)
      throw fault("music_fixture_selection_required");
    let fixtures =
      request.mode === "live"
        ? fixtureBindings(selection.map(({ brand, ...binding }) => binding))
        : null;
    const chosen = savedEffects?.choose(renderDesign, fixtures);
    if (chosen) {
      renderDesign = chosen.design;
      fixtures = chosen.fixtures;
    }
    const ctx = {
      session: null,
      epoch,
      probe: null,
      fixtures,
      profile: chosen?.profile || null,
      design: renderDesign,
    };
    ctx.session = sessionFactory({
      settings: renderDesign,
      previewFixtures: selection.filter((f) => !f.raveBehavior || f.raveBehavior === "reactive"),
      recipeHistory,
      now,
      output: fixtures
        ? {
            ownership: output.ownership,
            fixtures,
            prepare: output.prepare,
            stopTransport: output.stopTransport,
          }
        : null,
      onFrame: (frame) => notify(frame, ctx),
    });
    context = ctx;
    try {
      ctx.probe = captures.acquire(source.id, request.seconds ?? null);
      ctx.session.start(ctx.probe);
    } catch (error) {
      // A capture that started before renderer admission failed still belongs to
      // this slot. Do not permit another Start before its confirmed exit.
      void cleanupFailedStart(ctx);
      throw fault(error.code || "music_start_failed");
    }
    ctx.session.done.then((result) => {
      if (context === ctx) {
        lastResult = result;
        context = null;
      }
    });
    return status();
  }
  async function cleanupFailedStart(ctx) {
    try {
      ctx.probe?.stop();
      await ctx.probe?.done;
    } catch {
    } finally {
      await ctx.session.stop("music_start_failed");
      if (context === ctx) context = null;
    }
  }
  async function policy(change) {
    enabled();
    epoch++;
    catalog = null;
    change();
    await Promise.all([stop("music_policy_changed"), cancelQueries()]);
    return status();
  }
  const client = Object.freeze({
    async call(capability, method, payload = null) {
      enabled();
      const contract = contracts.get(capability)?.methods?.[method];
      const handlers = {
        "music.sources.v1": { list: () => client.sources() },
        "music.session.v1": {
          status: () => client.status(),
          start: (p) => client.start(p),
          stop: () => client.stop(),
        },
        "music.styles.v1": {
          calibrate: (p) => client.calibrate(p),
          configure: (p) => client.configure(p),
          export: () => client.exportDesign(),
        },
      };
      const handler =
        Object.hasOwn(handlers, capability) && Object.hasOwn(handlers[capability], method)
          ? handlers[capability][method]
          : null;
      if (!handler || !contract || !validateValue(contract.request, payload))
        throw fault("invalid_music_contract_request");
      const result = await handler(payload);
      if (!validateValue(contract.response, result)) throw fault("invalid_music_contract_response");
      return structuredClone(result);
    },
    status: () => {
      enabled();
      return status();
    },
    sources,
    async calibrate(request = null) {
      const options = request ?? {};
      keys(options, ["seconds", "headroomDb"]);
      const seconds = options.seconds ?? 10,
        headroomDb = options.headroomDb ?? 0;
      if (
        ![10, 30, 60].includes(seconds) ||
        !Number.isFinite(headroomDb) ||
        headroomDb < 0 ||
        headroomDb > 12
      )
        throw fault("invalid_music_calibration");
      const original = JSON.stringify(design),
        revision = epoch;
      start(
        { mode: "preview", seconds },
        { ...design, scenarioMode: "manual", recipeOptions: {}, parameterRanges: {} },
      );
      const ctx = context,
        samples = [];
      const measure = (e) => {
        if (
          e.type === "level" &&
          e.freshness?.verified &&
          !e.freshness.stale &&
          e.invalidSamples === 0 &&
          e.rms > 0
        )
          samples.push(20 * Math.log10(e.rms));
      };
      ctx.probe.events.on("update", measure);
      let result;
      try {
        result = await ctx.session.done;
      } finally {
        ctx.probe.events.off("update", measure);
      }
      if (
        closed ||
        revision !== epoch ||
        raveContext ||
        JSON.stringify(design) !== original ||
        ["operator_stop", "music_policy_changed"].includes(result.reason)
      )
        throw fault("music_calibration_superseded");
      if (result.reason !== "capture_ended")
        throw fault(result.reason || "music_calibration_failed");
      return client.configure({ ...design, ...require("./calibration.cjs")(samples, headroomDb) });
    },
    start,
    stop: () => {
      enabled();
      return stop();
    },
    configure(input) {
      enabled();
      const next = validateSettings(input);
      const overlay =
        raveContext && next.raveEnabled
          ? validateSettings({
              ...next,
              scenarioMode: "random",
              layerMode: next.raveLayerMode,
              colorMode:
                next.raveColorPlan === "frequency"
                  ? "roles"
                  : next.raveColorPlan === "energy"
                    ? "energy"
                    : next.colorMode,
              scenarioWeights: next.scenarioWeights,
              palette: raveContext.design.palette,
              feel: raveContext.design.feel,
              maximumBrightness: Math.min(next.maximumBrightness, raveContext.limit),
            })
          : null;
      const manualNext = context?.profile
        ? require("./saved-effects.cjs").retain(next, context.design)
        : next;
      const raveNext =
        raveContext?.profile && overlay
          ? require("./saved-effects.cjs").retain(overlay, raveContext.design)
          : overlay;
      const brightnessChanged = ["steadyBrightness", "loudnessBrightness"].some(
        (key) => next.behaviors[key] !== design.behaviors[key],
      );
      if (brightnessChanged)
        for (const target of [manualNext, raveNext].filter(Boolean))
          for (const key of ["steadyBrightness", "loudnessBrightness"])
            target.behaviors[key] = next.behaviors[key];
      context?.session.validate?.(manualNext);
      if (raveNext) raveContext.session.validate?.(raveNext);
      if (context) context.design = context.session.configure(manualNext);
      if (raveContext) {
        if (!next.raveEnabled) void stopRave("music_rave_disabled");
        else {
          raveContext.design = raveContext.session.configure(raveNext);
        }
      }
      design = next;
      return structuredClone(design);
    },
    exportDesign: () => {
      enabled();
      return structuredClone(design);
    },
    subscribe(listener) {
      enabled();
      if (typeof listener !== "function" || subscribers.size >= 16)
        throw fault("music_subscriber_limit");
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  });
  const operator = Object.freeze({
    checkRave: (request) => {
      prepareRave(request);
      return context?.probe ? true : probeApi.ensureAvailable?.(source.id) || true;
    },
    restore(input) {
      enabled();
      keys(input, ["permissions", "source", "sources", "fixtures"]);
      keys(input.permissions, ["capture", "output"]);
      if (
        typeof input.permissions.capture !== "boolean" ||
        typeof input.permissions.output !== "boolean"
      )
        throw fault("invalid_music_permissions");
      const restoredSource = input.source ? validateSource(input.source) : null;
      const restoredSlots =
        input.sources === undefined ? [restoredSource, null, null] : sourcePlan(input.sources);
      if (!Array.isArray(input.fixtures)) throw fault("invalid_music_fixtures");
      const restoredFixtures = input.fixtures.length ? fixtureBindings(input.fixtures) : [];
      grants = { ...input.permissions };
      sourceSlots = restoredSlots;
      source = sourceSlots.find(Boolean) || null;
      probeApi.setPriorities?.(sourceSlots.map((row) => row?.id || null));
      selection = restoredFixtures;
    },
    pipeline: () => {
      const current = raveContext || context,
        value = current?.session.inspect?.();
      if (
        value &&
        !(value.assignments || current.fixtures).some(
          (f) => !f.raveBehavior || f.raveBehavior === "reactive",
        )
      ) {
        value.sceneOnly = true;
        value.layers = value.layers.map((layer) => ({
          ...layer,
          active: false,
          reason: "No fixtures routed to audio response",
        }));
      }
      return value
        ? {
            ...value,
            savedEffect: current.profile || null,
            routing:
              (value.assignments || current.fixtures)?.map(
                ({
                  id,
                  role,
                  position,
                  raveBehavior = "reactive",
                  sceneBrightness = 10,
                  colorSlot = 0,
                  outOfSync = 0,
                }) => ({
                  id,
                  role,
                  position,
                  behavior: raveBehavior,
                  sceneBrightness,
                  colorSlot,
                  outOfSync,
                }),
              ) || [],
          }
        : null;
    },
    raveIds: () => raveContext?.fixtures.map((f) => f.id) || [],
    raveRouteIds: () => raveContext?.routedIds.slice() || [],
    raveInfo: () =>
      raveContext
        ? {
            origin: raveContext.origin,
            effect: raveContext.profile,
            timing: raveContext.lifetime.snapshot(now()),
          }
        : pendingRave
          ? {
              origin: pendingRave.origin,
              pending: true,
              effect: null,
              timing: { remainingSeconds: null },
            }
          : null,
    rave(request) {
      const revision = epoch;
      const command = ++raveRevision;
      pendingRave = { command, origin: request.origin || "viewer" };
      const task = raveQueue
        .then(() => startRave(request, revision, command))
        .finally(() => {
          if (pendingRave?.command === command) pendingRave = null;
        });
      raveQueue = task.catch(() => {});
      return task;
    },
    stopRave: (ids) => {
      raveRevision++;
      return !ids || raveContext?.fixtures.some((f) => ids.includes(f.id))
        ? stopRave()
        : Promise.resolve();
    },
    bindings: () => ({
      source: structuredClone(source),
      sources: structuredClone(sourceSlots),
      fixtures: selection.map(({ brand, ...binding }) => binding),
    }),
    activate() {
      if (closed) throw fault("music_feature_closed");
      active = true;
      return status();
    },
    async permissions(input) {
      keys(input, ["capture", "output"]);
      if (typeof input.capture !== "boolean" || typeof input.output !== "boolean")
        throw fault("invalid_music_permissions");
      return policy(() => {
        grants = { ...input };
      });
    },
    async selectSource(id) {
      if (id === null) {
        enabled();
        return policy(() => {
          source = null;
          sourceSlots = [null, null, null];
          probeApi.setPriorities?.([null, null, null]);
        });
      }
      capturePermission();
      // Reaffirming the persisted selection is not a policy change. An expired
      // discovery list or an idle app must not forget it or stop active music.
      if (source?.id === id) return status();
      const selected =
        catalog && now() <= catalog.expiresAt ? catalog.entries.find((row) => row.id === id) : null;
      if (!selected) throw fault("music_source_not_in_current_catalog");
      return policy(() => {
        source = structuredClone(selected);
        sourceSlots = [source, null, null];
        probeApi.setPriorities?.(sourceSlots.map((row) => row?.id || null));
      });
    },
    async selectSources(ids) {
      enabled();
      if (
        !Array.isArray(ids) ||
        ids.length !== 3 ||
        ids.some((id) => id !== null && typeof id !== "string") ||
        new Set(ids.filter(Boolean)).size !== ids.filter(Boolean).length
      )
        throw fault("invalid_music_source_priorities");
      if (ids.some(Boolean)) capturePermission();
      const rows = sourcePlan(
        ids.map((id) => {
          if (id === null) return null;
          const remembered = sourceSlots.find((row) => row?.id === id);
          const discovered =
            catalog && now() <= catalog.expiresAt
              ? catalog.entries.find((row) => row.id === id)
              : null;
          const selected = remembered || discovered;
          if (!selected) throw fault("music_source_not_in_current_catalog");
          return selected;
        }),
      );
      if (JSON.stringify(rows) === JSON.stringify(sourceSlots)) return status();
      return policy(() => {
        sourceSlots = rows;
        source = rows.find(Boolean) || null;
        probeApi.setPriorities?.(rows.map((row) => row?.id || null));
      });
    },
    contrast(input) {
      enabled();
      keys(input, ["percent", "fixtures"]);
      const { percent, fixtures } = input;
      const contexts = [context, raveContext].filter(Boolean);
      const reactive = (f) => !f.raveBehavior || f.raveBehavior === "reactive";
      const known = new Set(
        [...selection, ...contexts.flatMap((c) => c.fixtures || [])]
          .filter(reactive)
          .map((f) => f.id),
      );
      if (
        !Number.isInteger(percent) ||
        percent < 0 ||
        percent > 100 ||
        (fixtures !== null &&
          (!Array.isArray(fixtures) ||
            !fixtures.length ||
            fixtures.length > 64 ||
            new Set(fixtures).size !== fixtures.length ||
            fixtures.some((id) => !known.has(id))))
      )
        throw fault("invalid_music_fixture_selection");
      for (const c of contexts) c.session?.setContrast?.(fixtures, percent);
      for (const f of [...selection, ...contexts.flatMap((c) => c.fixtures || [])])
        if (reactive(f) && (fixtures === null || fixtures.includes(f.id))) f.outOfSync = percent;
      return status();
    },
    async selectFixtures(input) {
      enabled();
      const next = Array.isArray(input) && input.length === 0 ? [] : fixtureBindings(input);
      return policy(() => {
        selection = next;
      });
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      active = false;
      epoch++;
      source = null;
      sourceSlots = [null, null, null];
      catalog = null;
      selection = [];
      grants = { capture: false, output: false };
      subscribers.clear();
      shutdownPromise = Promise.all([stop("music_feature_stopped"), cancelQueries()]).then(() =>
        status(),
      );
      return shutdownPromise;
    },
    status,
  });
  return Object.freeze({ operator, client });
};
