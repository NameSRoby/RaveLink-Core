const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const createHost = require('../integrations/spotify-desktop/host-bridge.cjs');
const createWorker = require('../integrations/spotify-desktop/connection-worker.cjs');
const A = 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA';
async function setup(t, options = {}) {
  const host = createHost({ timeoutMs: 1000, ...options }), app = express();app.use('/api/spotify/bridge', host.router());
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const coreUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { host.close();await new Promise(resolve => server.close(resolve)); });
  const post = (route, data, headers = {}) => fetch(coreUrl + '/api/spotify/bridge/' + route, { method: 'POST', headers: { authorization: 'Bearer ' + host.pairing().token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
  return { host, coreUrl, post };
}

test('paired Spotify connection delivers normalized lookup and mutation results and reuses request receipts', async t => {
  const { host, coreUrl } = await setup(t), actions = [];
  const client = { search: async query => ({ ok: true, candidates: [{ uri: A, title: query, artists: ['Artist'], accessToken: 'must-not-leak' }] }), append: async uri => { actions.push(uri);return { ok: true, delivery: 'confirmed', uri, uid: 'entry-1', privateToken: 'must-not-leak' }; } };
  const worker = createWorker(client, { coreUrl, token: host.pairing().token, clientId: 'desktop' });
  await worker.step();assert.equal(host.status().connected, true);
  const search = host.invoke('search', { query: 'Artist and title' }, 'lookup-1');await worker.step();
  const found = await search;assert.equal(found.candidates[0].providerItemId, 'AAAAAAAAAAAAAAAAAAAAAA');assert.equal(JSON.stringify(found).includes('must-not-leak'), false);
  const delivery = host.invoke('append', { uri: A }, 'request-1');await Promise.all([worker.step(), worker.step()]);
  assert.equal((await delivery).delivery, 'confirmed');assert.equal(actions.length, 1);
  assert.equal((await host.invoke('append', { uri: A }, 'request-1')).uid, 'entry-1');assert.equal(actions.length, 1);
  assert.equal((await host.invoke('remove', { uri: A, uid: 'entry-1' }, 'request-1')).error, 'spotify_request_id_conflict');
  assert.equal(JSON.stringify(host.status()).includes(host.pairing().token), false);worker.close();
});

test('lost result acknowledgement retries the receipt without replaying the Spotify queue operation', async t => {
  const { host, coreUrl } = await setup(t);let writes = 0, dropped = false;
  const worker = createWorker({ append: async uri => { writes++;return { ok: true, delivery: 'confirmed', uri, uid: 'one' }; } }, { coreUrl, token: host.pairing().token, clientId: 'desktop', fetch: async (url, options) => { const response = await fetch(url, options);if (url.pathname.endsWith('/result') && !dropped) { dropped = true;await response.arrayBuffer();throw Error('Simulated connection dropped after the server accepted the receipt'); } return response; } });
  await worker.step();const pending = host.invoke('append', { uri: A }, 'request-1');await worker.step();
  assert.equal((await pending).delivery, 'confirmed');assert.equal(worker.status().awaitingReceipt, true);
  await worker.step();assert.equal(worker.status().awaitingReceipt, false);assert.equal(writes, 1);
});

test('Spotify bridge rejects foreign origins, missing pairing, stale sessions and forged result leases', async t => {
  const { host, coreUrl, post } = await setup(t);
  assert.equal((await post('hello', { clientId: 'desktop' }, { authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await post('hello', { clientId: 'desktop' }, { authorization: host.pairing().token })).status, 401);
  assert.equal((await post('hello', { clientId: 'desktop' }, { origin: 'https://example.com' })).status, 403);
  const preflight = await fetch(coreUrl + '/api/spotify/bridge/hello', { method: 'OPTIONS', headers: { origin: 'https://xpui.app.spotify.com' } });assert.equal(preflight.status, 204);
  assert.equal((await post('hello', { clientId: 'desktop' })).status, 200);
  assert.equal((await post('hello', { clientId: 'another-client' })).status, 409);
  assert.equal((await post('next', { clientId: 'desktop', sessionId: 'stale' })).status, 409);
  const session = { clientId: 'desktop', sessionId: host.pairing().sessionId }, pending = host.invoke('append', { uri: A }, 'request-1');
  const { command } = await (await post('next', session)).json();
  assert.equal((await post('result', { ...session, id: command.id, lease: 'wrong', result: { ok: true } })).status, 409);
  assert.equal((await post('result', { ...session, id: command.id, lease: command.lease, result: { ok: true, delivery: 'confirmed', uri: A, uid: 'one' } })).status, 200);
  assert.equal((await pending).uid, 'one');
  assert.throws(() => createWorker({}, { coreUrl: 'https://example.com', token: host.pairing().token }), /pairing_invalid/);
});

test('expired issued writes remain unconfirmed and are never reissued after a missing receipt', async t => {
  const { host, post } = await setup(t, { timeoutMs: 50 });
  await post('hello', { clientId: 'desktop' });const session = { clientId: 'desktop', sessionId: host.pairing().sessionId };
  const pending = host.invoke('append', { uri: A }, 'request-1');
  const first = await (await post('next', session)).json();assert.equal(first.command.id, 'request-1');
  assert.equal((await (await post('next', session)).json()).command, null);
  const expired = await pending;assert.equal(expired.error, 'spotify_delivery_unconfirmed');assert.equal(expired.retrySafe, false);
  assert.equal((await host.invoke('append', { uri: A }, 'request-1')).error, 'spotify_delivery_unconfirmed');assert.equal(host.status().reviewRequired, 1);
});


test('paired playlist reading is bounded and strips unrelated account fields', async t => {
  const {host,coreUrl}=await setup(t), worker=createWorker({playlist:async()=>({ok:true,name:'Source',total:1,tracks:[{providerItemId:'A'.repeat(22),title:'Song',artists:['Artist'],album:'Album',privateToken:'must-not-leak'}]})},{coreUrl,token:host.pairing().token,clientId:'playlist-reader'});
  t.after(()=>worker.close());await worker.step();
  const reply=host.invoke('playlist',{action:'read',id:'spotify:playlist:'+'B'.repeat(22),offset:0},'read-list');await worker.step();
  const result=await reply;assert.equal(result.tracks[0].album,'Album');assert.equal(JSON.stringify(result).includes('must-not-leak'),false);
  assert.equal((await host.invoke('playlist',{action:'append',id:'B'.repeat(22)},'bad-write')).ok,false);
});
