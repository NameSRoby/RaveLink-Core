const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlaylistLibrary } = require('../features/song-request/dist/playlist-library');
const createTransfers = require('../features/song-request/dist/playlist-transfers');
const candidate = (provider, id) => ({ provider, providerItemId: id, title: 'Example', artists: ['Artist'], album: 'Album', durationMs: 180000 });

for (const target of ['youtube', 'soundcloud']) test('TIDAL transfers to local ' + target + ' preserve duplicates, groups and the selected playlist', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const storage = new Map(), library = createPlaylistLibrary(), calls = [];
  library.ensureChatCollection(); const selectedId = library.status().selectedId;
  const source = library.create({ name: 'Source', provider: 'tidal' }).collection;
  library.replace(source.id, [candidate('tidal', '123'), candidate('tidal', '123'), candidate('tidal', '456')]);
  const targetTrack = candidate(target, target === 'youtube' ? 'abcdefghijk' : '789');
  const context = { callCapability: async (cap, method, input) => {
    if (cap === 'ravelink.storage.v1') { if (method === 'get') return { ok: true, found: storage.has(input.key), value: structuredClone(storage.get(input.key)) }; if (method === 'remove') storage.delete(input.key); else storage.set(input.key, structuredClone(input.value)); return { ok: true }; }
    calls.push({ cap, method, input }); assert.equal(cap, target + '.catalog.host.v1'); assert.equal(method, 'resolve');
    return { ok: true, candidate: targetTrack };
  } };
  let saves = 0;
  const worker = createTransfers({ context, library, saveLibrary: async () => { saves++; } }); t.after(() => worker.stop());
  const action = async (name, input = {}) => worker.handle({ action: name, jobId: (await worker.handle({ action: 'status' })).job?.id, ...input });
  await action('source_library', { collectionId: source.id });
  await action('match', { target });
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); }
  const review = await action('status'); assert.equal(review.job.state, 'review'); assert.equal(review.job.selected, 0);
  assert.equal(review.rows[0].choices[0].provider, target);
  assert.equal((await action('save_matched')).code, 'transfer_review_required');
  await action('accept_matches');
  assert.equal((await action('write_tidal')).code, 'transfer_review_required');
  const saved = await action('save_matched', { groupBy: 'size', splitSize: 2, name: 'Converted' });
  assert.equal(saved.ok, true); assert.equal(saved.job.state, 'complete');
  assert.deepEqual(saved.job.localDestinations.map(row => row.count), [2, 1]);
  const first = library.get(saved.job.localDestinations[0].id);
  assert.deepEqual(first.tracks.map(row => row.candidate.providerItemId), [targetTrack.providerItemId, targetTrack.providerItemId]);
  assert.equal(new Set(first.tracks.map(row => row.id)).size, 2);
  assert.equal(library.status().selectedId, selectedId); assert.equal(saves, 1); assert.equal(calls.length, 3);
  assert.equal((await action('save_matched')).code, 'transfer_destination_locked');
});

test('a missing catalog match remains reviewable and does not stop the rest of the transfer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const library = createPlaylistLibrary(), list = library.create({ name: 'Missing' }).collection;
  library.replace(list.id, [candidate('tidal', '123'), candidate('tidal', '456')]); let calls = 0;
  const context = { callCapability: async cap => cap === 'ravelink.storage.v1' ? { ok: true } : ++calls === 1 ? { ok: false, reason: 'soundcloud_no_eligible_match' } : { ok: true, candidate: candidate('soundcloud', '789') } };
  const worker = createTransfers({ context, library, saveLibrary: async () => {} }); t.after(() => worker.stop());
  await worker.handle({ action: 'source_library', collectionId: list.id }); const id = (await worker.handle({ action: 'status' })).job.id;
  await worker.handle({ action: 'match', jobId: id, target: 'soundcloud', adaptive: false });
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); }
  const state = await worker.handle({ action: 'status' });
  assert.equal(state.job.state, 'review'); assert.equal(state.rows[0].choices.length, 0); assert.equal(state.rows[1].choices.length, 1);
});
