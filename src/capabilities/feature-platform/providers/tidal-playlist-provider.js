const { durationMs } = require('./youtube-catalog-provider');
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
function candidate(data, included = []) {
  if (data?.type !== 'tracks' || !id(data.id)) return null;
  const attrs = data.attributes || {}, references = new Map(included.map(row => [row.type + ':' + row.id, row]));
  return { provider: 'tidal', providerItemId: data.id, title: String(attrs.title || data.id).slice(0, 300), version: String(attrs.version || '').slice(0, 100),
    artists: (data.relationships?.artists?.data || []).slice(0, 8).map(row => String(references.get('artists:' + row.id)?.attributes?.name || '').slice(0, 100)).filter(Boolean),
    album: String(references.get('albums:' + data.relationships?.albums?.data?.[0]?.id)?.attributes?.title || '').slice(0, 200),
    durationMs: durationMs(attrs.duration), isrc: String(attrs.isrc || ''), sourceUrl: 'https://tidal.com/track/' + encodeURIComponent(data.id) };
}
module.exports = function createTidalPlaylistProvider({ api, status, search }) {
  return async function handle(input = {}) {
    try {
      if (input.action === 'status') return { ok: true, ...status() };
      if (!status().connected || !status().playlistsEnabled) return { ok: false, error: 'tidal_playlist_sign_in_required' };
      if (input.action === 'search') {
        if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(input.isrc || '')) {
          const reply = await api('tracks', { 'filter[isrc]': input.isrc, include: 'artists,albums' });
          const candidates = (reply.data || []).slice(0, 5).map(row => candidate(row, reply.included)).filter(Boolean);
          if (candidates.length) return { ok: true, candidates };
        }
        return search(input.query);
      }
      if (input.action === 'track') {
        if (!id(input.id)) throw new Error('tidal_playlist_invalid');
        const reply = await api('tracks/' + encodeURIComponent(input.id), { include: 'artists,albums' });
        const track = candidate(reply.data, reply.included);
        if (!track) throw new Error('tidal_playlist_response_invalid');
        return { ok: true, candidate: track };
      }
      if (input.action === 'list') {
        const reply = await api('playlists', { 'filter[owners.id]': 'me', ...(input.cursor ? { 'page[cursor]': String(input.cursor).slice(0, 4096) } : {}) });
        return bounded({ ok: true, playlists: (reply.data || []).map(row => ({ id: row.id, name: String(row.attributes?.name || 'Playlist').slice(0, 250), description: String(row.attributes?.description || '').slice(0, 500) })), cursor: nextCursor(reply) });
      }
      if (input.action === 'read') {
        if (!id(input.id)) throw new Error('tidal_playlist_invalid');
        const reply = await api('playlists/' + encodeURIComponent(input.id) + '/relationships/items', { include: 'items.artists,items.albums', sort: 'itemIndex', ...(input.cursor ? { 'page[cursor]': String(input.cursor).slice(0, 4096) } : {}) });
        const included = reply.included || [], lookup = new Map(included.map(row => [row.type + ':' + row.id, row]));
        return bounded({ ok: true, tracks: (reply.data || []).map(row => candidate(lookup.get(row.type + ':' + row.id) || row, included)), cursor: nextCursor(reply) });
      }
      if (!/^[A-Za-z0-9_-]{8,160}$/.test(input.key || '')) throw new Error('tidal_playlist_key_invalid');
      if (input.action === 'create') {
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 250) throw new Error('tidal_playlist_invalid');
        const reply = await api('playlists', {}, undefined, { method: 'POST', key: input.key, body: { data: { type: 'playlists', attributes: { name: input.name, accessType: 'UNLISTED', description: String(input.description || '').slice(0, 500) } } } });
        if (!id(reply.data?.id)) throw new Error('tidal_playlist_write_uncertain');
        return { ok: true, id: reply.data.id };
      }
      if (input.action === 'append') {
        if (!id(input.id) || !Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 50 || !input.ids.every(id)) throw new Error('tidal_playlist_invalid');
        await api('playlists/' + encodeURIComponent(input.id) + '/relationships/items', {}, undefined,
          { method: 'POST', key: input.key, body: { data: input.ids.map(value => ({ type: 'tracks', id: value })), meta: { onDuplicates: 'ADD' } } });
        return { ok: true };
      }
      return { ok: false, error: 'tidal_playlist_action_invalid' };
    } catch (error) { return { ok: false, error: /^tidal_/.test(error.message) ? error.message : 'tidal_playlist_unavailable', safeToRetry: /rate_limited|credentials_rejected|access_denied|sign_in_required/.test(error.message) }; }
  };
};
function nextCursor(reply) {
  const link = reply.links?.next, href = typeof link === 'string' ? link : link?.href;
  if (!href) return '';
  const url = new URL(href, 'https://openapi.tidal.com');
  if (url.origin !== 'https://openapi.tidal.com' || !url.searchParams.has('page[cursor]')) throw new Error('tidal_playlist_response_invalid');
  return url.searchParams.get('page[cursor]');
}
function bounded(reply) {
  if (Buffer.byteLength(JSON.stringify(reply), 'utf8') > 45000) throw new Error('tidal_playlist_page_too_large');
  return reply;
}
module.exports.candidate = candidate;
