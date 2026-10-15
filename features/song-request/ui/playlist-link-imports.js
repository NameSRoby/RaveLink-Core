window.installPlaylistLinkImports = function installPlaylistLinkImports(readTidal) {
  const original = $('import').onclick;
  $('importUrl').placeholder = 'YouTube, SoundCloud or TIDAL playlist URL';
  $('import').title = 'Import a public YouTube or SoundCloud playlist, or review a TIDAL playlist';
  const preview = document.createElement('div'); preview.id = 'playlistLinkPreview'; $('importState').after(preview);
  let sdk;
  function loadSdk() {
    if (window.SC?.Widget) return Promise.resolve();
    return sdk ||= new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'https://w.soundcloud.com/player/api.js';
      const timer = setTimeout(() => { script.remove(); sdk = null; reject(new Error('SoundCloud did not respond. Try again.')); }, 12000);
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); sdk = null; reject(new Error('SoundCloud player could not load.')); }; document.head.append(script);
    });
  }
  async function sounds(url) {
    await loadSdk();
    const frame = document.createElement('iframe'); frame.title = 'SoundCloud playlist preview'; frame.style.cssText = 'width:100%;height:166px;border:0';
    frame.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(url) + '&auto_play=false'; preview.replaceChildren(frame);
    const widget = SC.Widget(frame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('SoundCloud did not return this playlist. It may be private or unavailable.')), 15000);
      function finish(error, rows) { clearTimeout(timer); widget.unbind(SC.Widget.Events.READY); widget.unbind(SC.Widget.Events.ERROR); widget.pause(); error ? reject(error) : resolve(rows); }
      widget.bind(SC.Widget.Events.PLAY, () => widget.pause());
      widget.bind(SC.Widget.Events.ERROR, () => finish(new Error('SoundCloud could not read this public playlist.')));
      widget.bind(SC.Widget.Events.READY, () => widget.getSounds(rows => finish(null, rows)));
    });
  }
  $('import').onclick = async event => {
    const raw = $('importUrl').value.trim(), name = $('importName').value.trim(); let url;
    try { url = new URL(raw); } catch { return original(event); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) { notice('Use a full HTTPS playlist link.', true); return; }
    if (['tidal.com', 'www.tidal.com', 'listen.tidal.com'].includes(url.hostname)) { await readTidal(raw, name); return; }
    if (!['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(url.hostname)) return original(event);
    if (!/^\/[\w-]+\/sets\/[\w-]+\/?$/.test(url.pathname)) { notice('Use a public SoundCloud playlist link containing /sets/.', true); return; }
    $('import').disabled = true; clearTimeout(pollTimer);
    try {
      notice('Reading SoundCloud playlist…');
      const rows = await sounds('https://soundcloud.com' + url.pathname);
      const api = async (method, payload) => { const reply = await call('song.soundcloud.player.v1', method, payload); if (!reply.ok) throw new Error(reply.code || 'SoundCloud import failed'); return reply; };
      const upload = await api('import-start', { name: name || decodeURIComponent(url.pathname.split('/').filter(Boolean).pop()).replaceAll('-', ' ') });
      for (let offset = 0; offset < rows.length; offset += 20) {
        const compact = rows.slice(offset, offset + 20).map(row => ({ id: String(row.id), title: String(row.title || '').slice(0, 200), duration: row.duration, policy: row.policy || '', permalink_url: row.permalink_url || '', artwork_url: row.artwork_url || '', user: { username: String(row.user?.username || '').slice(0, 100) } }));
        await api('import-append', { uploadId: upload.uploadId, offset, sounds: compact });
      }
      await api('import-save', { uploadId: upload.uploadId }); await refresh(); notice('Imported ' + rows.length + ' SoundCloud tracks. Select the playlist in Library or open Transfers to match it to another service.');
    } catch (error) { notice(error.message, true); } finally { preview.replaceChildren(); $('import').disabled = false; }
  };
};
