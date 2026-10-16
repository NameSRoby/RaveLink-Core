module.exports = context => {
  const spotify = payload => context.callCapability('spotify.desktop.host.v1', 'playlist', payload, { timeoutMs: 15000 });
  const youtube = (method, payload) => context.callCapability('youtube.catalog.host.v1', 'import-playlist-' + method, payload, { timeoutMs: 3000 });
  const sources = {
    spotify,
    async beginYoutube(url, limit) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port || !/^[A-Za-z0-9_-]{10,120}$/.test(parsed.searchParams.get('list') || '')) throw Error('playlist_url_invalid');
      const reply = await youtube('start', { url: parsed.href, limit });if (!reply.ok) throw Error(reply.error || 'playlist_import_unavailable');return reply;
    },
    async readYoutube(job) {
      const status = await youtube('status', { jobId: job.sourceJobId });
      if (!status.ok || ['failed', 'canceled'].includes(status.state)) throw Error(status.error || 'playlist_import_failed');
      if (status.state !== 'complete') return null;
      job.sourceTruncated = status.truncated === true;
      const offset = Number(job.cursor || 0), page = await youtube('page', { jobId: job.sourceJobId, offset, limit: 25 });
      if (!page.ok || !Array.isArray(page.items)) throw Error(page.error || 'playlist_import_failed');
      if (!page.items.length && offset < status.count) throw Error('playlist_import_page_invalid');
      return { ok: true, name: status.title, tracks: page.items.map(row => row?.candidate || row), cursor: offset + page.items.length < status.count ? String(offset + page.items.length) : '' };
    },
    cancelYoutube: job => youtube('cancel', { jobId: job.sourceJobId }),
    async read(job) {
      const reply = job.sourceKind === 'spotify' ? await spotify({action:'read',id:job.sourceId,offset:Number(job.cursor || 0)}) : job.sourceKind === 'youtube' ? await sources.readYoutube(job) : await context.callCapability('tidal.playlists.host.v1','action',{action:'read',id:job.sourceId,cursor:job.cursor},{timeoutMs:15000});
      if (!reply) return null;if (!reply.ok) throw Error(reply.error);
      if (job.sourceKind === 'spotify' && (reply.total !== job.sourceTotal || job.sourceRevision && reply.revision !== job.sourceRevision)) throw Error('spotify_playlist_changed');
      if (!job.customName && reply.name) job.name = String(reply.name).slice(0,80);return reply;
    },
    async cancel(job, action) { if(action === 'cancel' && job.sourceKind === 'youtube' && job.sourceJobId) await sources.cancelYoutube(job).catch(()=>{}); },
    async begin(input, limit) {
      if (input.action === 'read_youtube') { const started = await sources.beginYoutube(input.id, limit);return { kind:'youtube',name:input.name || started.title || 'YouTube playlist',sourceJobId:started.jobId }; }
      const id = String(input.id || '');
      if (input.action === 'read_spotify') {
        let valid = /^(?:spotify:playlist:)?[A-Za-z0-9]{22}$/.test(id);
        try { const url = new URL(id);valid ||= url.protocol === 'https:' && url.hostname === 'open.spotify.com' && !url.username && !url.password && !url.port && /^\/(?:intl-[a-z-]+\/)?playlist\/[A-Za-z0-9]{22}\/?$/.test(url.pathname); } catch {}
        if (!valid) throw Error('spotify_playlist_invalid');
        const first = await spotify({action:'read',id,offset:0});if (!first.ok) throw Error(first.error);if(first.total > limit) throw Error('playlist_track_limit');
        return {kind:'spotify',name:input.name || first.name || 'Spotify playlist',sourceId:id,sourceTotal:first.total,sourceRevision:first.revision || ''};
      }
      let sourceId = id;
      if (sourceId.startsWith('https://')) { const url = new URL(sourceId);if (!['tidal.com','listen.tidal.com','www.tidal.com'].includes(url.hostname) || url.username || url.password || url.port) throw Error('tidal_playlist_invalid');sourceId = /^\/(?:browse\/)?playlist\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1] || ''; }
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(sourceId)) throw Error('tidal_playlist_invalid');
      return {kind:'tidal',name:input.name || 'TIDAL playlist',sourceId};
    }
  };
  return sources;
};
