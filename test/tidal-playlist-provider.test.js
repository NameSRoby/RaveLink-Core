const test = require('node:test');
const assert = require('node:assert/strict');
const create = require('../src/capabilities/feature-platform/providers/tidal-playlist-provider');
const catalog = require('../src/capabilities/feature-platform/providers/tidal-catalog-provider');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('playlist access needs explicit expanded account consent and is preserved across token refresh', async () => {
  let now = 100000, lastScope;
  const api = catalog({ now: () => now, fetchImpl: async (url, init) => {
    if (new URL(url).hostname === 'openapi.tidal.com') return json({ data: [] });
    assert.equal(new URL(url).hostname, 'auth.tidal.com'); lastScope = init.body.get('scope');
    assert.equal(init.body.has('client_secret'), false);
    return json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: lastScope });
  } });
  const redirectUri = 'http://127.0.0.1:5050/auth/tidal/callback';
  const signIn = async playlists => {
    const begun = api.begin({ redirectUri, playlists }), url = new URL(begun.authorizationUrl);
    assert.equal(url.searchParams.get('scope').includes('playlists.write'), playlists);
    assert.equal((await api.callback({ state: url.searchParams.get('state'), code: 'code' }, redirectUri)).ok, true);
  };
  await signIn(false); assert.equal(api.status().playlistsEnabled, false);
  assert.equal(api.status().collectionsEnabled, false);
  assert.equal((await api.playlists({ action: 'list' })).error, 'tidal_playlist_sign_in_required');
  await signIn(true); assert.equal(api.status().playlistsEnabled, true);
  assert.equal(api.status().collectionsEnabled, true);
  assert.ok(lastScope.includes('collection.read') && lastScope.includes('collection.write'));
  assert.equal(lastScope.split(' ').some(scope => ['r_usr', 'w_usr'].includes(scope)), false);
  now += 3600001; assert.equal((await api.playlists({ action: 'list' })).ok, true);
  assert.ok(lastScope.includes('playlists.write') && lastScope.includes('collection.write'));
  assert.equal(api.status().collectionsEnabled, true);
});

test('TIDAL playlist adapter creates unlisted lists and appends ordered occurrences with an idempotency key', async () => {
  const calls = [], adapter = create({ status: () => ({ connected: true, playlistsEnabled: true }), api: async (...args) => { calls.push(args); return { data: { id: 'new-list' } }; } });
  assert.equal((await adapter({ action: 'create', name: 'Transferred', key: 'transfer-123' })).id, 'new-list');
  assert.equal(calls[0][3].body.data.attributes.accessType, 'UNLISTED');
  assert.equal(calls[0][3].key, 'transfer-123');
  assert.equal((await adapter({ action: 'append', id: 'new-list', ids: ['1', '2', '1'], key: 'transfer-123-0' })).ok, true);
  assert.deepEqual(calls[1][3].body.data.map(row => row.id), ['1', '2', '1']);
  assert.equal(calls[1][3].body.meta.onDuplicates, 'ADD');
  assert.equal((await adapter({ action: 'append', id: 'new-list', ids: Array(51).fill('1'), key: 'transfer-123' })).error, 'tidal_playlist_invalid');
  assert.equal(calls.length, 2);
});

test('TIDAL reads retain duplicates and unavailable positions and reject foreign pagination links', async () => {
  let foreign = false;
  const adapter = create({ status: () => ({ connected: true, playlistsEnabled: true }), api: async () => ({ data: [{ type: 'tracks', id: '1' }, { type: 'videos', id: '2' }, { type: 'tracks', id: '1' }], included: [{ type: 'tracks', id: '1', attributes: { title: 'Title', duration: 'PT2M' } }], links: foreign ? { next: 'https://evil.test/path?page[cursor]=secret' } : {} }) });
  const reply = await adapter({ action: 'read', id: 'list' });
  assert.deepEqual(reply.tracks.map(row => row?.providerItemId || null), ['1', null, '1']);
  foreign = true; assert.equal((await adapter({ action: 'read', id: 'list' })).error, 'tidal_playlist_response_invalid');
});

test('ISRC matching uses the documented third-party catalog filter before text search', async () => {
  const calls = [];
  const adapter = create({ status: () => ({ connected: true, playlistsEnabled: true }), search: () => { throw new Error('Unexpected fallback'); }, api: async (...args) => {
    calls.push(args); return { data: [{ type: 'tracks', id: '123', attributes: { title: 'Song', isrc: 'USAAA2600001', duration: 'PT3M' } }] };
  } });
  assert.equal((await adapter({ action: 'search', query: 'Artist Song', isrc: 'USAAA2600001' })).candidates[0].isrc, 'USAAA2600001');
  assert.equal(calls[0][0], 'tracks'); assert.equal(calls[0][1]['filter[isrc]'], 'USAAA2600001');
});

test('oversized account pages fail explicitly without dropping playlist occurrences', async () => {
  const adapter = create({ status: () => ({ connected: true, playlistsEnabled: true }), api: async () => ({ data: Array.from({ length: 200 }, (_, index) => ({ type: 'tracks', id: String(index), attributes: { title: 'x'.repeat(300) } })) }) });
  const reply = await adapter({ action: 'read', id: 'list' });
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'tidal_playlist_page_too_large');
  assert.equal(reply.tracks, undefined);
});
