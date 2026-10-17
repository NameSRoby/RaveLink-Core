/**
 * Twitch song reward pause.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
module.exports = async function pauseSongRewards(provider, input) {
  const purposes = [input.purpose];
  if (
    input.purpose === "song_request" &&
    provider.status().managedRewards?.some((row) => row.purpose === "add_to_playlist")
  )
    purposes.push("add_to_playlist");
  const results = await Promise.all(
    purposes.map((purpose) => provider.setManagedRewardPaused({ ...input, purpose })),
  );
  if (results.some((result) => !result.ok))
    return { ok: false, error: "twitch_reward_pause_partial" };
  return results[0];
};
