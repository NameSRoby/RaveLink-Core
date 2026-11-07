/** Existing service owners remain responsible for permission checks, routes,
 * moderation and output restoration. A deck never acquires new permissions. */
const { fault } = require("./control-deck-config");
const empty = { type: "object", additionalProperties: false, properties: {} };
const object = (properties, required = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
module.exports = function actions({
  core,
  music,
  getFeatures = () => null,
  getMediaController = () => null,
  getMods = () => null,
  getRewards = () => null,
  desktop,
  obs,
  widgets,
}) {
  const feedback = new Map(),
    reads = new Map();
  const listeners = new Set();
  const feedbackEpoch = new Map();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  let primaryFlight = null,
    fullRefreshFlight = null;
  let songState = null,
    playerState = {},
    songReadAt = 0,
    songRead = null,
    refreshFlight = null,
    modCursor = 0;
  const activeFeature = (id) =>
    getFeatures()
      ?.list()
      .features?.some((p) => p.id === id && p.lifecycle === "active");
  function feature(capability, method, payload) {
    if (!activeFeature("song-request")) throw fault("control_deck_action_unavailable");
    return getFeatures().request("song-request", capability, method, payload, { timeoutMs: 5000 });
  }
  const pauseActions = require("./control-deck-pause-actions")({
    feature,
    getRewards,
    activeFeature,
  });
  const musicActions = require("./control-deck-music-actions")({ music });
  const playerTransport = require("./player-transport")({
    feature,
    getController: getMediaController,
    getState: () => ({ players: playerState, song: songState }),
  });
  const songVolume = require("./song-volume")({
    feature,
    desktop,
    getState: () => ({ players: playerState, song: songState }),
  });
  function catalog() {
    const volumeRoute = songVolume.describe();
    const song = Boolean(activeFeature("song-request")),
      ownerToggles = pauseActions.catalog(),
      playbackState = ownerToggles.find((action) => action.id === "song.playback-toggle").state;
    const profiles = core.lightingProfiles.snapshot().profiles;
    const fixtureIds = (core.fixtureRegistry?.listEngineBy?.() || []).map((fixture) => fixture.id);
    const row = (
      id,
      label,
      group,
      symbol,
      available = true,
      parameters = empty,
      defaults = {},
      extra = {},
    ) => ({
      id,
      label,
      group,
      symbol,
      available,
      parameters,
      defaults,
      description: label,
      ...extra,
    });
    const list = [
      ...require("./profile-actions")(profiles),
      ...musicActions.catalog(),
      row("song.pause", "Pause song requests", "Song Request", "Ⅱ", song),
      row("song.resume", "Resume song requests", "Song Request", "▶", song),
      row("song.skip", "Skip current request", "Song Request", "⏭", song),
      row(
        "song.playback-pause",
        "Pause playback",
        "Song Request",
        "Ⅱ",
        song,
        empty,
        {},
        { state: playbackState },
      ),
      row(
        "song.playback-resume",
        "Resume playback",
        "Song Request",
        "▶",
        song,
        empty,
        {},
        {
          state: playbackState,
        },
      ),
      row(
        "song.volume",
        "Player volume",
        "Song Request",
        "◕",
        song && (!volumeRoute || volumeRoute.available),
        object({ level: { type: "integer", minimum: 0, maximum: 100 } }, ["level"]),
        { level: 100 },
        {
          control: { type: "slider", parameter: "level", min: 0, max: 100, step: 1 },
          nativeProvider: playerState["song.player.preferences.v1"]?.player || "",
          nativeTarget: volumeRoute?.target || "",
          state: volumeRoute?.level ?? songState?.queue?.volume?.control ?? null,
          description:
            "Uses the player's configured output range and existing native/embedded volume owner.",
        },
      ),
      row(
        "song.ban-current",
        "Ban current song",
        "Song Request",
        "⊘",
        song,
        empty,
        {},
        {
          description:
            "Ban the exact current recording from song requests using the existing player moderation controls.",
        },
      ),
      row(
        "song.ban-requester",
        "Ban current requester",
        "Song Request",
        "⊗",
        song,
        empty,
        {},
        {
          description:
            "Block the recorded requester from song requests and remove their pending songs. No guessed user identity.",
        },
      ),
      row(
        "rewards.pause",
        "Pause managed rewards",
        "Twitch rewards",
        "Ⅱ",
        Boolean(getRewards()),
        object({
          purpose: {
            type: "string",
            enum: ["all", "lights", "teach", "song_request", "add_to_playlist"],
          },
        }),
        { purpose: "all" },
      ),
      row(
        "rewards.resume",
        "Resume managed rewards",
        "Twitch rewards",
        "▶",
        Boolean(getRewards()),
        object({
          purpose: {
            type: "string",
            enum: ["all", "lights", "teach", "song_request", "add_to_playlist"],
          },
        }),
        { purpose: "all" },
      ),
      row(
        "lighting.color",
        "Set room color / brightness",
        "Lighting",
        "◉",
        true,
        object({ text: { type: "string", minLength: 1, maxLength: 256 } }, ["text"]),
        { text: "blue 50%" },
        {
          description:
            "Use the same color or brightness command as direct light controls. Existing fixture permissions and ownership apply.",
        },
      ),
      row(
        "lighting.profile",
        "Apply lighting profile",
        "Lighting",
        "▦",
        profiles.length > 0,
        object({ id: { type: "string", enum: profiles.map((p) => p.id), maxLength: 64 } }, ["id"]),
        { id: profiles[0]?.id || "" },
      ),
      row(
        "light.static",
        "Set light color and brightness",
        "Lighting",
        "◉",
        fixtureIds.length > 0,
        object(
          {
            scope: { type: "string", enum: ["all", "fixture"] },
            fixtureId: {
              type: "string",
              maxLength: 64,
              ...(fixtureIds.length ? { enum: fixtureIds } : {}),
            },
            color: { type: "string", minLength: 7, maxLength: 7 },
            brightness: { type: "integer", minimum: 0, maximum: 100 },
          },
          ["scope", "color", "brightness"],
        ),
        { scope: "all", color: "#8b001f", brightness: 75 },
        {
          description:
            "Set all enabled lights or one saved fixture through the existing manual lighting owner.",
        },
      ),
    ];
    for (const [id, label, symbol, navigation] of [
      [
        "view.music",
        "Music-to-Light",
        "♫",
        { tab: "lights", lightTab: "music", musicView: "play" },
      ],
      ["view.fixtures", "Fixtures", "☼", { tab: "fixtures" }],
      ["view.song", "Song Request", "♫", { featureId: "song-request", pageId: "player" }],
      [
        "view.overlay",
        "Overlay designer",
        "▣",
        { featureId: "song-request", pageId: "overlay-editor" },
      ],
      ["view.mods", "Mods & custom actions", "✦", { tab: "mods" }],
      ["view.rewards", "Reward controls", "◈", { panel: "rewards" }],
      ["view.lights-controls", "Quick light controls", "☼", { panel: "lights" }],
      ["view.windows", "Windows controls", "\u229e", { panel: "windows" }],
      ["view.lights", "Lights workspace", "☼", { tab: "lights" }],
    ])
      list.push(
        row(
          id,
          label,
          "Workspaces",
          symbol,
          navigation.panel === "windows"
            ? Boolean(desktop?.audioStatus)
            : !navigation.featureId || song,
          empty,
          {},
          { kind: "navigation", navigation },
        ),
      );
    list.push(
      ...ownerToggles,
      ...playerTransport.catalog(),
      ...(desktop?.catalog() || []),
      ...(obs?.catalog() || []),
      ...(widgets?.catalog() || []),
    );
    list.push(
      row(
        "view.obs",
        "OBS controls",
        "OBS",
        "\u25a3",
        Boolean(obs),
        empty,
        {},
        {
          kind: "navigation",
          navigation: { panel: "obs" },
          description:
            "Connect OBS and build your own scene, camera, microphone and filter buttons.",
        },
      ),
    );
    for (const mod of [...(getMods()?.list().mods || [])].sort(
      (a, b) => Number(b.lifecycle === "active") - Number(a.lifecycle === "active"),
    ))
      for (const action of mod.actions || []) {
        if (list.length >= 256) break;
        list.push({
          id: `mod:${mod.id}:${action.id}`,
          label: action.title,
          description: action.description || mod.name,
          group: `Mod · ${mod.name}`,
          symbol: action.symbol || "✦",
          stateful: Boolean(action.stateMethod),
          available:
            mod.lifecycle === "active" &&
            feedback.get(`mod:${mod.id}:${action.id}`)?.available !== false,
          parameters: action.parameters || empty,
          defaults: action.defaults || {},
          state: feedback.get(`mod:${mod.id}:${action.id}`) || null,
        });
      }
    return list;
  }
  async function execute(id, params, signal) {
    if (signal.aborted) throw fault("control_deck_cancelled");
    if (["stream.timestamp", "stream.marker"].includes(id))
      return widgets.execute(id, params, signal);
    if (id.startsWith("obs:")) return obs.execute(id, params, signal);
    if (musicActions.handles(id)) return musicActions.execute(id, params, signal);
    if (pauseActions.handles(id)) return pauseActions.execute(id, signal);
    if (playerTransport.handles(id)) return playerTransport.execute(id, signal);
    if (id.startsWith("native.")) return desktop.execute(id, params, signal);
    if (id.startsWith("mod:")) {
      const [, modId, actionId] = id.split(":");
      feedbackEpoch.set(id, (feedbackEpoch.get(id) || 0) + 1);
      const result = await getMods().invokeAction(modId, actionId, params, {
        timeoutMs: 8000,
        signal,
      });
      if (result?.ok && !(result.value?.feedback || result.feedback)) {
        const confirmed = await getMods().readActionState?.(modId, actionId);
        rememberFeedback(id, confirmed);
      } else rememberFeedback(id, result);
      reads.set(id, { at: Date.now() });
      changed();
      return result;
    }
    if (id.startsWith("view.")) return { ok: true };
    if (["rewards.pause", "rewards.resume"].includes(id)) {
      const result = await getRewards().update({
        purpose: params.purpose || "all",
        paused: id === "rewards.pause",
      });
      if (result.partial) throw fault("control_deck_action_partial");
      return result;
    }
    if (id === "light.static") {
      if (
        !params ||
        !["all", "fixture"].includes(params.scope) ||
        !/^#[0-9a-f]{6}$/i.test(params.color) ||
        !Number.isInteger(params.brightness) ||
        params.brightness < 0 ||
        params.brightness > 100 ||
        (params.scope === "fixture" &&
          !core.fixtureRegistry
            ?.listEngineBy?.()
            .some((fixture) => fixture.id === params.fixtureId))
      )
        throw fault("control_deck_light_target_invalid");
      return core.colorCommandService.applyColorText(`${params.color} ${params.brightness}%`, {
        mode: "direct",
        target: "both",
        targetExplicit: true,
        ...(params.scope === "fixture" ? { fixtureId: params.fixtureId } : {}),
      });
    }
    if (id === "lighting.color") return core.colorCommandService.applyColorText(params.text, {});
    if (id === "lighting.profile") return core.lightingProfiles.apply(params.id);
    if (id.startsWith("lighting.profile:"))
      return core.lightingProfiles.apply(id.slice("lighting.profile:".length));
    if (["song.pause", "song.resume"].includes(id))
      return feature("song.queue.admin.v1", "moderate", { action: id.split(".")[1] });
    if (id === "song.volume") return songVolume.execute(params.level, signal);
    if (["song.playback-pause", "song.playback-resume"].includes(id))
      return feature("song.queue.admin.v1", "moderate", {
        action: id.split("-").at(-1),
        operatorPlayback: true,
      });
    if (["song.ban-current", "song.ban-requester"].includes(id)) {
      const selected = await feature("song.player.preferences.v1", "status", null);
      if (!selected.ok) throw fault("song_player_unavailable");
      const provider = selected.value?.player;
      const capability =
        provider === "tidal"
          ? "song.tidal.experimental.v1"
          : provider === "spotify"
            ? "song.spotify.player.v1"
            : provider === "youtube" && selected.value?.youtubePlayback === "browser"
              ? "song.youtube.browser.v1"
              : null;
      const state = await feature(capability || "song.playback.read.v1", "status", null);
      const current = capability ? state.value?.current : state.value?.managed;
      if (!state.ok || !current || (capability && !current.uid))
        throw fault("song_request_not_playing");
      let payload;
      if (id === "song.ban-current") {
        if (capability) payload = { action: "block_song", provider, currentUid: current.uid };
        else {
          const candidate = current.candidate;
          if (!candidate?.providerItemId) throw fault("song_identity_unavailable");
          payload = {
            action: "block_song",
            provider: candidate.provider,
            providerItemId: candidate.providerItemId,
          };
        }
      } else {
        if (!current.requesterKey) throw fault("song_requester_unknown");
        payload = {
          action: "block",
          provider,
          requesterKey: current.requesterKey,
          removePending: true,
          ...(capability ? { currentUid: current.uid } : {}),
        };
      }
      return feature("song.queue.admin.v1", "moderate", payload);
    }
    if (id === "song.skip") {
      const playback = await feature("song.playback.read.v1", "status", null);
      const entryId = playback.value?.managed?.entryId;
      if (!playback.ok || !entryId) throw fault("song_request_not_playing");
      return feature("song.queue.admin.v1", "moderate", { action: "skip", entryId });
    }
    throw fault("control_deck_action_unavailable");
  }
  async function refreshPrimary() {
    void obs?.refresh?.().catch(() => {});
    const calls = new Map();
    const reader = (capability, method, payload) => {
      const key = JSON.stringify([capability, method, payload]);
      if (!calls.has(key))
        calls.set(
          key,
          Promise.resolve()
            .then(() => feature(capability, method, payload))
            .then((reply) => {
              if (reply.ok && method === "status") playerState[capability] = reply.value;
              return reply;
            }),
        );
      return calls.get(key);
    };
    const owners = Promise.all([pauseActions.refresh(false, reader), desktop?.refresh?.()]);
    if (activeFeature("song-request") && !songRead && Date.now() - songReadAt >= 1000) {
      songRead = Promise.all([
        reader("song.queue.read.v1", "status", { limit: 5, playlistLimit: 1, moderationLimit: 1 }),
        reader("song.playback.read.v1", "status", null),
      ])
        .then(([queue, playback]) => {
          songState =
            queue.ok && playback.ok ? { queue: queue.value, playback: playback.value } : null;
        })
        .catch(() => {
          songState = null;
        })
        .finally(() => {
          songReadAt = Date.now();
          songRead = null;
        });
    }
    if (songRead) await songRead;
    await owners;
    if (!activeFeature("song-request")) {
      songState = null;
      playerState = {};
    }
    changed();
  }
  function rememberFeedback(key, result) {
    const state = result?.ok ? result.value?.feedback || result.feedback : null;
    if (
      state &&
      typeof (state.label || state.text) === "string" &&
      (state.label || state.text).length <= 80 &&
      /^[a-z0-9_-]{1,32}$/.test(state.state || state.tone || "")
    )
      feedback.set(key, {
        text: state.label || state.text,
        tone: state.state || state.tone,
        active: state.active === true,
        ...(typeof state.available === "boolean" ? { available: state.available } : {}),
        ...(Number.isSafeInteger(state.completedAt) &&
        state.completedAt >= 0 &&
        state.completedAt <= Date.now()
          ? { completedAt: state.completedAt }
          : {}),
        ...(typeof state.jobId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(state.jobId)
          ? { jobId: state.jobId }
          : {}),
        ...(typeof state.color === "string" && /^#[0-9a-f]{6}$/i.test(state.color)
          ? { color: state.color }
          : {}),
      });
    else feedback.delete(key);
  }
  async function refreshWork() {
    const registry = getMods();
    if (!registry?.readActionState) return;
    const jobs = [],
      modReads = new Map(),
      candidates = registry
        .list()
        .mods.filter((mod) => mod.lifecycle === "active")
        .flatMap((mod) =>
          (mod.actions || [])
            .filter((action) => action.stateMethod)
            .map((action) => ({ mod, action })),
        );
    const start = modCursor % Math.max(1, candidates.length);
    for (let offset = 0; offset < candidates.length && jobs.length < 8; offset++) {
      const { mod, action } = candidates[(start + offset) % candidates.length];
      modCursor = (start + offset + 1) % candidates.length;
      const key = `mod:${mod.id}:${action.id}`,
        prior = reads.get(key);
      const epoch = feedbackEpoch.get(key) || 0;
      if (prior?.promise) {
        jobs.push(prior.promise);
        continue;
      }
      if (prior && Date.now() - prior.at < (feedback.get(key)?.available === false ? 5000 : 1500))
        continue;
      // A mod may permit only one external call. Queue its passive reads rather
      // than exhausting its worker slots and cancelling the desktop helper.
      const promise = (modReads.get(mod.id) || Promise.resolve())
        .then(() => registry.readActionState(mod.id, action.id))
        .then((result) => {
          if (
            !registry.list().mods.some((row) => row.id === mod.id && row.lifecycle === "active")
          ) {
            feedback.delete(key);
            return;
          }
          if ((feedbackEpoch.get(key) || 0) !== epoch) return;
          rememberFeedback(key, result);
          changed();
        })
        .catch(() => feedback.delete(key))
        .finally(() => {
          reads.set(key, { at: Date.now() });
        });
      reads.set(key, { at: Date.now(), promise });
      modReads.set(mod.id, promise);
      jobs.push(promise);
    }
    const active = new Set(candidates.map(({ mod, action }) => `mod:${mod.id}:${action.id}`));
    for (const key of new Set([...feedback.keys(), ...reads.keys()]))
      if (!active.has(key)) {
        feedback.delete(key);
        reads.delete(key);
      }
    await Promise.allSettled(jobs);
  }
  function refresh() {
    if (!refreshFlight)
      refreshFlight = refreshWork().finally(() => {
        refreshFlight = null;
      });
    return refreshFlight;
  }
  function refreshLive() {
    if (!primaryFlight)
      primaryFlight = refreshPrimary().finally(() => {
        primaryFlight = null;
      });
    void refresh().catch(() => {});
    return primaryFlight;
  }
  function refreshAll() {
    if (!fullRefreshFlight)
      fullRefreshFlight = Promise.all([refreshLive(), refresh()]).finally(() => {
        fullRefreshFlight = null;
      });
    return fullRefreshFlight;
  }
  return {
    subscribe(listener) {
      listeners.add(listener);
      const off = obs?.subscribe?.(listener);
      const widgetOff = widgets?.subscribe?.(listener);
      return () => {
        listeners.delete(listener);
        off?.();
        widgetOff?.();
      };
    },
    windowsAudio: () => desktop?.audioSnapshot?.(),
    mediaSnapshot: () => {
      const selectedPlayer = playerState["song.player.preferences.v1"]?.player;
      const cap = { tidal: "song.tidal.experimental.v1", spotify: "song.spotify.player.v1" }[
        selectedPlayer
      ];
      return songState
        ? { ...songState, selectedPlayer, nativeStatus: playerState[cap] || null }
        : null;
    },
    refreshLive,
    catalog,
    execute,
    refresh: refreshAll,
    feedback: () => Object.fromEntries(feedback),
    guidance: () =>
      getMods()
        ? "Install and approve a mod that contributes button actions to add your own functions."
        : "The mod host is not enabled. Enable Mod support in Setup (or use the combined source profile), then install and approve your custom-action mod. Existing buttons continue to work.",
  };
};
