module.exports = function playerRouting({ preferences, queue, tidal, changed }) {
  return async request => {
    const relevant = request.capability === 'song.player.preferences.v1' || request.capability === 'song.queue.submit.v1' && request.method === 'submit' || request.capability === 'song.playback.driver.v1' && request.method === 'pull' || request.capability === 'song.queue.admin.v1' && request.payload?.action === 'playback_start' || ['song.spotify.player.v1', 'song.tidal.experimental.v1', 'song.soundcloud.player.v1'].includes(request.capability);
    if (!relevant) return null;
    const selected = await preferences('status', null);
    if (!selected.ok) return { value: { ok: false, code: 'player_preferences_unavailable' } };
    const payload = request.payload || {};
    if (request.capability === 'song.queue.submit.v1' && request.method === 'submit') request.activePlayer = selected.player;
    if (request.capability === 'song.player.preferences.v1' && request.method === 'select') {
      const result = await preferences('select', payload);
      if (result.ok && result.player !== selected.player) {
        queue.configurePlaybackSource({ source: result.player, suspend: true });changed(result);
      }
      return { value: result };
    }
    if (request.capability === 'song.queue.admin.v1' && request.method === 'moderate' && payload.action === 'playback_start' && payload.source && payload.source !== selected.player) return { value: { ok: false, code: 'player_inactive' } };
    const provider = { 'song.spotify.player.v1': 'spotify', 'song.tidal.experimental.v1': 'tidal', 'song.soundcloud.player.v1': 'soundcloud' }[request.capability];
    if (provider && ['submit', 'submit-query', 'start', 'monitor', 'handoff', 'flush', 'control', 'volume'].includes(request.method) && provider !== selected.player) {
      return { value: { ok: false, code: 'player_inactive', error: 'player_inactive' } };
    }
    if (request.capability === 'song.queue.submit.v1' && request.method === 'submit' && selected.player === 'tidal') return { value: await tidal.submit(payload) };
    if (request.capability === 'song.playback.driver.v1' && request.method === 'pull') {
      if (!['youtube', 'soundcloud'].includes(selected.player) || !payload.providers?.includes(selected.player)) return { value: { ok: true, code: 'idle', action: null } };
      request.payload = { ...payload, providers: [selected.player] };
    }
    return null;
  };
};
