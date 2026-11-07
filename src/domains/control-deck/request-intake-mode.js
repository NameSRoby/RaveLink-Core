/** One saved Twitch intake choice; queue pause and reward ownership stay intact. */
const { fault } = require("./control-deck-config");
const id = "song.request-mode-toggle";
module.exports = function requestMode({ getFeatures, getRewards }) {
  let current = null,
    after = 0,
    chain = Promise.resolve();
  const active = () =>
    getFeatures()
      ?.list()
      .features?.some((row) => row.id === "twitch-integration" && row.lifecycle === "active");
  const call = (capability, method, payload) =>
    getFeatures().request("twitch-integration", capability, method, payload, { timeoutMs: 5000 });
  async function read() {
    if (!active()) throw fault("twitch_integration_unavailable");
    const reply = await call("twitch.connection.read.v1", "status", null);
    if (!reply.ok || typeof reply.value?.monitorConfig?.songRequestChatEnabled !== "boolean")
      throw fault("song_request_mode_unavailable");
    return reply.value;
  }
  async function refresh(force = false) {
    if (!force && Date.now() < after) return;
    after = Date.now() + 1000;
    try {
      current = await read();
    } catch {
      current = null;
    }
  }
  function catalog() {
    const chat = current?.monitorConfig?.songRequestChatEnabled === true,
      native = current?.monitorConfig?.intakeMode === "native";
    return [
      {
        id,
        defaultTitle: "Request mode",
        defaultSymbol: "↔",
        label: "Request mode",
        symbol: "↔",
        group: "Song Request",
        available: !!current?.connected && native,
        parameters: { type: "object", additionalProperties: false, properties: {} },
        defaults: {},
        description:
          "Switch Song Request intake between Channel Points and !sr / !songrequest. Queue pause and command permissions are preserved.",
        state: {
          text: !current
            ? "Connect Twitch"
            : !native
              ? "Choose native Twitch intake"
              : chat
                ? "Chat · !sr"
                : "Channel Points",
          active: chat,
          tone: chat ? "active" : current && native ? "ready" : "unknown",
        },
      },
    ];
  }
  function execute(signal) {
    const check = () => {
      if (signal?.aborted) throw fault("control_deck_cancelled");
    };
    const result = chain
      .catch(() => {})
      .then(async () => {
        check();
        const before = await read(),
          chat = !before.monitorConfig.songRequestChatEnabled;
        if (before.monitorConfig.intakeMode !== "native")
          throw fault("song_request_native_intake_required");
        if (!before.connected) throw fault("twitch_not_connected");
        if (chat && !before.scopes?.includes("user:read:chat"))
          throw fault("song_request_chat_access_required");
        const rewards = getRewards(),
          state = await rewards?.snapshot(true),
          song = state?.rewards?.find((row) => row.purpose === "song_request" && row.manageable);
        if (
          chat &&
          before.managedRewards?.some((row) => row.purpose === "song_request") &&
          !state?.available
        )
          throw fault("managed_rewards_state_unknown");
        if (!chat && !song) throw fault("managed_song_reward_required");
        if (chat && song && !song.paused) {
          check();
          const paused = await rewards.update({ purpose: "song_request", paused: true });
          if (paused?.ok === false || paused?.partial)
            throw fault("song_request_reward_pause_failed");
        }
        check();
        const reply = await call("twitch.monitor.admin.v1", "configure", {
          intakeMode: "native",
          songRequestChatEnabled: chat,
        });
        if (!reply.ok || reply.value?.ok === false) throw fault("song_request_mode_change_failed");
        if (!chat) {
          check();
          const resumed = await rewards.update({ purpose: "song_request", paused: false });
          if (
            resumed?.ok === false ||
            (resumed?.partial && resumed.results?.some((row) => !row.ok && !row.held))
          )
            throw fault("song_request_reward_resume_failed");
        }
        current = await read();
        after = 0;
        if (current.monitorConfig.songRequestChatEnabled !== chat)
          throw fault("song_request_mode_unconfirmed");
        return { ok: true, mode: chat ? "chat" : "channel-points" };
      });
    chain = result;
    return result.finally(() => {
      after = 0;
    });
  }
  return { id, catalog, refresh, execute };
};
