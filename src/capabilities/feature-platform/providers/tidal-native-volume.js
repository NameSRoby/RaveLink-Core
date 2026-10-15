module.exports = ({ commands, status, finish, now, timeoutMs }) => input => {
  const percent = input?.percent, state = status(), fail = error => ({ ok: false, error });
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return Promise.resolve(fail('tidal_volume_invalid'));
  if (!state.connected) return Promise.resolve(fail('tidal_companion_unavailable'));
  if (!state.volumeAvailable) return Promise.resolve(fail('tidal_companion_update_required'));
  if (commands.size) return Promise.resolve(fail('tidal_bridge_busy'));
  const id = require('node:crypto').randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(id, fail('tidal_volume_unconfirmed')), timeoutMs || 8000); timer.unref?.();
    commands.set(id, { id, kind: 'volume', percent, expiresAt: now() + (timeoutMs || 8000), delivered: false, resolve, timer });
  });
};
