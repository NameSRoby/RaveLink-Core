const crypto = require('node:crypto');
const { normalizeTrack, text } = require('./portable-track');

module.exports = function transfers({ context, library, saveLibrary }) {
  const plan = require('./playlist-transfer-plan');
  const match = require('./playlist-transfer-catalog')(context);
  const store = require('./playlist-transfer-store')(context);
  const limit = () => library.status().limits.tracksPerCollection;
  const provider = payload => context.callCapability('tidal.playlists.host.v1', 'action', payload, { timeoutMs: 15000 });
  let job = null, rows = [], work = null, timer = null, stopped = false, busy = false, recovering = false;
  const save = () => store.index(job);
  const csvUpload = require('./playlist-csv-upload')(install, limit);
  const writer = require('./playlist-transfer-writer')({ provider, save, get: () => ({ job, rows }) });
  const mutable = () => !work && !['reading', 'matching', 'writing', 'uncertain'].includes(job?.state);
  async function install(nextRows, name, kind = 'csv') {
    if (!mutable()) throw new Error('transfer_busy');
    if (nextRows.length > limit()) throw new Error('playlist_track_limit');
    const previousJob = job, previousRows = rows;
    rows = nextRows; job = { version: 1, id: crypto.randomUUID(), kind, sourceKind: kind, sourceProviders: [...new Set(nextRows.map(row => row.track?.candidate?.provider).filter(Boolean))], name: text(name, 80) || 'Imported playlist', state: 'review', count: rows.length, processed: 0, written: 0, error: '', intent: '', destinationId: '', cursor: '' };
    try { await store.save(job, rows); } catch (error) { const failed = job; job = previousJob; rows = previousRows; await store.remove(failed).catch(() => {}); throw error; }
    await store.remove(previousJob);
  }
  function schedule() { if (!stopped && !timer && ['reading', 'matching', 'writing'].includes(job?.state)) { timer = setTimeout(() => { timer = null; work = tick().finally(async () => { if (job.control && !['uncertain', 'complete'].includes(job.state)) { job.resumeState = job.state; job.state = job.control === 'pause' ? 'paused' : 'canceled'; delete job.control; await save().catch(() => {}); } work = null; schedule(); }); }, 1000); timer.unref?.(); } }
  async function tick() {
    try {
      if (job.retryAt > Date.now()) return;
      if (job.state === 'writing') return await writer.step();
      if (job.state === 'reading') {
        const reply = await provider({ action: 'read', id: job.sourceId, cursor: job.cursor });
        if (!reply.ok) throw new Error(reply.error);
        if (rows.length + reply.tracks.length > limit() || job.pages >= 1000) throw new Error('playlist_track_limit');
        const before = rows.length;
        rows.push(...reply.tracks.map(track => ({ track: normalizeTrack(track), error: track ? '' : 'Unavailable or non-track playlist item', choices: [], selected: null, include: Boolean(track) })));
        job.count = rows.length; job.cursor = reply.cursor; job.pages++; job.processed = rows.length;
        for (let index = Math.floor(before / 5) * 5; index < rows.length; index += 5) await store.page(job, rows, index);
        if (!reply.cursor) job.state = 'review'; await save(); return;
      }
      await require('./playlist-transfer-match-step')({ job, rows, match, store, save });
    } catch (error) { job.error = text(error.message, 160); job.state = job.intent ? 'uncertain' : 'paused'; await save().catch(() => {}); }
  }
  async function load() {
    recovering = true;
    try { const stored = await store.load(); if (!stored) return; job = stored.job; rows = stored.rows;
      if (job.intent || job.state === 'writing') { job.state = 'uncertain'; job.error = 'Check destination before resuming'; }
      schedule();
    } catch { job = null; rows = []; }
    finally { recovering = false; }
  }
  const status = (offset, input = {}) => ({ ok: true, recovering, job: job ? { ...job, selected: rows.filter(row => row.selected).length, valid: rows.filter(row => row.track && row.include !== false).length } : null,
    ...require('./playlist-transfer-review').page(rows, { ...input, offset }) });
  async function handle(payload = {}) {
    const offset = Math.max(0, Math.min(10000, Number(payload.offset) || 0));
    if (payload.action === 'status') return status(offset, payload);
    if (recovering) return { ok: false, code: 'transfer_recovering' };
    if (['list_exports', 'open_exports'].includes(payload.action)) return context.callCapability('playlist.exports.host.v1', 'action', { action: payload.action === 'list_exports' ? 'list' : 'open' }, { timeoutMs: 5000 });
    if (payload.action === 'account') return provider({ action: 'status' });
    if (payload.action === 'list_tidal') return provider({ action: 'list', cursor: payload.cursor || '' });
    if (busy) return { ok: false, code: 'transfer_busy' };
    busy = true;
    try { return await mutate(payload, offset); }
    catch (error) { return { ok: false, code: text(error.message, 160) || 'transfer_failed' }; }
    finally { busy = false; }
  }
  async function mutate(input, offset) {
    if (input.action === 'set_limit') { const result = library.setTrackLimit(input.trackLimit); if (!result.ok) throw new Error(result.code); await saveLibrary(); return { ok: true }; }
    if (input.action === 'save_export') return require('./playlist-transfer-export')({ context, library, job, rows, input });
    if (['export_csv', 'export_report'].includes(input.action)) return require('./playlist-transfer-export-page')({ library, job, rows, input, offset });
    if (input.action.startsWith('upload_') || input.action === 'preview_csv') {
      if (!mutable()) throw new Error('transfer_busy');
      return await csvUpload(input) || status(0);
    }
    if (input.action === 'source_library') {
      const collection = library.get(input.collectionId); if (!collection) throw new Error('playlist_not_found');
      await install(collection.tracks.map(track => ({ track: structuredClone(track), choices: [], selected: null, include: true, error: '' })), input.name || collection.name, 'local'); return status(0);
    }
    if (input.action === 'read_tidal') {
      let sourceId = String(input.id || '');
      if (sourceId.startsWith('https://')) { const url = new URL(sourceId); if (!['tidal.com', 'listen.tidal.com', 'www.tidal.com'].includes(url.hostname)) throw new Error('tidal_playlist_invalid'); sourceId = /^\/(?:browse\/)?playlist\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1] || ''; }
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(sourceId)) throw new Error('tidal_playlist_invalid');
      await install([], input.name || 'TIDAL playlist', 'tidal'); job.sourceId = sourceId; job.state = 'reading'; job.pages = 0; await save(); schedule(); return status(0);
    }
    if (!job) throw new Error('transfer_not_found');
    if (input.jobId !== job.id) throw new Error('transfer_changed');
    if (input.action === 'pause' || input.action === 'cancel') {
      if (work) { job.control = input.action; await save(); return status(offset); }
      if (job.state === 'uncertain') throw new Error('tidal_playlist_reconcile_required');
      job.resumeState = job.state; job.state = input.action === 'pause' ? 'paused' : 'canceled'; clearTimeout(timer); timer = null; await save(); return status(offset);
    }
    if (input.action === 'reconcile') { if (work || job.state !== 'uncertain') throw new Error('transfer_busy'); await writer.reconcile(); return status(offset); }
    if (input.action === 'resume') {
      if (job.state !== 'paused' || job.intent) throw new Error('transfer_busy');
      job.state = job.destinationId || job.resumeState === 'writing' ? 'writing' : job.kind === 'matching' ? 'matching' : 'reading'; job.error = ''; await save(); schedule(); return status(offset);
    }
    if (!mutable()) throw new Error('transfer_busy');
    if (job.targetLocked && ['match_tidal', 'match', 'choose', 'accept_matches', 'save_local', 'save_matched', 'write_tidal', 'plan'].includes(input.action)) throw new Error('transfer_destination_locked');
    if (input.action === 'plan') { const options = { name: input.name || job.name, groupBy: input.groupBy || 'single', splitSize: input.splitSize || 500 }; return { ok: true, plan: plan(rows, options).map(group => ({ name: group.name, count: group.ids.length })) }; }
    if (input.action === 'match_tidal' || input.action === 'match') {
      const target = input.action === 'match_tidal' ? 'tidal' : input.target;
      if (!['tidal', 'youtube', 'soundcloud'].includes(target)) throw new Error('transfer_provider_invalid');
      job.target = target; job.adaptive = input.adaptive !== false; job.retryAt = 0; job.error = '';
      job.kind = 'matching'; job.name = text(input.name || job.name, 80); job.state = 'matching'; job.processed = 0;
      rows.forEach(row => { row.choices = []; row.selected = null; row.manuallyReviewed = false; }); await store.save(job, rows); schedule(); return status(0);
    }
    if (input.action === 'choose') {
      const row = rows[input.index]; if (!row) throw new Error('transfer_row_invalid');
      row.manuallyReviewed = true; row.include = input.choice !== -1; row.selected = row.choices[input.choice] || null; await store.page(job, rows, input.index); await save(); return status(offset);
    }
    if (input.action === 'accept_matches') {
      require('./playlist-transfer-review').accept(rows, input.threshold ?? 95); job.threshold = input.threshold ?? 95; await store.save(job, rows); return status(offset);
    }
    if (input.action === 'save_local') {
      const tracks = rows.filter(row => row.track && row.include !== false).map(row => row.track);
      if (!tracks.length) throw new Error('playlist_empty');
      if (!library.get(job.collectionId)) { const created = library.create({ name: input.name || job.name, provider: job.kind === 'tidal' ? 'tidal' : 'local' }); if (!created.ok) throw new Error(created.code); job.collectionId = created.collection.id; await save(); }
      const result = library.replace(job.collectionId, tracks); if (!result.ok) throw new Error(result.code);
      await saveLibrary(); job.state = 'complete'; await save(); return status(offset);
    }
    if (input.action === 'save_matched') {
      await require('./playlist-transfer-local')({ job, rows, library, options: { name: input.name || job.name, groupBy: input.groupBy, splitSize: input.splitSize }, saveLibrary, save }); return status(offset);
    }
    if (input.action === 'write_tidal') {
      if (job.target && job.target !== 'tidal' || rows.some(row => row.selected && row.selected.provider !== 'tidal')) throw new Error('transfer_review_required');
      if (job.destinationId || !rows.some(row => row.selected)) throw new Error('transfer_review_required');
      await store.save(job, rows);
      job.groupBy = input.groupBy || 'single'; job.splitSize = input.splitSize || 500; job.name = text(input.name || job.name, 80); plan(rows, job); job.targetLocked = true; job.groupIndex = 0; job.destinations = []; job.completedWritten = 0; job.state = 'writing'; job.resumeState = 'writing'; job.written = 0; await save(); schedule(); return status(offset);
    }
    throw new Error('transfer_action_invalid');
  }
  return { handle, load, stop() { stopped = true; clearTimeout(timer); } };
};
