const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, exportCsv, parseCells } = require('../features/song-request/dist/playlist-csv');
const { createPlaylistLibrary } = require('../features/song-request/dist/playlist-library');
const createTransfers = require('../features/song-request/dist/playlist-transfers');
const track = (provider = 'tidal', providerItemId = '123') => ({ provider, providerItemId, title: 'Example', artists: ['Artist'], album: 'Album', durationMs: 180000 });

test('portable library preserves provider, intentional duplicates and occurrence IDs across migration', () => {
  const library = createPlaylistLibrary(); const list = library.create({ name: 'Portable' }).collection;
  library.replace(list.id, [track(), track(), track('youtube', 'abcdefghijk'), { title: 'Unresolved', artists: ['Artist'], provider: 'local' }]);
  const original = library.active().tracks;
  assert.deepEqual(original.map(row => row.candidate.provider), ['tidal', 'tidal', 'youtube', 'local']);
  assert.equal(new Set(original.map(row => row.id)).size, 4);
  const snapshot = library.exportStorage(), restored = createPlaylistLibrary();
  restored.restore(snapshot.index, { [list.id]: snapshot.pages.flatMap(([, rows]) => rows) });
  assert.deepEqual(restored.active().tracks, original);
});

test('CSV handles quoted multiline cells, BOM, delimiters, mappings and safe reversible spreadsheet export', () => {
  const source = [{ candidate: { ...track(), title: '=SUM(1,2)', artists: ['AC, DC'], album: 'a "quoted"\nrelease' } }, { candidate: { ...track(), title: "'Original apostrophe" } }];
  const csv = exportCsv(source);
  assert.match(csv, /"'=SUM/);
  const parsed = parseCsv('\ufeff' + csv);
  assert.deepEqual(parsed.map(row => row.track.candidate.title), source.map(row => row.candidate.title));
  assert.equal(parsed[0].track.candidate.album, 'a "quoted" release');
  assert.equal(parsed[0].track.candidate.artists[0], 'AC, DC');
  const custom = parseCsv('Song;Artist\r\nExample;Artist', { delimiter: ';', mapping: { title: 'song', artists: 'artist' } });
  assert.equal(custom[0].track.candidate.provider, 'local');
  assert.throws(() => parseCells('title,artists\n"broken,Artist'), /csv_quotes_invalid/);
  assert.throws(() => parseCsv('title,artists\n' + 'x,y\n'.repeat(10001)), /csv_row_limit/);
  assert.throws(() => parseCsv('x'.repeat(8388609)), /csv_file_limit/);
  assert.equal(parseCsv('title,artists\nExample,Artist,extra')[0].track, null);
});

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const storage = new Map(), library = createPlaylistLibrary(); library.ensureChatCollection();
  const native = { created: 0, ids: [], fail: false, calls: [] };
  const context = { callCapability: async (cap, method, value) => {
    if (cap === 'ravelink.storage.v1') {
      if (method === 'get') return { ok: true, found: storage.has(value.key), value: structuredClone(storage.get(value.key)) };
      if (method === 'remove') storage.delete(value.key); else storage.set(value.key, structuredClone(value.value));
      return { ok: true };
    }
    assert.equal(cap, 'tidal.playlists.host.v1'); native.calls.push(structuredClone(value));
    if (value.action === 'track') return { ok: true, candidate: track('tidal', value.id) };
    if (value.action === 'search') return { ok: true, candidates: [track()] };
    if (value.action === 'create') { native.created++; return { ok: true, id: 'destination' }; }
    if (value.action === 'append') { native.ids.push(...value.ids); return native.fail ? { ok: false, error: 'tidal_playlist_write_uncertain' } : { ok: true }; }
    if (value.action === 'read') return { ok: true, tracks: native.ids.map(id => track('tidal', id)), cursor: '' };
    if (value.action === 'status') return { ok: true, connected: true, playlistsEnabled: true };
    throw new Error('Unexpected action: ' + value.action);
  } };
  let worker = createTransfers({ context, library, saveLibrary: async () => {} });
  t.after(() => worker.stop());
  const call = async (action, payload = {}) => {
    const state = await worker.handle({ action: 'status' });
    return worker.handle({ action, jobId: state.job?.id, ...payload });
  };
  const run = async (ticks = 10) => { for (let index = 0; index < ticks; index++) { t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); } };
  return { library, native, storage, call, run, restart: async () => { worker.stop(); worker = createTransfers({ context, library, saveLibrary: async () => {} }); await worker.load(); } };
}

