/** Toggle decisions come from the current owner, never macro click history. */
const { fault } = require("./control-deck-config");
const ids = ["song.playback-toggle", "song.intake-toggle", "rewards.toggle"];
const empty = { type: "object", additionalProperties: false, properties: {} };
module.exports = function pauseActions({ feature, getRewards, activeFeature }) {
  const state = new Map(),
    chains = new Map();
  let after = 0;
  let rewardSnapshot = { available: false, rewards: [] };
  const rewardId = (id) =>
    /^rewards\.toggle:[A-Za-z0-9_-]{1,160}$/.test(id) ? id.slice("rewards.toggle:".length) : "";
  const handles = (id) => ids.includes(id) || Boolean(rewardId(id));
  const check = (signal) => {
    if (signal?.aborted) throw fault("control_deck_cancelled");
  };
  async function read(id, force = false, reader = feature) {
    if (id === "rewards.toggle" || rewardId(id)) {
      const value = await getRewards()?.snapshot(force);
      rewardSnapshot = value || { available: false, rewards: [] };
      const rows = value?.rewards?.filter(
        (row) => row.manageable && (!rewardId(id) || row.id === rewardId(id)),
      );
      if (!value?.available || !rows?.length || rows.some((row) => typeof row.paused !== "boolean"))
        throw fault(value?.reason || "managed_rewards_state_unknown");
      return {
        paused: rows.every((row) => row.paused),
        mixed: rows.some((row) => row.paused) && rows.some((row) => !row.paused),
      };
    }
    if (!activeFeature("song-request")) throw fault("control_deck_action_unavailable");
    if (id === "song.intake-toggle") {
      const reply = await reader("song.queue.read.v1", "status", {
        limit: 5,
        playlistLimit: 1,
        moderationLimit: 1,
      });
      if (!reply.ok || typeof reply.value?.paused !== "boolean")
        throw fault("song_intake_state_unknown");
      return { paused: reply.value.paused };
    }
    const selected = await reader("song.player.preferences.v1", "status", null);
    if (!selected.ok) throw fault("song_player_unavailable");
    const value = selected.value;
    const native =
      ["tidal", "spotify"].includes(value?.player) ||
      (value?.player === "youtube" && value.youtubePlayback === "browser");
    const playback = await reader("song.playback.read.v1", "status", null);
    if (!playback.ok) throw fault("song_playback_state_unknown");
    if (!native && typeof playback.value?.control?.paused === "boolean")
      return { paused: playback.value.control.paused };
    const capability =
      value.player === "tidal"
        ? "song.tidal.experimental.v1"
        : value.player === "spotify"
          ? "song.spotify.player.v1"
          : "song.youtube.browser.v1";
    const actual = await reader(capability, "status", null);
    const current = actual.ok && actual.value?.current;
    if (
      actual.value?.ready !== false &&
      actual.value?.connected !== false &&
      typeof current?.paused === "boolean"
    )
      return { paused: current.paused };
    const primary = playback.value?.primary;
    if (
      primary?.provider === value.player &&
      ["playing", "paused"].includes(primary.status) &&
      Number.isFinite(primary.observedAt) &&
      Date.now() - primary.observedAt < 15000
    )
      return { paused: primary.status === "paused" };
    if (actual.value?.enabled === false) throw fault("song_player_disabled");
    if (actual.value?.connected === false || actual.value?.ready === false)
      throw fault("song_player_not_connected");
    throw fault("song_playback_state_unknown");
  }
  async function refresh(force = false, reader = feature) {
    if (!force && Date.now() < after) return;
    after = Date.now() + 400;
    await Promise.all(
      ids.map(async (id) => {
        try {
          state.set(id, await read(id, force, reader));
        } catch (error) {
          if (id === "rewards.toggle") rewardSnapshot = { available: false, rewards: [] };
          state.set(id, { error: error.code || error.message });
        }
      }),
    );
  }
  function catalog() {
    const controls = ids.map((id) => {
      const current = state.get(id),
        known = typeof current?.paused === "boolean";
      const subject =
        id === "rewards.toggle" ? "rewards" : id === "song.intake-toggle" ? "requests" : "playback";
      const text = !known
        ? id === "song.playback-toggle"
          ? current?.error === "song_player_disabled"
            ? "Enable the selected player"
            : current?.error === "song_player_not_connected"
              ? "Connect the selected player"
              : "Waiting for player status"
          : id === "rewards.toggle"
            ? "Check Twitch rewards"
            : "Waiting for request status"
        : current.mixed
          ? "Mixed reward states"
          : current.paused
            ? "Paused"
            : "Active";
      return {
        id,
        defaultTitle: {
          "song.playback-toggle": "Playback",
          "song.intake-toggle": "Song requests",
          "rewards.toggle": "Channel Points rewards",
        }[id],
        defaultSymbol: "\u23ef",
        label: known
          ? `${current.paused ? "Resume" : "Pause"} ${subject}`
          : `Pause / resume ${subject}`,
        symbol: known && current.paused ? "▶" : "Ⅱ",
        group: id === "rewards.toggle" ? "Twitch rewards" : "Song Request",
        available: known,
        parameters: empty,
        defaults: {},
        description: known
          ? "Reads the current owner state before changing it."
          : current?.error || "Waiting for confirmed state",
        state: {
          text,
          active: known && !current.paused && !current.mixed,
          tone: !known ? "unknown" : current.mixed ? "mixed" : current.paused ? "paused" : "active",
        },
      };
    });
    return controls.concat(
      (rewardSnapshot.rewards || [])
        .filter((row) => row.manageable && /^[A-Za-z0-9_-]{1,160}$/.test(row.id))
        .slice(0, 50)
        .map((row) => {
          const known = typeof row.paused === "boolean";
          return {
            id: "rewards.toggle:" + row.id,
            defaultTitle: row.title || "Reward",
            defaultSymbol: "\u23ef",
            label: `${row.paused ? "Resume" : "Pause"} ${row.title || "reward"}`,
            group: "Individual Twitch rewards",
            symbol: row.paused ? "▶" : "Ⅱ",
            available: rewardSnapshot.available && known,
            parameters: empty,
            defaults: {},
            description:
              "Changes only this RaveLink-managed reward. Song Request intake safety remains in charge.",
            state: {
              text: !known
                ? "State unavailable"
                : row.enabled === false
                  ? "Disabled in Twitch"
                  : row.paused
                    ? "Paused"
                    : "Active",
              active: known && !row.paused && row.enabled !== false,
              tone: !known
                ? "unknown"
                : row.enabled === false
                  ? "inactive"
                  : row.paused
                    ? "paused"
                    : "active",
            },
          };
        }),
    );
  }
  function execute(id, signal) {
    const key = id === "rewards.toggle" || rewardId(id) ? "rewards" : "song";
    const pending = (chains.get(key) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        check(signal);
        const current = await read(id, true);
        check(signal);
        let reply;
        if (id === "rewards.toggle") reply = await getRewards().toggle("all");
        else if (rewardId(id)) reply = await getRewards().toggleReward(rewardId(id));
        else
          reply = await feature("song.queue.admin.v1", "moderate", {
            action: current.paused ? "resume" : "pause",
            ...(id === "song.playback-toggle" ? { operatorPlayback: true } : {}),
          });
        if (reply?.partial) throw fault("control_deck_action_partial");
        if (reply?.ok === false || reply?.value?.ok === false)
          throw fault(reply.error?.code || reply.value?.reason || "control_deck_action_failed");
        try {
          state.set(id, await read(id, true));
        } catch (error) {
          state.set(id, { error: error.code || error.message });
        }
        after = 0;
        return reply;
      });
    chains.set(key, pending);
    pending
      .finally(() => {
        if (chains.get(key) === pending) chains.delete(key);
      })
      .catch(() => {});
    return pending;
  }
  return { ids, handles, catalog, refresh, execute };
};
