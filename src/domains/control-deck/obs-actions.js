/** Each toggle rereads OBS before changing it; source visibility is per scene item. */
const fault = (code) => Object.assign(Error(code), { code });
module.exports = function obsActions({
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
}) {
  const title = require("./obs-targets").title;
  const visibility = require("./obs-visibility")({ cache, sceneItems });
  const symbols = {
    scene: "\u25a3",
    preview: "\u25a3",
    "source-toggle": "\ud83d\udcf7",
    "source-show": "\ud83d\udcf7",
    "source-hide": "\ud83d\udcf7",
    "mute-toggle": "\ud83c\udf99",
    mute: "\ud83c\udf99",
    unmute: "\ud83c\udf99",
    volume: "\u25d5",
    "record-toggle": "\u23fa",
    "stream-toggle": "\u25c9",
  };
  function present(t) {
    if (t.collectionName && t.collectionName !== cache.collection) return false;
    if (["scene", "preview"].includes(t.kind))
      return cache.scenes.some((r) => r.sceneName === t.sceneName);
    if (t.kind.startsWith("source-")) return visibility.cached(t).length > 0;
    if (t.kind.startsWith("filter-"))
      return cache.filters.get(t.sourceName)?.some((r) => r.filterName === t.filterName);
    if (["mute-toggle", "mute", "unmute", "volume"].includes(t.kind))
      return cache.audio.has(t.sourceName);
    return true;
  }
  function state(t) {
    if (connected() && !present(t))
      return {
        active: false,
        tone: "unknown",
        text:
          t.collectionName && t.collectionName !== cache.collection
            ? "Different OBS collection"
            : "Target missing in OBS",
      };
    let active, level;
    if (["scene", "preview"].includes(t.kind))
      active = (t.kind === "scene" ? cache.program : cache.preview) === t.sceneName;
    else if (t.kind.startsWith("source-")) {
      const rows = visibility.cached(t);
      active = rows.length ? rows.every((r) => r.sceneItemEnabled) : undefined;
      if (rows.some((r) => r.sceneItemEnabled) && !active)
        return { active: false, tone: "paused", text: "Mixed visibility" };
    } else if (t.kind.startsWith("filter-"))
      active = cache.filters
        .get(t.sourceName)
        ?.find((r) => r.filterName === t.filterName)?.filterEnabled;
    else if (["mute-toggle", "mute", "unmute", "volume"].includes(t.kind)) {
      const input = cache.audio.get(t.sourceName);
      active = input ? !input.muted : undefined;
      level = input?.volume;
    } else
      active = {
        "studio-toggle": cache.studio,
        "record-toggle": cache.recording,
        "stream-toggle": cache.streaming,
        "virtualcam-toggle": cache.virtualCamera,
      }[t.kind];
    const isAudio = ["mute-toggle", "mute", "unmute", "volume"].includes(t.kind);
    return {
      active: connected() && active === true,
      tone: !connected() || active === undefined ? "unknown" : active ? "active" : "inactive",
      text: !connected()
        ? "Connect OBS"
        : t.kind === "volume" && level !== undefined
          ? level + "%"
          : active === undefined
            ? t.kind === "replay-save"
              ? "Save replay"
              : t.kind === "transition"
                ? "Transition"
                : t.kind === "transition-choice"
                  ? "Choose transition"
                  : "State unavailable"
            : isAudio
              ? active
                ? "Audio on"
                : "Muted"
              : t.kind === "scene"
                ? active
                  ? "On air"
                  : "Ready"
                : t.kind === "preview"
                  ? active
                    ? "In preview"
                    : "Ready"
                  : t.kind.startsWith("source-")
                    ? active
                      ? "Visible"
                      : "Hidden"
                    : active
                      ? "On"
                      : "Off",
      ...(level !== undefined ? { value: level } : {}),
    };
  }
  const methods = {
    scene: "SetCurrentProgramScene",
    preview: "SetCurrentPreviewScene",
    "source-toggle": "SetSceneItemEnabled",
    "source-show": "SetSceneItemEnabled",
    "source-hide": "SetSceneItemEnabled",
    "mute-toggle": "SetInputMute",
    mute: "SetInputMute",
    unmute: "SetInputMute",
    volume: "SetInputVolume",
    "filter-toggle": "SetSourceFilterEnabled",
    "filter-enable": "SetSourceFilterEnabled",
    "filter-disable": "SetSourceFilterEnabled",
    "studio-toggle": "SetStudioModeEnabled",
    transition: "TriggerStudioModeTransition",
    "transition-choice": "SetCurrentSceneTransition",
    "record-toggle": "ToggleRecord",
    "stream-toggle": "ToggleStream",
    "virtualcam-toggle": "ToggleVirtualCam",
    "replay-save": "SaveReplayBuffer",
  };
  function catalog() {
    return [...targets.rows].map(([id, t]) => ({
      id,
      label: title(t),
      group: "OBS",
      symbol: symbols[t.kind] || "\u25c8",
      available:
        connected() &&
        present(t) &&
        hasRequest(methods[t.kind]) &&
        (!["preview", "transition"].includes(t.kind) || cache.studio === true) &&
        (t.kind !== "replay-save" || cache.replayActive === true),
      description: t.kind.startsWith("source-")
        ? t.scope === "all"
          ? "Show/hide every instance across all scenes and groups. A hidden camera remains connected."
          : "Show/hide this source in its selected scene. A hidden camera remains connected."
        : "Confirmed by OBS. Adding or editing this button does not run it.",
      parameters:
        t.kind === "volume"
          ? {
              type: "object",
              additionalProperties: false,
              properties: { level: { type: "integer", minimum: 0, maximum: 100 } },
              required: ["level"],
            }
          : { type: "object", additionalProperties: false, properties: {} },
      defaults: t.kind === "volume" ? { level: cache.audio.get(t.sourceName)?.volume ?? 100 } : {},
      ...(t.kind === "volume"
        ? { control: { type: "slider", parameter: "level", min: 0, max: 100, step: 1 } }
        : {}),
      state: state(t),
      stateful: !["transition", "transition-choice", "replay-save"].includes(t.kind),
    }));
  }
  let chain = Promise.resolve();
  async function perform(id, params, signal) {
    const t = targets.rows.get(id);
    if (!t || !connected()) throw fault("obs_not_connected");
    const check = () => {
      if (signal?.aborted) throw fault("control_deck_cancelled");
      if (!connected()) throw fault("obs_not_connected");
      if (t.collectionName && t.collectionName !== cache.collection)
        throw fault("obs_collection_changed");
    };
    const call = (type, data) => {
      check();
      return request(type, data);
    };
    check();
    if (["scene", "preview"].includes(t.kind)) {
      if (!cache.scenes.some((s) => s.sceneName === t.sceneName)) throw fault("obs_scene_missing");
      if (t.kind === "preview" && !cache.studio) throw fault("obs_studio_mode_required");
      await call(methods[t.kind], { sceneName: t.sceneName });
    } else if (t.kind.startsWith("source-")) {
      const rows = await visibility.read(t, true);
      if (!rows.length) throw fault("obs_source_missing");
      const enabled =
        t.kind === "source-toggle"
          ? !rows.every((r) => r.sceneItemEnabled)
          : t.kind === "source-show";
      for (const row of rows)
        await call("SetSceneItemEnabled", {
          sceneName: row.sceneName,
          sceneItemId: row.sceneItemId,
          sceneItemEnabled: enabled,
        });
      await visibility.read(t, true);
    } else if (t.kind.startsWith("filter-")) {
      const row = (await filterList(t.sourceName, true)).find((r) => r.filterName === t.filterName);
      if (!row) throw fault("obs_filter_missing");
      await call("SetSourceFilterEnabled", {
        sourceName: t.sourceName,
        filterName: t.filterName,
        filterEnabled: t.kind === "filter-toggle" ? !row.filterEnabled : t.kind === "filter-enable",
      });
      await filterList(t.sourceName, true);
    } else if (["mute-toggle", "mute", "unmute", "volume"].includes(t.kind)) {
      const prior = await audio(t.sourceName, true);
      if (t.kind === "volume") {
        if (!Number.isInteger(params.level) || params.level < 0 || params.level > 100)
          throw fault("obs_volume_invalid");
        await call("SetInputVolume", {
          inputName: t.sourceName,
          inputVolumeMul: params.level / 100,
        });
      } else
        await call("SetInputMute", {
          inputName: t.sourceName,
          inputMuted: t.kind === "mute-toggle" ? !prior.muted : t.kind === "mute",
        });
      await audio(t.sourceName, true);
    } else if (t.kind === "studio-toggle") {
      const current = await call("GetStudioModeEnabled");
      await call("SetStudioModeEnabled", { studioModeEnabled: !current.studioModeEnabled });
    } else if (t.kind === "transition-choice") {
      if (!cache.transitions.some((row) => row.transitionName === t.transitionName))
        throw fault("obs_transition_missing");
      await call("SetCurrentSceneTransition", { transitionName: t.transitionName });
      if (hasRequest("SetCurrentSceneTransitionDuration")) {
        const current = hasRequest("GetCurrentSceneTransition")
          ? await call("GetCurrentSceneTransition")
          : { transitionFixed: true };
        if (current.transitionFixed === false)
          await call("SetCurrentSceneTransitionDuration", { transitionDuration: t.duration });
      }
    } else await call(methods[t.kind]);
    if (
      !t.kind.startsWith("source-") &&
      !t.kind.startsWith("filter-") &&
      !["mute-toggle", "mute", "unmute", "volume"].includes(t.kind)
    )
      await refresh(true);
    notify();
    return { ok: true };
  }
  return {
    catalog,
    execute(id, params, signal) {
      const work = chain.catch(() => {}).then(() => perform(id, params, signal));
      chain = work;
      return work;
    },
  };
};
