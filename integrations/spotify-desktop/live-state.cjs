const { trackUri, artworkUrl } = require('./catalog.cjs');
module.exports = function liveState(input) {
  if (!input || input.ok !== true || !Array.isArray(input.queue) || input.queue.length > 250) return null;
  const clean = (text, size) => typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, size) : '';
  const row = item => {
    const uri = trackUri(item?.uri), uid = clean(item?.uid, 200);
    return uri && uid ? { uri, uid, origin: item.origin === 'manual' ? 'manual' : 'playlist' } : null;
  };
  const queue = input.queue.map(row);if (queue.some(item => !item)) return null;
  const currentUri = trackUri(input.current?.uri);
  const current = currentUri ? { uri: currentUri, uid: clean(input.current.uid, 200), origin: input.current.origin === 'manual' ? 'manual' : 'playlist' } : null;
  const ms = value => Number.isFinite(value) ? Math.max(0, Math.min(86400000, value)) : 0;
  return { ok: true, complete: input.complete !== false, localDevice: input.localDevice === true, ...(/^[A-Za-z0-9_-]{1,120}$/.test(input.deviceId || '') ? { deviceId: input.deviceId } : {}), queue, current: current ? { ...current,
    title: clean(input.current.title, 200), artists: Array.isArray(input.current.artists) ? input.current.artists.slice(0, 8).map(name => clean(name, 100)) : [],
    album: clean(input.current.album, 200), artworkUrl: artworkUrl(input.current.artworkUrl), durationMs: ms(input.current.durationMs), positionMs: ms(input.current.positionMs), paused: input.current.paused === true, buffering: input.current.buffering === true } : null };
};