test('CSV preview is explicit, saves a new local collection, and never changes the selected playlist', async t => {
  const f = fixture(t), selected = f.library.status().selectedId;
  await f.call('upload_begin', { name: 'CSV' });
  await f.call('upload_chunk', { offset: 0, chunk: 'title,artists\nExample,Artist\nExample,Artist' });
  assert.deepEqual((await f.call('upload_headers')).headers, ['title', 'artists']);
  assert.equal((await f.call('preview_csv')).job.count, 2);
  assert.equal(f.library.status().collections.length, 1);
  await f.call('save_local');
  assert.equal(f.library.status().collections.length, 2);
  assert.equal(f.library.status().selectedId, selected);
  const imported = f.library.status().collections.find(row => row.name === 'CSV');
  assert.equal(f.library.get(imported.id).tracks.length, 2);
  assert.equal(f.native.calls.length, 0);
  assert.equal((await f.call('choose', { jobId: 'stale', index: 0, choice: 0 })).code, 'transfer_changed');
});

test('TIDAL transfers preserve FIFO duplicates, require review, persist uncertain writes and reconcile after restart', async t => {
  const f = fixture(t), list = f.library.create({ name: 'Export me' }).collection;
  f.library.replace(list.id, [track(), track()]);
  await f.call('source_library', { collectionId: list.id });
  await f.call('match_tidal'); await f.run(3);
  assert.equal((await f.call('status')).job.state, 'review');
  assert.equal(f.native.created, 0);
  f.native.fail = true;
  assert.equal((await f.call('write_tidal')).ok, true); await f.run(2);
  assert.equal((await f.call('status')).job.state, 'uncertain');
  assert.deepEqual(f.native.ids, ['123', '123']);
  await f.restart();
  assert.equal((await f.call('resume')).code, 'transfer_busy');
  assert.equal((await f.call('reconcile')).ok, true);
  f.native.fail = false; await f.call('resume'); await f.run(2);
  const final = await f.call('status');
  assert.equal(final.job.state, 'complete'); assert.equal(final.job.verified, true);
  assert.equal(f.native.created, 1); assert.deepEqual(f.native.ids, ['123', '123']);
});

test('cross-catalog matching keeps ambiguous tracks unselected until the user chooses', async t => {
  const f = fixture(t), list = f.library.create({ name: 'Source' }).collection;
  f.library.replace(list.id, [{ ...track('youtube', 'abcdefghijk'), title: 'Example live' }]);
  await f.call('source_library', { collectionId: list.id }); await f.call('match_tidal'); await f.run(2);
  const preview = await f.call('status');
  assert.equal(preview.rows[0].selected, null); assert.ok(preview.rows[0].choices[0].score < 95);
  assert.equal((await f.call('write_tidal')).code, 'transfer_review_required');
  await f.call('choose', { index: 0, choice: 0 });
  await f.call('write_tidal'); await f.run(2);
  assert.equal(f.native.created, 1);
});

test('playlist capacity defaults to 5000, can increase, persists and cannot truncate existing songs', () => {
  const library = createPlaylistLibrary(), list = library.create({ name: 'Large' }).collection;
  assert.equal(library.status().limits.tracksPerCollection, 5000);
  const rows = Array.from({ length: 5001 }, (_, index) => track('tidal', String(index)));
  assert.equal(library.replace(list.id, rows).ok, false);
  assert.equal(library.setTrackLimit(7500).ok, true);
  assert.equal(library.replace(list.id, rows).ok, true);
  assert.equal(library.setTrackLimit(5000).ok, false);
  const stored = library.exportStorage(), restored = createPlaylistLibrary();
  restored.restore(stored.index, { [list.id]: stored.pages.flatMap(([, page]) => page) });
  assert.equal(restored.status().limits.tracksPerCollection, 7500);
  assert.equal(restored.get(list.id).tracks.length, 5001);
});

