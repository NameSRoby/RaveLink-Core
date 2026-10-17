/**
 * Twitch redemption router.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#lighting-and-dynamic-effects
 */
module.exports = function createRedemptionRouter({
  twitchProvider,
  chatCommands,
  widgetController,
}) {
  return async function route(event, managedRewards) {
    let requester = chatCommands.profileFor(event?.user_id);
    if (requester.role === "viewer") {
      const resolved = await twitchProvider().resolveRequesterRole(event?.user_id);
      if (resolved?.ok) requester = { ...requester, role: resolved.role };
    }
    return widgetController?.handleWidgetEvent?.({
      transport: "native",
      eventEnvelope: { event: { ...event, requester_role: requester.role } },
      widgetConfig: {
        playlistRewardId: managedRewards?.add_to_playlist?.rewardId || "",
        colorRewardId: managedRewards?.lights?.rewardId || "",
        teachRewardId: managedRewards?.teach?.rewardId || "",
        songRewardId: twitchProvider().status().monitorConfig.songRequestChatEnabled
          ? ""
          : managedRewards?.song_request?.rewardId || "",
      },
    });
  };
};
