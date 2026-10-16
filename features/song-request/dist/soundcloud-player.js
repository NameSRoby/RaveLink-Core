const { text } = require('./portable-track');
function candidate(sound) {
  const id = String(sound?.id || sound?.providerItemId || '');
  if (!/^[1-9]\d{0,19}$/.test(id) || !text(sound?.title, 200)) throw new Error('soundcloud_track_invalid');
  if (sound.policy && !['ALLOW', 'MONETIZE'].includes(sound.policy)) throw new Error('soundcloud_track_restricted');
  return { artworkUrl: require('./player-artwork').soundcloud(sound.artwork_url), provider: 'soundcloud', providerItemId: id, title: text(sound.title, 200),
    artists: [text(sound.user?.username || sound.artists?.[0], 100)].filter(Boolean), album: text(sound.publisher_metadata?.album_title || sound.album, 200),
    durationMs: Math.max(0, Math.min(86400000, Math.trunc(Number(sound.duration ?? sound.durationMs) || 0))),
    sourceUrl: /^https:\/\/soundcloud\.com\/[\w-]+\/[\w-]+\/?$/.test(String(sound.permalink_url || '')) ? sound.permalink_url : '' };
}
module.exports = function soundcloudPlayer({ queue, playlists, changed, context, isSelected = async () => true }) {
  let upload = null;
  async function resolveQuery(query) {
    const state = queue.status();
    if (state.paused) return { ok: false, reason: 'intake_paused' };
    try { return await context.callCapability('soundcloud.catalog.host.v1', 'resolve', { query, policy: state.catalogPolicy, maxDurationMs: state.limits.maxDurationMs }, { timeoutMs: 20000 }); }
    catch { return { ok: false, reason: 'soundcloud_search_unavailable' }; }
  }
  async function handle(method, input = {}) {
    try {
      if (method === 'submit-query') {
        const found = await resolveQuery(input.query); if (!found.ok) return { ok: false, code: 'rejected', reason: found.reason };
        if (!await isSelected()) return { ok: false, code: 'rejected', reason: 'player_inactive' };
        const result = queue.submit({ requestId:text(input.requestId,80),requesterId:'local-soundcloud-operator',requesterName:'Local SoundCloud operator',notifyChat:input.notifyChat===true,requesterRole:'moderator',query:input.query,candidate:found.candidate });
        changed(result); return result;
      }
      if (method === 'submit') {
        const track = candidate(input.sound);
        const result = queue.submit({ requestId: text(input.requestId, 80), requesterId: 'local-soundcloud-operator',
          requesterName: 'Local SoundCloud operator', notifyChat: input.notifyChat === true, requesterRole: 'moderator', query: track.title, candidate: track });
        changed(result); return result;
      }
      if (method === 'start') {
        if (queue.playbackStatus().playbackSource !== 'soundcloud') {
          try { await context.callCapability('media.windows.now-playing.v1', 'control', {action:'stop'}, {timeoutMs:2000}); } catch {}
        }
        queue.configurePlaybackSource({ source: 'soundcloud' }); const result = queue.moderate({ action: 'playback_start' }); changed(result); return result;
      }
      if (method === 'release') { const result = queue.release(input); changed(result); return result; }
      if (method === 'import-start') {
        upload = { id: require('node:crypto').randomUUID(), name: text(input.name, 80) || 'SoundCloud playlist', rows: [], at: Date.now() };
        return { ok: true, uploadId: upload.id };
      }
      if (!upload || upload.id !== input.uploadId || Date.now() - upload.at > 300000) throw new Error('soundcloud_import_expired');
      if (method === 'import-append') {
        if (input.offset !== upload.rows.length || !Array.isArray(input.sounds) || input.sounds.length > 40) throw new Error('soundcloud_import_page_invalid');
        const rows = input.sounds.map(sound => ({ candidate: candidate(sound) }));
        if (upload.rows.length + rows.length > playlists.trackLimit()) throw new Error('playlist_track_limit');
        upload.rows.push(...rows); return { ok: true, count: upload.rows.length };
      }
      if (method === 'import-save') {
        if (!upload.rows.length) throw new Error('soundcloud_playlist_empty');
        const result = await playlists.installPublicPlaylist(upload.name, upload.rows); if (result.ok) upload = null; return result;
      }
      throw new Error('soundcloud_method_invalid');
    } catch (error) { return { ok: false, code: error.message }; }
  }
  return Object.assign(handle, { resolveQuery });
};
module.exports.candidate = candidate;
