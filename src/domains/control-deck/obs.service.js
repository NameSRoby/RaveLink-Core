/** Shared OBS owner. Event updates are cheap; screenshots are explicit and bounded. */
const fault = (code) => Object.assign(Error(code), { code });
const limitText = (value) => (typeof value === "string" && value.length <= 256 ? value : "");
module.exports = function createObs({ runtimeDir, codec, WebSocketImpl } = {}) {
  const settings = require("./obs-settings")(runtimeDir, codec),
    targets = require("./obs-targets")(runtimeDir);
  const listeners = new Set(),
    notify = () => {
      for (const fn of listeners) fn();
    };
  const cache = {
    scenes: [],
    inputs: [],
    transitions: [],
    groups: [],
    items: new Map(),
    filters: new Map(),
    audio: new Map(),
  };
  const methods = new Set(),
    timestamps = new Map(),
    flights = new Map();
  let readyBefore = false,
    refreshFlight,
    initializeFlight,
    after = 0,
    structuralTimer,
    closed = false,
    hydrating = false,
    previewFlight;
  const images = new Map();
  const connected = () => client.status().connected;
  const request = (type, data) => client.request(type, data);
  const hasRequest = (type) => methods.has(type);
  function clear() {
    cache.scenes = [];
    cache.inputs = [];
    cache.transitions = [];
    cache.groups = [];
    cache.items.clear();
    cache.filters.clear();
    cache.audio.clear();
    for (const key of [
      "program",
      "preview",
      "studio",
      "recording",
      "streaming",
      "virtualCamera",
      "replayActive",
      "collection",
      "streamTiming",
      "stats",
    ])
      delete cache[key];
    images.clear();
    timestamps.clear();
    methods.clear();
    after = 0;
  }
  function change() {
    const ready = connected();
    if (ready && !readyBefore) {
      clear();
      readyBefore = true;
      initializeFlight = initialize();
      void initializeFlight.catch(() => notify());
    } else if (!ready) readyBefore = false;
    notify();
  }
  function event(type, d) {
    if (type === "StreamStateChanged") {
      if (!d.outputActive) delete cache.streamTiming;
      else if (cache.streaming !== true)
        cache.streamTiming = {
          startedAt: Date.now(),
          durationMs: 0,
          observedAt: Date.now(),
          frames: 0,
          dropped: 0,
        };
    }
    if (type === "CurrentSceneCollectionChanging" || type === "CurrentSceneCollectionChanged") {
      cache.collection = type === "CurrentSceneCollectionChanging" ? null : d.sceneCollectionName;
      cache.items.clear();
      cache.audio.clear();
      cache.filters.clear();
    }
    const output = {
      RecordStateChanged: "recording",
      StreamStateChanged: "streaming",
      VirtualcamStateChanged: "virtualCamera",
      ReplayBufferStateChanged: "replayActive",
    };
    if (type === "CurrentProgramSceneChanged") cache.program = d.sceneName;
    else if (type === "CurrentPreviewSceneChanged") cache.preview = d.sceneName;
    else if (type === "StudioModeStateChanged") cache.studio = d.studioModeEnabled;
    else if (output[type]) cache[output[type]] = d.outputActive;
    else if (type === "InputMuteStateChanged" && cache.audio.has(d.inputName))
      cache.audio.get(d.inputName).muted = d.inputMuted;
    else if (type === "InputVolumeChanged" && cache.audio.has(d.inputName))
      cache.audio.get(d.inputName).volume = Math.min(100, Math.round(d.inputVolumeMul * 100));
    else if (type === "SceneItemEnableStateChanged") {
      for (const key of ["scene:", "group:"]) {
        const row = cache.items
          .get(key + d.sceneName)
          ?.find((r) => r.sceneItemId === d.sceneItemId);
        if (row) row.sceneItemEnabled = d.sceneItemEnabled;
      }
    } else if (type === "SourceFilterEnableStateChanged") {
      const row = cache.filters.get(d.sourceName)?.find((r) => r.filterName === d.filterName);
      if (row) row.filterEnabled = d.filterEnabled;
    } else if (
      /SceneCollection|SceneCreated|SceneRemoved|SceneNameChanged|SceneItemCreated|SceneItemRemoved|InputCreated|InputRemoved|InputNameChanged|SourceFilterCreated|SourceFilterRemoved|SourceFilterNameChanged/.test(
        type,
      )
    ) {
      clearTimeout(structuralTimer);
      structuralTimer = setTimeout(() => {
        timestamps.clear();
        void refresh(true).catch(() => {});
      }, 200);
      structuralTimer.unref?.();
    }
    notify();
  }
  const client = require("./obs-client")({ WebSocketImpl, changed: change, event });
  async function cached(key, force, work) {
    if (!connected()) throw fault("obs_not_connected");
    if (!force && Date.now() - (timestamps.get(key) || 0) < 3000) return;
    if (flights.has(key)) return flights.get(key);
    const promise = Promise.resolve()
      .then(work)
      .then(() => {
        timestamps.set(key, Date.now());
      })
      .finally(() => flights.delete(key));
    flights.set(key, promise);
    return promise;
  }
  async function sceneItems(sceneName, group = false, force = false) {
    if (!limitText(sceneName)) throw fault("obs_target_invalid");
    const key = (group ? "group:" : "scene:") + sceneName;
    await cached(key, force, async () => {
      const value = await request(group ? "GetGroupSceneItemList" : "GetSceneItemList", {
        sceneName,
      });
      cache.items.set(
        key,
        (value.sceneItems || [])
          .slice(0, 256)
          .map((r) => ({
            sourceName: limitText(r.sourceName),
            sceneItemId: r.sceneItemId,
            sceneItemEnabled: r.sceneItemEnabled === true,
            isGroup: r.isGroup === true,
            inputKind: limitText(r.inputKind),
          }))
          .filter((r) => r.sourceName && Number.isSafeInteger(r.sceneItemId)),
      );
    });
    return cache.items.get(key) || [];
  }
  async function filterList(sourceName, force = false) {
    if (!limitText(sourceName)) throw fault("obs_target_invalid");
    await cached("filters:" + sourceName, force, async () => {
      const value = await request("GetSourceFilterList", { sourceName });
      cache.filters.set(
        sourceName,
        (value.filters || [])
          .slice(0, 128)
          .map((r) => ({
            filterName: limitText(r.filterName),
            filterEnabled: r.filterEnabled === true,
          }))
          .filter((r) => r.filterName),
      );
    });
    return cache.filters.get(sourceName) || [];
  }
  async function audio(sourceName, force = false) {
    if (!limitText(sourceName)) throw fault("obs_target_invalid");
    await cached("audio:" + sourceName, force, async () => {
      const [mute, volume] = await Promise.all([
        request("GetInputMute", { inputName: sourceName }),
        request("GetInputVolume", { inputName: sourceName }),
      ]);
      if (typeof mute.inputMuted !== "boolean" || !Number.isFinite(volume.inputVolumeMul))
        throw fault("obs_audio_unavailable");
      cache.audio.set(sourceName, {
        muted: mute.inputMuted,
        volume: Math.min(100, Math.max(0, Math.round(volume.inputVolumeMul * 100))),
      });
    });
    return cache.audio.get(sourceName);
  }
  async function initialize() {
    hydrating = true;
    try {
      const v = await request("GetVersion");
      for (const name of (v.availableRequests || []).slice(0, 512))
        if (typeof name === "string") methods.add(name);
      await refresh(true);
    } finally {
      hydrating = false;
      notify();
    }
  }
  async function refreshWork() {
    const scene = await request("GetSceneList");
    cache.scenes = (scene.scenes || [])
      .slice(0, 256)
      .map((r) => ({ sceneName: limitText(r.sceneName) }))
      .filter((r) => r.sceneName);
    cache.program = limitText(scene.currentProgramSceneName);
    cache.preview = limitText(scene.currentPreviewSceneName);
    const jobs = [
      [
        "GetInputList",
        (v) => {
          cache.inputs = (v.inputs || [])
            .slice(0, 256)
            .map((r) => ({ inputName: limitText(r.inputName), inputKind: limitText(r.inputKind) }))
            .filter((r) => r.inputName);
        },
      ],
      [
        "GetSceneCollectionList",
        (v) => {
          cache.collection = limitText(v.currentSceneCollectionName);
        },
      ],
      [
        "GetGroupList",
        (v) => {
          cache.groups = (v.groups || []).slice(0, 256).map(limitText).filter(Boolean);
        },
      ],
      [
        "GetStudioModeEnabled",
        (v) => {
          cache.studio = v.studioModeEnabled;
        },
      ],
      [
        "GetStreamStatus",
        (v) => {
          cache.streaming = v.outputActive;
          if (v.outputActive && Number.isFinite(v.outputDuration))
            cache.streamTiming = {
              startedAt: Date.now() - v.outputDuration,
              durationMs: v.outputDuration,
              observedAt: Date.now(),
              dropped: v.outputSkippedFrames || 0,
              frames: v.outputTotalFrames || 0,
              reconnecting: v.outputReconnecting === true,
            };
          else if (!v.outputActive) delete cache.streamTiming;
        },
      ],
      [
        "GetStats",
        (v) => {
          cache.stats = {
            fps: Number(v.activeFps) || 0,
            cpu: Number(v.cpuUsage) || 0,
            renderSkipped: Number(v.renderSkippedFrames) || 0,
            outputSkipped: Number(v.outputSkippedFrames) || 0,
          };
        },
      ],
      [
        "GetRecordStatus",
        (v) => {
          cache.recording = v.outputActive;
        },
      ],
      [
        "GetVirtualCamStatus",
        (v) => {
          cache.virtualCamera = v.outputActive;
        },
      ],
      [
        "GetReplayBufferStatus",
        (v) => {
          cache.replayActive = v.outputActive;
        },
      ],
      [
        "GetSceneTransitionList",
        (v) => {
          cache.transitions = (v.transitions || []).slice(0, 64).map((r) => ({
            transitionName: limitText(r.transitionName),
            transitionFixed: r.transitionFixed === true,
          }));
        },
      ],
    ].filter(([type]) => hasRequest(type));
    for (let i = 0; i < jobs.length; i += 3)
      await Promise.all(
        jobs.slice(i, i + 3).map(async ([type, apply]) => {
          try {
            apply(await request(type));
          } catch {}
        }),
      );
    const targetsToRead = [...targets.rows.values()];
    for (let i = 0; i < targetsToRead.length; i += 3)
      await Promise.all(
        targetsToRead.slice(i, i + 3).map(async (t) => {
          try {
            if (t.kind.startsWith("source-"))
              await require("./obs-visibility")({ cache, sceneItems }).read(t);
            else if (t.kind.startsWith("filter-")) await filterList(t.sourceName);
            else if (["mute-toggle", "mute", "unmute", "volume"].includes(t.kind))
              await audio(t.sourceName);
          } catch {
            if (t.kind.startsWith("source-"))
              cache.items.delete((t.group ? "group:" : "scene:") + t.sceneName);
            if (t.kind.startsWith("filter-")) cache.filters.delete(t.sourceName);
            if (["mute-toggle", "mute", "unmute", "volume"].includes(t.kind))
              cache.audio.delete(t.sourceName);
          }
        }),
      );
    after = Date.now() + 15000;
    notify();
  }
  function refresh(force = false) {
    if (closed || !connected() || (!force && Date.now() < after)) return Promise.resolve();
    if (!refreshFlight)
      refreshFlight = refreshWork().finally(() => {
        refreshFlight = null;
      });
    return refreshFlight;
  }
  const actions = require("./obs-actions")({
    targets,
    request,
    sceneItems,
    filterList,
    audio,
    cache,
    connected,
    hasRequest,
    refresh,
    notify,
  });
  function snapshot() {
    return {
      connection: { ...settings.publicValue(), ...client.status(), loading: hydrating },
      scenes: cache.scenes,
      inputs: cache.inputs,
      transitions: cache.transitions,
      groups: cache.groups,
      program: cache.program,
      preview: cache.preview,
      studio: cache.studio,
      recording: cache.recording,
      streaming: cache.streaming,
      streamTiming: cache.streamTiming,
      stats: cache.stats,
      collection: cache.collection,
      requests: [...methods].filter((name) => /^(?:Set|Toggle|Trigger|Save)/.test(name)),
    };
  }
  async function screenshot(sceneName) {
    if (!connected() || !cache.scenes.some((s) => s.sceneName === sceneName))
      throw fault("obs_scene_missing");
    if (!hasRequest("GetSourceScreenshot")) throw fault("obs_preview_unavailable");
    const prior = images.get(sceneName);
    if (prior && Date.now() - prior.at < 3000) return prior.image;
    if (previewFlight) throw fault("obs_preview_busy");
    previewFlight = request("GetSourceScreenshot", {
      sourceName: sceneName,
      imageFormat: "jpg",
      imageWidth: 320,
      imageHeight: 180,
      imageCompressionQuality: 55,
    });
    try {
      const v = await previewFlight;
      if (
        typeof v.imageData !== "string" ||
        v.imageData.length > 524288 ||
        !/^data:image\/jpe?g;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(v.imageData)
      )
        throw fault("obs_preview_invalid");
      const image = v.imageData.replace(/^data:image\/jpg;/, "data:image/jpeg;");
      images.set(sceneName, { at: Date.now(), image });
      while (images.size > 16) images.delete(images.keys().next().value);
      return image;
    } finally {
      previewFlight = null;
    }
  }
  const initial = settings.connection();
  if (initial.enabled)
    queueMicrotask(() => {
      if (!closed) void client.connect(initial).catch(() => {});
    });
  return {
    snapshot,
    catalog: actions.catalog,
    execute: actions.execute,
    refresh,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async configure(input) {
      settings.save(input);
      client.disconnect();
      clear();
      if (input.enabled) {
        await client.connect(settings.connection());
        await initializeFlight;
      }
      return snapshot();
    },
    async browse({ kind, name, group = false }) {
      if (kind === "scene") return { items: await sceneItems(name, group), sceneName: name, group };
      if (kind === "filters") return { filters: await filterList(name), sourceName: name };
      if (kind === "audio") return { ...(await audio(name)), sourceName: name };
      throw fault("obs_target_invalid");
    },
    async add(target) {
      const normalized = require("./obs-targets").normalize(target);
      if (!connected()) throw fault("obs_not_connected");
      if (
        (normalized.sceneName || normalized.sourceName || normalized.transitionName) &&
        cache.collection
      )
        normalized.collectionName = cache.collection;
      if (normalized.kind.startsWith("source-")) {
        if (
          !(await require("./obs-visibility")({ cache, sceneItems }).read(normalized, true)).length
        )
          throw fault("obs_source_missing");
      } else if (normalized.kind.startsWith("filter-")) {
        if (
          !(await filterList(normalized.sourceName, true)).some(
            (r) => r.filterName === normalized.filterName,
          )
        )
          throw fault("obs_filter_missing");
      } else if (["mute-toggle", "mute", "unmute", "volume"].includes(normalized.kind))
        await audio(normalized.sourceName, true);
      else if (
        ["scene", "preview"].includes(normalized.kind) &&
        !cache.scenes.some((r) => r.sceneName === normalized.sceneName)
      )
        throw fault("obs_scene_missing");
      const row = targets.add(normalized);
      notify();
      return { ...row, action: actions.catalog().find((a) => a.id === row.id) };
    },
    screenshot,
    close() {
      closed = true;
      clearTimeout(structuralTimer);
      client.close();
      listeners.clear();
    },
  };
};
