const crypto = require('node:crypto'), express = require('express');
const { trackUri } = require('./catalog.cjs');
const playlists = require('./playlist-reader.cjs');
const liveState = require('./live-state.cjs');
const ID = /^[A-Za-z0-9_-]{1,100}$/;
module.exports = function createSpotifyHostBridge(options = {}) {
  const token = options.token || crypto.randomBytes(32).toString('hex'), sessionId = crypto.randomUUID();
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('spotify_pairing_invalid');
  const timeoutMs = Math.max(50, Math.min(30000, options.timeoutMs || 10000));
  const jobs = new Map();let clientId = '', lastSeen = 0, closed = false, lastError = '';
  const authorized = input => { const bytes = Buffer.from(String(input || ''));return bytes.length === token.length && crypto.timingSafeEqual(bytes, Buffer.from(token)); };
  function status() {
    return { ok: true, prototype: true, lastError, lastSeenAt: lastSeen, connected: !closed && Boolean(clientId) && Date.now() - lastSeen < 10000, pending: [...jobs.values()].filter(row => !row.done).length, reviewRequired: [...jobs.values()].filter(row => row.result?.error === 'spotify_delivery_unconfirmed').length };
  }
  function normalize(kind, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (kind === 'playlist') return playlists.normalize(raw);
    if (kind === 'search' && typeof raw.query === 'string' && raw.query.trim() && raw.query.length <= 300 && !/https?:\/\/|spotify:/i.test(raw.query)) return { query: raw.query.trim() };
    if (kind === 'control' && ['pause', 'resume', 'skip'].includes(raw.action) && (raw.action !== 'skip' || typeof raw.currentUid === 'string' && raw.currentUid.length > 0 && raw.currentUid.length <= 200)) return { action: raw.action, ...(raw.action === 'skip' ? { currentUid: raw.currentUid } : {}) };
    const uri = trackUri(raw.uri);if (!uri) return null;
    if (kind === 'append') return { uri, ...(typeof raw.uid === 'string' && /^[a-f0-9]{32}$/.test(raw.uid) ? { uid: raw.uid } : {}) };
    if (kind === 'lookup') return { uri };
    if (kind === 'remove' && typeof raw.uid === 'string' && raw.uid.length > 0 && raw.uid.length <= 200) return { uri, uid: raw.uid };
    return null;
  }
  function finish(job, result) { if (job.done) return;clearTimeout(job.timer);job.done = true;job.result = result;job.resolve(result); }
  function invoke(kind, payload, requestId) {
    const normalized = normalize(kind, payload);
    if (typeof requestId !== 'string' || !ID.test(requestId) || !normalized) return Promise.resolve({ ok: false, error: 'spotify_command_invalid' });
    const signature = JSON.stringify([kind, normalized]), old = jobs.get(requestId);
    if (old) return old.signature === signature ? old.promise : Promise.resolve({ ok: false, error: 'spotify_request_id_conflict' });
    if (!status().connected) return Promise.resolve({ ok: false, error: 'spotify_companion_unavailable' });
    for (const [id, item] of jobs) if (item.done && (item.kind === 'search' || item.kind === 'playlist' && ['list','read'].includes(item.payload.action))) jobs.delete(id);
    if (jobs.size >= 2048 || status().pending >= 8) return Promise.resolve({ ok: false, error: 'spotify_bridge_busy' });
    const job = { id: requestId, kind, payload: normalized, signature, lease: crypto.randomBytes(16).toString('hex'), issued: false, done: false };
    job.promise = new Promise(resolve => { job.resolve = resolve; });jobs.set(requestId, job);
    job.timer = setTimeout(() => finish(job, { ok: false, error: job.issued && kind !== 'search' ? 'spotify_delivery_unconfirmed' : 'spotify_command_expired', retrySafe: kind === 'search' || !job.issued }), timeoutMs);
    return job.promise;
  }
  function acceptResult(job, raw) {
    if (raw?.ok === false && ['spotify_current_changed', 'spotify_playback_restricted', 'spotify_native_queue_rejected'].includes(raw.error)) return { ok: false, error: raw.error, retrySafe: false };
    if (job.kind === 'playlist') return raw?.ok === false ? { ok: false, error: /^spotify_playlist_[a-z_]+$/.test(raw.error || '') ? raw.error : 'spotify_playlist_read_failed' } : playlists.result(raw, job.payload);
    if (raw?.ok === false) {
      const known = new Set(['spotify_local_device_unverified', 'spotify_track_invalid', 'spotify_queue_append_unavailable', 'spotify_queue_removal_unavailable', 'spotify_queue_shape_unavailable', 'spotify_queue_entry_id_required', 'spotify_queue_entry_not_found', 'spotify_delivery_unconfirmed', 'spotify_removal_unconfirmed', 'spotify_search_query_invalid', 'spotify_search_unavailable', 'spotify_desktop_search_rejected', 'spotify_search_shape_unavailable']);
      return { ok: false, error: known.has(raw.error) ? raw.error : 'spotify_companion_action_failed', retrySafe: false };
    }
    if (raw?.ok !== true) return null;
    if (job.kind === 'append' && raw.delivery === 'confirmed' && raw.uri === job.payload.uri && typeof raw.uid === 'string' && raw.uid && raw.uid.length <= 200) return { ok: true, delivery: 'confirmed', uri: raw.uri, uid: raw.uid };
    if (job.kind === 'remove' && raw.removed === true) return { ok: true, removed: true };
    if (job.kind === 'control' && raw.accepted === true) return { ok: true, accepted: true };
    if (['search', 'lookup'].includes(job.kind) && Array.isArray(raw.candidates) && raw.candidates.length <= 10) {
      const candidates = raw.candidates.map(row => {
        const uri = trackUri(row?.uri || row?.providerItemId);if (!uri || typeof row.title !== 'string' || !row.title.trim()) return null;
        return { provider: 'spotify', providerItemId: uri.slice(14), uri, title: row.title.slice(0, 300), artists: Array.isArray(row.artists) ? row.artists.filter(name => typeof name === 'string').slice(0, 8).map(name => name.slice(0, 100)) : [], album: typeof row.album === 'string' ? row.album.slice(0, 200) : '', durationMs: Math.max(0, Math.min(86400000, Number(row.durationMs) || 0)), sourceUrl: 'https://open.spotify.com/track/' + uri.slice(14) };
      });
      return candidates.every(Boolean) ? { ok: true, candidates } : null;
    }
    return null;
  }
  function router() {
    const router = express.Router();
    router.use((req, res, next) => {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress), origin = req.get('origin');
      if (!local || origin && origin !== 'https://xpui.app.spotify.com') return res.status(403).json({ ok: false, error: 'spotify_bridge_origin_rejected' });
      if (origin) { res.set('access-control-allow-origin', origin);res.vary('Origin');res.set('access-control-allow-headers', 'authorization, content-type');res.set('access-control-allow-methods', 'POST, OPTIONS');res.set('access-control-allow-private-network', 'true'); }
      res.set('cache-control', 'no-store');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      const supplied = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') || '')?.[1];
      if (closed || req.method !== 'POST' || !authorized(supplied)) return res.status(401).json({ ok: false, error: 'spotify_pairing_required' });
      next();
    });
    router.use(express.json({ limit: '16kb', strict: true }));
    router.post('/hello', (req, res) => {
      const id = req.body?.clientId;
      if (typeof id !== 'string' || !ID.test(id) || clientId && clientId !== id && Date.now() - lastSeen < 10000) return res.status(409).json({ ok: false, error: 'spotify_companion_conflict' });
      clientId = id;lastSeen = Date.now();res.json({ ok: true, sessionId });
    });
    router.use((req, res, next) => {
      if (!clientId || req.body?.clientId !== clientId || req.body?.sessionId !== sessionId) return res.status(409).json({ ok: false, error: 'spotify_companion_session_required' });
      lastSeen = Date.now();
      if (req.body?.snapshot) {
        const snapshot = liveState(req.body.snapshot);
        if (!snapshot) { lastError = 'spotify_snapshot_invalid';return res.status(400).json({ ok: false, error: lastError }); }
        lastError = '';
        options.onSnapshot?.(snapshot);
      }
      lastSeen = Date.now();next();
    });
    router.post('/next', (req, res) => {
      const job = [...jobs.values()].find(row => !row.done);
      if (!job || job.issued) return res.json({ ok: true, command: null });
      job.issued = true;res.json({ ok: true, command: { id: job.id, lease: job.lease, kind: job.kind, payload: job.payload } });
    });
    router.post('/result', (req, res) => {
      const job = jobs.get(req.body.id);
      if (!job || !job.issued || job.lease !== req.body.lease) return res.status(409).json({ ok: false, error: 'spotify_result_unknown' });
      if (job.done) return res.json({ ok: true, duplicate: true, reviewRequired: !job.result.ok });
      const result = acceptResult(job, req.body.result);
      if (!result) return res.status(400).json({ ok: false, error: 'spotify_result_invalid' });
      finish(job, result);res.json({ ok: true });
    });
    router.use((error, req, res, next) => { if (res.headersSent) return next(error);res.status(400).json({ ok: false, error: 'spotify_bridge_payload_invalid' }); });
    return router;
  }
  function close() { closed = true;for (const job of jobs.values()) if (!job.done) finish(job, { ok: false, error: job.issued && job.kind !== 'search' ? 'spotify_delivery_unconfirmed' : 'spotify_companion_unavailable', retrySafe: !job.issued }); }
  return { status, invoke, router, close, pairing: () => ({ token, sessionId }) };
};
