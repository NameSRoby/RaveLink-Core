/** Shared status sources. No timer or account polling until a visible deck asks. */
module.exports = function deckWidgets({
  runtimeDir,
  getProvider = () => null,
  getMedia = () => null,
  getObs = () => null,
  getRewards = () => null,
  now = Date.now,
}) {
  const listeners = new Set(),
    notify = () => {
      for (const fn of listeners) fn();
    };
  const media = () => require("./deck-media-status")(getMedia());
  let twitch = { connected: false, stream: null, followers: null, subscribers: null, clips: null },
    rewards = null,
    after = 0,
    rewardsAfter = 0,
    flight,
    requested = new Set(),
    authKey = "",
    closed = false,
    lastReadAt = 0;
  function providerStatus() {
    const provider = getProvider(),
      auth = provider?.status();
    const key = JSON.stringify([auth?.connected, auth?.userId, auth?.scopes]);
    if (key !== authKey) {
      authKey = key;
      after = 0;
      twitch = {
        connected: !!auth?.connected,
        stream: null,
        followers: null,
        subscribers: null,
        clips: null,
      };
    }
    return { provider, auth };
  }
  async function readTwitch(force = false, streamOnly = false) {
    const { provider, auth } = providerStatus();
    if (!provider || !auth?.connected) {
      twitch.connected = false;
      return;
    }
    if (!force && now() < after) return;
    twitch.connected = true;
    twitch.scopes = auth.scopes || [];
    after = now() + 30000;
    try {
      const needsClips = requested.has("clips");
      const jobs = [];
      if (
        force ||
        ["stream", "viewers", "audience", "clips", "markers"].some((t) => requested.has(t))
      )
        jobs.push(["stream", provider.dashboardStream()]);
      if (!streamOnly && (requested.has("audience") || requested.has("followers")))
        jobs.push(["followers", provider.dashboardFollowers()]);
      if (!streamOnly && (requested.has("audience") || requested.has("subscribers")))
        jobs.push([
          "subscribers",
          auth.scopes.includes("channel:read:subscriptions")
            ? provider.dashboardSubscribers()
            : Promise.resolve({ ok: false, error: "twitch_subscriber_scope_required" }),
        ]);
      const results = await Promise.allSettled(jobs.map((row) => row[1]));
      if (closed) return;
      const old = twitch.stream;
      for (let i = 0; i < jobs.length; i++)
        twitch[jobs[i][0]] =
          results[i].status === "fulfilled"
            ? results[i].value
            : { ok: false, error: "twitch_dashboard_unavailable" };
      if (twitch.stream?.id && twitch.stream.id === old?.id && old.videoId)
        twitch.stream.videoId = old.videoId;
      const vodIds = [
        ...new Set([
          ...(twitch.stream?.ok && twitch.stream.live ? [twitch.stream.id] : []),
          ...timestamps.pendingStreamIds(),
        ]),
      ];
      if (!streamOnly && vodIds.length) {
        const vod = await provider.dashboardVod({ streamIds: vodIds });
        if (closed) return;
        if (vod.ok) {
          timestamps.associate(vod.videos || []);
          if (twitch.stream?.live)
            twitch.stream.videoId =
              vod.videos?.find((v) => v.streamId === twitch.stream.id)?.videoId || null;
        }
      }
      if (!streamOnly && needsClips)
        twitch.clips = await provider.dashboardClips({
          startedAt: twitch.stream?.live ? twitch.stream.startedAt : null,
        });
      lastReadAt = now();
      notify();
    } catch {
      twitch.stream = { ok: false, error: "twitch_dashboard_unavailable" };
      notify();
    }
  }
  const timestamps = require("./stream-timestamps")({
    runtimeDir,
    getStream: () => twitch.stream,
    getObs,
    getMedia: media,
    getProvider,
    refresh: () => readTwitch(true, true),
    notify,
    now,
  });
  function refresh(config) {
    if (closed) return Promise.resolve();
    const types = new Set(config.widgets?.enabled ? config.widgets.items.map((w) => w.type) : []);
    const steps =
      config.pages?.flatMap((p) =>
        p.buttons.flatMap((b) => [...b.steps, ...b.alternateSteps, ...b.holdSteps]),
      ) || [];
    if (steps.some((s) => ["stream.timestamp", "stream.marker"].includes(s.actionId)))
      types.add("markers");
    if ([...types].some((type) => !requested.has(type))) after = 0;
    requested = types;
    if (!flight)
      flight = (async () => {
        if (
          [
            "stream",
            "audience",
            "viewers",
            "followers",
            "subscribers",
            "clips",
            "markers",
            "connections",
          ].some((t) => types.has(t))
        )
          await readTwitch();
        if (types.has("rewards") && now() >= rewardsAfter) {
          rewardsAfter = now() + 10000;
          const state = await getRewards()?.snapshot(false);
          rewards = state
            ? {
                available: state.available,
                rows: (state.rewards || [])
                  .filter((r) => r.manageable)
                  .slice(0, 10)
                  .map((r) => ({ title: r.title, paused: r.paused, enabled: r.enabled })),
              }
            : null;
          notify();
        }
      })()
        .catch(() => {})
        .finally(() => {
          flight = null;
        });
    return flight;
  }
  function snapshot() {
    const raw = getObs(),
      obs = raw
        ? {
            connection: { connected: raw.connection?.connected === true },
            program: raw.program,
            preview: raw.preview,
            streaming: raw.streaming,
            recording: raw.recording,
            studio: raw.studio,
            streamTiming: raw.streamTiming,
            stats: raw.stats,
          }
        : null;
    return {
      ...(requested.has("now-playing") || requested.has("queue") ? { music: media() } : {}),
      ...([
        "stream",
        "audience",
        "viewers",
        "followers",
        "subscribers",
        "clips",
        "connections",
      ].some((t) => requested.has(t))
        ? { twitch: { ...twitch, checkedAt: lastReadAt } }
        : {}),
      ...(requested.has("obs") || requested.has("stream") || requested.has("connections")
        ? { obs }
        : {}),
      ...(requested.has("rewards") ? { rewards } : {}),
      ...(requested.has("markers")
        ? {
            timestamps: timestamps.list(10),
            timestampCount: timestamps.count(),
            canTimestamp: !!timestamps.source(),
          }
        : {}),
    };
  }
  function catalog() {
    const latest = timestamps.latest(),
      source = timestamps.source();
    return [
      {
        id: "stream.timestamp",
        label: "Save stream timestamp",
        symbol: "\u2691",
        group: "Stream moments",
        available: !!source,
        description:
          "Save a local bookmark at the current stream time, with a VOD link when available.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { description: { type: "string", title: "Timestamp label", maxLength: 140 } },
        },
        defaults: { description: "Highlight" },
        state: latest
          ? { tone: "success", text: "Timestamp saved", completedAt: latest.at }
          : {
              tone: source ? "ready" : "unknown",
              text: source ? "Mark moment" : "Stream not live",
            },
      },
      {
        id: "stream.marker",
        label: "Add Twitch Highlighter marker",
        symbol: "\u2691",
        group: "Stream moments",
        available: !!(twitch.stream?.live && twitch.scopes?.includes("channel:manage:broadcast")),
        description:
          "Create a confirmed Twitch Highlighter marker. Requires marker access, a live broadcast and VODs enabled.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { description: { type: "string", title: "Marker label", maxLength: 140 } },
        },
        defaults: { description: "Highlight" },
      },
    ];
  }
  return {
    refresh,
    snapshot,
    catalog,
    timestamps,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    execute(id, params, signal) {
      if (signal?.aborted)
        throw Object.assign(Error("control_deck_cancelled"), { code: "control_deck_cancelled" });
      return timestamps.create(params, id === "stream.marker", signal);
    },
    close() {
      closed = true;
      timestamps.close();
      listeners.clear();
    },
  };
};
