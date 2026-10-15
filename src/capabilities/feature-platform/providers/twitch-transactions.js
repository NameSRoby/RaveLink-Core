module.exports = function createTwitchTransactions({ journal, getProfile, withAuthorization, api, onRedemption, now = Date.now }) {
  function managed(profile, rewardId) { return Object.values(profile.managedRewards).some(row => row.rewardId === rewardId); }
  const fail = error => ({ ok: false, error, retryable: false });
  const send = row => withAuthorization(current => api.settleRedemption({ ...row, credentials: current }), ['channel:manage:redemptions']);
  function settle(input = {}) {
    const profile = getProfile();
    if (!managed(profile, input.rewardId)) return fail('twitch_reward_not_managed');
    if (input.broadcasterId && input.broadcasterId !== profile.userId) return fail('twitch_broadcaster_mismatch');
    return journal.settle({ ...input, broadcasterId: profile.userId }, send);
  }
  function reviewTransactions() { return journal.list(getProfile().userId); }
  function reconcileTransaction(input = {}) {
    const profile = getProfile();
    if (input.broadcasterId !== profile.userId) return fail('twitch_broadcaster_mismatch');
    if (!managed(profile, input.rewardId)) return fail('twitch_reward_not_managed');
    return journal.reconcile(input, row => withAuthorization(current => api.inspectRedemption({ ...row, credentials: current }), ['channel:manage:redemptions']), send);
  }
  async function receiveRedemption(event) {
    const profile = getProfile();
    if (event?.broadcaster_user_id !== profile.userId) return fail('twitch_broadcaster_mismatch');
    const owned = managed(profile, event?.reward?.id);
    const identity = { broadcasterId: profile.userId, rewardId: event?.reward?.id, redemptionId: event?.id };
    if (owned) {
      if (event.status && String(event.status).toUpperCase() !== 'UNFULFILLED') return { ok: true, duplicate: true };
      const timestamp = Date.parse(event.redeemed_at || '');
      if (!Number.isFinite(timestamp) || now() - timestamp >= 7 * 86400000 || timestamp - now() > 60000) return fail('twitch_redemption_timestamp_invalid');
      const admitted = journal.begin(identity);
      if (!admitted.ok || admitted.duplicate) return admitted;
    }
    try { return await onRedemption?.(event, { ...profile.managedRewards }); }
    finally { if (owned) journal.reviewExecution(identity); }
  }
  return Object.freeze({ settle, reviewTransactions, reconcileTransaction, receiveRedemption });
};
