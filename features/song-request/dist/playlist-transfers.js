const crypto = require('node:crypto');
const { text } = require('./portable-track');

module.exports = function transfers({ context, library, saveLibrary }) {
  const plan = require('./playlist-transfer-plan');
  const match = require('./playlist-transfer-catalog')(context);
  const store = require('./playlist-transfer-store')(context);
  const sources = require('./playlist-transfer-sources')(context);
  const limit = () => library.status().limits.tracksPerCollection;
  const batch = require('./playlist-transfer-batch')({library,sources,limit});
  const tidal = payload => context.callCapability('tidal.playlists.host.v1', 'action', payload, { timeoutMs: 15000 });
  const provider = payload => job?.target === 'spotify'
    ? sources.spotify({ ...payload, ...(payload.cursor !== undefined ? { offset: Number(payload.cursor || 0) } : {}), ...(payload.action === 'create' ? { name: payload.name.slice(0,100) } : {}) }) : tidal(payload);
  let job = null, rows = [], work = null, timer = null, stopped = false, busy = false, recovering = false;
  const save = () => store.index(job);
  const csvUpload = require('./playlist-csv-upload')(install, limit);
  const writer = require('./playlist-transfer-writer')({ provider, save, get: () => ({ job, rows }) });
  const mutable = () => !work && !['reading', 'matching', 'writing', 'uncertain'].includes(job?.state);
  const requireMutable = () => { if(!mutable())throw Error('transfer_busy'); };
  async function install(nextRows, name, kind = 'csv') {
    requireMutable();
    if (nextRows.length > limit()) throw new Error('playlist_track_limit');
    const previousJob = job, previousRows = rows;
    rows = nextRows; job = { version: 1, id: crypto.randomUUID(), kind, sourceKind: kind, sourceProviders: [...new Set(nextRows.map(row => row.track?.candidate?.provider).filter(Boolean))], name: text(name, 80) || 'Imported playlist', state: 'review', count: rows.length, processed: 0, written: 0, error: '', intent: '', destinationId: '', cursor: '' };
    try { await store.save(job, rows); } catch (error) { const failed = job; job = previousJob; rows = previousRows; await store.remove(failed).catch(() => {}); throw error; }
    await store.remove(previousJob);
  }
  function schedule() { if (!stopped && !timer && ['reading', 'matching', 'writing'].includes(job?.state)) { timer = setTimeout(() => { timer = null; work = tick().finally(async () => { if (job.control && !['uncertain', 'complete'].includes(job.state)) { await sources.cancel(job, job.control);job.resumeState = job.state; job.state = job.control === 'pause' ? 'paused' : 'canceled'; delete job.control; await save().catch(() => {}); } work = null; schedule(); }); }, 1000); timer.unref?.(); } }
  async function tick() {
    try {
      if (job.retryAt > Date.now()) return;
      if (job.state === 'writing') return await writer.step();
      if (job.state === 'reading') return await batch.read({job,rows,store,save});
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
    if (payload.action === 'account') return tidal({ action: 'status' });
    if (payload.action === 'list_spotify') return sources.spotify({ action: 'list', offset: Number(payload.cursor || 0) });
    if (payload.action === 'list_tidal') return tidal({ action: 'list', cursor: payload.cursor || '' });
    if (busy) return { ok: false, code: 'transfer_busy' };
    busy = true;
    try { return await mutate(payload, offset); }
    catch (error) { return { ok: false, code: text(error.message, 160) || 'transfer_failed' }; }
    finally { busy = false; }
  }
  async function mutate(input, offset) {
    if(input.action==='source_batch'){
      requireMutable();
      const prepared=await batch.prepare(input);
      await install(prepared.rows,input.name||(prepared.queue.length===1?prepared.queue[0].name:prepared.queue.length+' playlists'),prepared.kind);
      job.sourcePlaylists=prepared.queue;job.sourceIndex=0;job.groupBy=input.groupBy==='single'?'single':'playlist';
      if(prepared.first){const {kind,name,...source}=prepared.first;Object.assign(job,source,{sourceProviders:[kind],customName:true,state:'reading',pages:0});}
      await save();schedule();return status(0);
    }
    if (input.action === 'set_limit') { const result = library.setTrackLimit(input.trackLimit); if (!result.ok) throw new Error(result.code); await saveLibrary(); return { ok: true }; }
    if (input.action === 'save_export') return require('./playlist-transfer-export')({ context, library, job, rows, input });
    if (['export_csv', 'export_report'].includes(input.action)) return require('./playlist-transfer-export-page')({ library, job, rows, input, offset });
    if (input.action.startsWith('upload_') || input.action === 'preview_csv') {
      requireMutable();
      return await csvUpload(input) || status(0);
    }
    if (input.action === 'source_library') {
      const collection = library.get(input.collectionId); if (!collection) throw new Error('playlist_not_found');
      await install(collection.tracks.map(track => ({ track: structuredClone(track), choices: [], selected: null, include: true, error: '' })), input.name || collection.name, 'local'); return status(0);
    }
    if (['read_spotify','read_youtube','read_tidal'].includes(input.action)) {
      requireMutable();
      const {kind,name,...source} = await sources.begin(input, limit());
      try { await install([], name, kind); } catch (error) { if(source.sourceJobId) await sources.cancelYoutube(source).catch(()=>{});throw error; }
      Object.assign(job, source, {sourceProviders:[kind],customName:Boolean(input.name),state:'reading',pages:0});await save();schedule();return status(0);
    }
    if (!job) throw new Error('transfer_not_found');
    if (input.jobId !== job.id) throw new Error('transfer_changed');
    if(input.action==='review_source'){
      requireMutable();
      const original=job;
      await install(rows.map(row=>({...structuredClone(row),choices:[],selected:null,manuallyReviewed:false})),job.name,job.sourceKind);
      job.sourcePlaylists=original.sourcePlaylists;job.groupBy=original.groupBy;await save();return status(0);
    }
    if (input.action === 'dismiss') { if (job.state !== 'complete') throw Error('transfer_busy');job.dismissed = true;await save();return status(offset); }
    if (input.action === 'pause' || input.action === 'cancel') {
      if (work) { job.control = input.action; await save(); return status(offset); }
      if (job.state === 'uncertain') throw new Error('tidal_playlist_reconcile_required');
      await sources.cancel(job, input.action);
      job.resumeState = job.state; job.state = input.action === 'pause' ? 'paused' : 'canceled'; clearTimeout(timer); timer = null; await save(); return status(offset);
    }
    if (input.action === 'reconcile') { if (work || job.state !== 'uncertain') throw new Error('transfer_busy'); await writer.reconcile(job.target === 'spotify' && input.destinationId ? sources.spotifyId(input.destinationId) : ''); return status(offset); }
    if (input.action === 'resume') {
      if (job.state !== 'paused' || job.intent) throw new Error('transfer_busy');
      job.state = job.destinationId || job.resumeState === 'writing' ? 'writing' : job.kind === 'matching' ? 'matching' : 'reading'; job.error = ''; await save(); schedule(); return status(offset);
    }
    requireMutable();
    if (job.targetLocked && ['match_tidal', 'match', 'choose', 'accept_matches', 'save_local', 'save_matched', 'write_tidal', 'write_spotify', 'plan'].includes(input.action)) throw new Error('transfer_destination_locked');
    if (input.action === 'plan') { const options = { name: input.name || job.name, groupBy: input.groupBy || job.groupBy || 'single', splitSize: input.splitSize || 500 }; return { ok: true, plan: plan(rows, options).map(group => ({ name: group.name, count: group.ids.length })) }; }
    if (input.action === 'match_tidal' || input.action === 'match') {
      const target = input.action === 'match_tidal' ? 'tidal' : input.target;
      if (!['tidal', 'youtube', 'soundcloud', 'spotify'].includes(target)) throw new Error('transfer_provider_invalid');
      if(job.kind==='matching'&&job.target===target&&job.processed>=rows.length&&job.state==='review')return status(offset);
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
      if(job.sourcePlaylists?.length>1){await require('./playlist-transfer-local')({job,rows,library,options:{name:input.name||job.name,groupBy:input.groupBy||job.groupBy||'playlist'},saveLibrary,save,original:true});return status(offset);}
      const tracks = rows.filter(row => row.track && row.include !== false).map(row => row.track);
      if (!tracks.length) throw new Error('playlist_empty');
      if (!library.get(job.collectionId)) { const created = library.create({ name: input.name || job.name, provider: job.kind === 'tidal' ? 'tidal' : 'local' }); if (!created.ok) throw new Error(created.code); job.collectionId = created.collection.id; await save(); }
      const result = library.replace(job.collectionId, tracks); if (!result.ok) throw new Error(result.code);
      await saveLibrary(); job.state = 'complete'; await save(); return status(offset);
    }
    if (input.action === 'save_matched') {
      await require('./playlist-transfer-local')({ job, rows, library, options: { name: input.name || job.name, groupBy: input.groupBy || job.groupBy, splitSize: input.splitSize }, saveLibrary, save }); return status(offset);
    }
    if (input.action === 'write_tidal' || input.action === 'write_spotify') {
      const target = input.action === 'write_spotify' ? 'spotify' : 'tidal';
      if (job.target && job.target !== target || rows.some(row => row.selected && row.selected.provider !== target)) throw new Error('transfer_review_required');
      if (job.destinationId || !rows.some(row => row.selected)) throw new Error('transfer_review_required');
      await store.save(job, rows);
      job.target = target; job.groupBy = input.groupBy || job.groupBy || 'single'; job.splitSize = input.splitSize || 500; job.name = text(input.name || job.name, 80); plan(rows, job); job.targetLocked = true; job.groupIndex = 0; job.destinations = []; job.completedWritten = 0; job.state = 'writing'; job.resumeState = 'writing'; job.written = 0; await save(); schedule(); return status(offset);
    }
    throw new Error('transfer_action_invalid');
  }
  return { handle, load, stop() { stopped = true; clearTimeout(timer); } };
};
