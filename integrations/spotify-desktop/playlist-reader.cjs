const { trackUri, artworkUrl } = require('./catalog.cjs');
const clean = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : '';
function playlistUri(value) {
  if (typeof value !== 'string' || value.length > 500) return '';
  if (/^[A-Za-z0-9]{22}$/.test(value)) return 'spotify:playlist:' + value;
  if (/^spotify:playlist:[A-Za-z0-9]{22}$/.test(value)) return value;
  try { const url = new URL(value), match = /^\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
    if (url.protocol === 'https:' && url.hostname === 'open.spotify.com' && !url.username && !url.password && !url.port && match) return 'spotify:playlist:' + match[1];
  } catch {}return '';
}
function normalize(input) {
  if (!input || !['read', 'list', 'create', 'append'].includes(input.action)) return null;
  if (input.action === 'create') return typeof input.name === 'string' && input.name.trim() && input.name.length <= 100 ? { action: 'create', name: input.name } : null;
  if (input.action === 'append') return playlistUri(input.id) && Array.isArray(input.ids) && input.ids.length > 0 && input.ids.length <= 25 && input.ids.every(value => trackUri(value)) ? { action: 'append', id: playlistUri(input.id), ids: input.ids.map(trackUri) } : null;
  const offset = input.offset ?? 0;if (!Number.isInteger(offset) || offset < 0 || offset > 10000) return null;
  const uri = playlistUri(input.id);return input.action === 'read' && !uri ? null : { action: input.action, offset, ...(uri ? { id: uri } : {}) };
}
function track(raw) {
  const item = raw?.track || raw, uri = trackUri(item?.uri);
  if (!uri || item.isLocal || item.isPlayable === false || item.playability?.playable === false) return null;
  const artists = Array.isArray(item.artists) ? item.artists : item.artists?.items || [];
  return { provider: 'spotify', providerItemId: uri.slice(14), title: clean(item.name || item.title, 200) || uri.slice(14),
    artists: artists.slice(0, 8).map(artist => clean(artist.name || artist.profile?.name || artist, 100)).filter(Boolean),
    album: clean(typeof item.album === 'string' ? item.album : item.album?.name || item.albumOfTrack?.name, 200), artworkUrl: artworkUrl(item.artworkUrl || item.album?.images?.[0]?.url),
    durationMs: Math.max(0, Math.min(86400000, Number(item.duration?.milliseconds ?? item.duration?.totalMilliseconds ?? item.duration_ms ?? item.durationMs) || 0)), sourceUrl: 'https://open.spotify.com/track/' + uri.slice(14) };
}
function result(raw, input) {
  if (raw?.ok !== true) return null;
  if (input.action === 'create') return playlistUri(raw.id) ? { ok: true, id: playlistUri(raw.id) } : null;
  if (input.action === 'append') return { ok: true };
  if (input.action === 'list') {
    if (raw.cursor && (!/^\d{1,5}$/.test(raw.cursor) || Number(raw.cursor) > 10000)) return null;
    if (!Array.isArray(raw.playlists) || raw.playlists.length > 25 || raw.playlists.some(row => !playlistUri(row?.id) || typeof row.name !== 'string' || row.name.length > 200)) return null;
    return { ok: true, playlists: raw.playlists.map(row => ({ id: playlistUri(row.id), name: row.name })), cursor: String(raw.cursor || '') };
  }
  if (!Array.isArray(raw.tracks) || raw.tracks.length > 25 || !Number.isInteger(raw.total) || raw.total < input.offset || raw.total > 1000000 || raw.tracks.some(row => row !== null && (!trackUri(row?.providerItemId) || typeof row.title !== 'string'))) return null;
  const next = input.offset + raw.tracks.length;
  if (raw.total > next && !raw.tracks.length) return null;
  return { ok: true, name: clean(raw.name, 80), total: raw.total, revision: clean(raw.revision, 160), tracks: raw.tracks.map(row => row ? track({ ...row, uri: trackUri(row.providerItemId), name: row.title }) : null), cursor: next < raw.total ? String(next) : '' };
}
async function read(service, input) {
  try {
    if (input.action === 'create') {
      const root = service('RootlistAPI');if (typeof root?.createPlaylist !== 'function') throw Error('spotify_playlist_unavailable');
      const uri = playlistUri(await root.createPlaylist(input.name, { before: 'start' }));
      if (!uri) throw Error('spotify_playlist_write_uncertain');return { ok: true, id: uri };
    }
    if (input.action === 'append') {
      const api = service('PlaylistAPI');if (typeof api?.add !== 'function') throw Error('spotify_playlist_unavailable');
      await api.add(input.id, input.ids, { after: 'end' });return { ok: true };
    }
    if (input.action === 'list') {
      const root = service('RootlistAPI');if (typeof root?.getContents !== 'function') throw Error('spotify_playlist_unavailable');
      const contents = await root.getContents(), rows = [], seen = new Set();let visited = 0;
      function walk(items, depth = 0) {
        if (!Array.isArray(items) || depth > 12) throw Error('spotify_playlist_shape_unavailable');
        for (const item of items) { if (++visited > 10000) throw Error('spotify_playlist_list_limit');
          const id = playlistUri(item?.uri);if (id && !seen.has(id)) { seen.add(id);rows.push({ id, name: clean(item.name, 200) || 'Spotify playlist' }); }
          if (Array.isArray(item?.items)) walk(item.items, depth + 1);
        }
      }
      walk(contents?.items);return { ok: true, playlists: rows.slice(input.offset, input.offset + 25), cursor: rows.length > input.offset + 25 ? String(input.offset + 25) : '' };
    }
    const api = service('PlaylistAPI');if (typeof api?.getPlaylist !== 'function') throw Error('spotify_playlist_unavailable');
    const reply = await api.getPlaylist(input.id, {}, { offset: input.offset, limit: 25 });
    if (reply?.metadata?.isLoaded !== true || !Number.isInteger(reply.metadata.totalLength) || !Array.isArray(reply.contents?.items) || reply.contents.items.length > 25) throw Error('spotify_playlist_shape_unavailable');
    return result({ ok: true, name: reply.metadata.name, total: reply.metadata.totalLength, revision: reply.contents.revision || reply.metadata.revision, tracks: reply.contents.items.map(track) }, input) || { ok: false, error: 'spotify_playlist_shape_unavailable' };
  } catch (error) { return { ok: false, error: /^spotify_playlist_[a-z_]+$/.test(error.message) ? error.message : 'spotify_playlist_read_failed' }; }
}
module.exports = { normalize, result, read, playlistUri };
