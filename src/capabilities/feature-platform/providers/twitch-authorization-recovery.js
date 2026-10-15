const TYPES = new Set([
  'channel.channel_points_custom_reward_redemption.add', 'channel.chat.message',
  'channel.follow', 'channel.subscribe', 'channel.subscription.message',
  'channel.subscription.gift', 'channel.cheer', 'channel.raid', 'stream.online',
  'stream.offline', 'channel.hype_train.begin', 'channel.hype_train.progress', 'channel.hype_train.end'
]);
const REASONS = new Set(['authorization_revoked', 'user_removed', 'version_removed']);

module.exports = function createRecovery(options) {
  let revision = 0;
  function normalize(value = {}) {
    value = value && typeof value === 'object' ? value : {};
    const rows = Array.isArray(value.revocations) ? value.revocations : [];
    return {
      reauthorizationRequired: value.reauthorizationRequired === true,
      reason: REASONS.has(value.reason) ? value.reason : '',
      revocations: rows.filter(row => TYPES.has(row?.type) && /^\d{1,3}$/.test(String(row.version)))
        .slice(0, 16).map(row => ({ type: row.type, version: String(row.version), reason: REASONS.has(row.reason) ? row.reason : 'unknown' }))
    };
  }
  function snapshot() { return normalize(options.getProfile().authorizationRecovery); }
  function invalidate() { revision += 1; options.onInvalidated(); }
  function allowed(type, version) {
    const state = snapshot();
    return !state.reauthorizationRequired && !state.revocations.some(row => row.type === type && row.version === String(version));
  }
  function afterLogin() {
    return { reauthorizationRequired: false, reason: '', revocations: snapshot().revocations.filter(row => row.reason === 'version_removed') };
  }
  function revoke(input = {}) {
    if (!TYPES.has(input.type)) return false;
    const row = normalize({ revocations: [input] }).revocations[0];
    if (!row) return false;
    const previous = snapshot();
    const full = ['authorization_revoked', 'user_removed'].includes(row.reason);
    if (full) invalidate();
    const profile = options.getProfile();
    options.setProfile({ ...profile,
      ...(full ? { accessToken: '', refreshToken: '', scopes: [], expiresAt: 0 } : {}),
      authorizationRecovery: { reauthorizationRequired: full || previous.reauthorizationRequired,
        reason: full ? row.reason : previous.reason,
        revocations: [...previous.revocations.filter(item => item.type !== row.type || item.version !== row.version), row].slice(-16) }
    });
    options.onRevoked(row.reason);
    return true;
  }
  function guardApi(api) {
    return new Proxy({}, { get(_target, name) {
      const target = api;
      const method = target[name];
      if (typeof method !== 'function') return method;
      return async (...args) => {
        const current = revision;
        let result;
        try { result = await method.apply(target, args); }
        catch (error) {
          if (current === revision) throw error;
        }
        if (current !== revision) {
          const error = new Error('twitch_authorization_changed'); error.code = error.message; throw error;
        }
        return result;
      };
    } });
  }
  return { normalize, snapshot, allowed, afterLogin, revoke, invalidate, guardApi };
};