test('destination grouping preserves order and duplicates, uses unknown metadata groups, and bounds fan-out', () => {
  const plan = require('../features/song-request/dist/playlist-transfer-plan');
  const rows = ['A', 'B', 'A'].map((artist, index) => ({ track: { candidate: { ...track(), artists: [artist], genres: index ? [] : ['Rock'] } }, selected: track('tidal', String(index)) }));
  assert.deepEqual(plan(rows, { groupBy: 'artist' }).map(group => group.ids), [['0', '2'], ['1']]);
  assert.deepEqual(plan(rows, { groupBy: 'size', splitSize: 2 }).map(group => group.ids), [['0', '1'], ['2']]);
  assert.deepEqual(plan(rows, { groupBy: 'genre' }).map(group => group.ids), [['0'], ['1', '2']]);
  const roundtrip = parseCsv(exportCsv(rows.map(row => row.track)));
  assert.deepEqual(roundtrip[0].track.candidate.genres, ['Rock']);
  assert.throws(() => plan(Array.from({ length: 101 }, (_, index) => ({ selected: track('tidal', String(index)) })), { groupBy: 'size', splitSize: 1 }), /transfer_group_limit/);
});

test('grouped writes create and verify distinct destinations and lock the reviewed selections', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const storage = new Map(), destinations = new Map(), library = createPlaylistLibrary(); let failSecond = true;
  const list = library.create({ name: 'Grouped' }).collection;
  library.replace(list.id, ['1', '2', '3'].map(id => track('tidal', id)));
  const context = { callCapability: async (cap, method, value) => {
    if (cap === 'ravelink.storage.v1') { if (method === 'get') return { found: storage.has(value.key), value: structuredClone(storage.get(value.key)) }; if (method === 'remove') storage.delete(value.key); else storage.set(value.key, structuredClone(value.value)); return { ok: true }; }
    if (value.action === 'track') return { ok: true, candidate: track('tidal', value.id) };
    if (value.action === 'create') { const id = 'dest-' + destinations.size; destinations.set(id, []); return { ok: true, id }; }
    if (value.action === 'append') { destinations.get(value.id).push(...value.ids); if (destinations.size === 2 && failSecond) { failSecond = false; return { ok: false, error: 'tidal_playlist_write_uncertain' }; } return { ok: true }; }
    if (value.action === 'read') return { ok: true, tracks: destinations.get(value.id).map(id => track('tidal', id)), cursor: '' };
    throw new Error(value.action);
  } };
  let worker = createTransfers({ context, library, saveLibrary: async () => {} }); t.after(() => worker.stop());
  const call = async (action, extra = {}) => worker.handle({ action, jobId: (await worker.handle({ action: 'status' })).job?.id, ...extra });
  const run = async count => { for (let i = 0; i < count; i++) { t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); } };
  await call('source_library', { collectionId: list.id }); await call('match_tidal'); await run(4);
  assert.deepEqual((await call('plan', { groupBy: 'size', splitSize: 2 })).plan.map(group => group.count), [2, 1]);
  await call('write_tidal', { groupBy: 'size', splitSize: 2 }); await run(5);
  assert.equal((await call('status')).job.state, 'uncertain');
  worker.stop(); worker = createTransfers({ context, library, saveLibrary: async () => {} }); await worker.load();
  await call('reconcile'); await call('resume'); await run(2);
  assert.deepEqual([...destinations.values()], [['1', '2'], ['3']]);
  const status = await call('status'); assert.equal(status.job.state, 'complete'); assert.equal(status.job.destinations.length, 2);
  assert.equal((await call('choose', { index: 0, choice: -1 })).code, 'transfer_destination_locked');
});
