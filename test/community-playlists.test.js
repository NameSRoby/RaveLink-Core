const test = require('node:test'), assert = require('node:assert/strict');
const create = require('../features/song-request/dist/community-playlists');
const { createPlaylistLibrary } = require('../features/song-request/dist/playlist-library');
function fixture(t, provider = 'tidal') {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const library = createPlaylistLibrary(), storage = new Map(), account = [], calls = [];
  let submissions = 0, failAppend = false, reject = false;
  const context = { async callCapability(cap, method, input) {
    if (cap === 'ravelink.storage.v1') { if (method === 'get') return {ok:true,found:storage.has(input.key),value:structuredClone(storage.get(input.key))};storage.set(input.key,structuredClone(input.value));return {ok:true}; }
    calls.push(structuredClone(input));
    if (input.action === 'list') return {ok:true,playlists:account.map(row=>({id:row.id,name:row.name,description:row.description})),cursor:''};
    if (input.action === 'create') { account.push({id:provider==='spotify'?'spotify:playlist:'+'A'.repeat(22):'native-list',name:input.name,description:input.description,tracks:[]});return {ok:true,id:account[0].id}; }
    if (input.action === 'append') { account[0].tracks.push(...input.ids);if (failAppend) return {ok:false,error:'write_uncertain'};return {ok:true}; }
    if (input.action === 'read') return {ok:true,tracks:account[0].tracks.map(id=>({providerItemId:id})),cursor:''};
    throw Error('unexpected operation');
  }};
  const options = { context, library, saveLibrary: async()=>{}, player:async()=>provider, submit:async payload=>{submissions++;if(reject)return {ok:false,code:'rejected',reason:'blocked'};return {ok:true,code:'accepted',entry:{id:'entry-'+submissions,identity:provider+':'+payload.query,candidate:{provider,providerItemId:payload.query,title:'Song',artists:['Artist'],durationMs:1000}}};} };
  let worker = create(options);worker.start();t.after(()=>worker.stop());
  return { library,storage,account,calls, get submissions(){return submissions}, get worker(){return worker}, fail(){failAppend=true}, reject(){reject=true}, async restart(){await worker.stop();worker=create(options);worker.start()}, async tick(){t.mock.timers.tick(3000);for(let i=0;i<15;i++)await new Promise(resolve=>setImmediate(resolve));} };
}
for (const provider of ['youtube','soundcloud','tidal','spotify']) test('community reward queues and saves '+provider+' with idempotent local contributions',async t=>{
  const f=fixture(t,provider),id=provider==='youtube'?'abcdefghijk':provider==='spotify'?'B'.repeat(22):'123';
  const payload={requestId:'reward-one',query:id,requesterId:'viewer'};
  const result=await f.worker.submit(payload);assert.equal(result.ok,true);assert.equal(result.community.saved,true);
  await f.worker.submit(payload);assert.equal(f.submissions,1);
  await f.worker.submit({...payload,requestId:'reward-two'});assert.equal(f.submissions,2);
  const list=f.library.get(result.community.collectionId);assert.equal(list.tracks.length,1);
  for(let i=0;i<4;i++)await f.tick();
  if (['youtube','soundcloud'].includes(provider)) assert.equal(f.calls.length,0);
  else {assert.deepEqual(f.account[0].tracks,[id]);assert.equal(f.worker.status()[0].phase,'synced');}
  await f.restart();await f.worker.submit(payload);assert.equal(f.submissions,2);
});
test('blocked requests never create a community list or native playlist',async t=>{
  const f=fixture(t);f.reject();assert.equal((await f.worker.submit({requestId:'blocked',query:'1'})).ok,false);await f.tick();assert.equal(f.library.status().collections.length,0);assert.equal(f.calls.length,0);
});
test('uncertain account append is reconciled without resending a song',async t=>{
  const f=fixture(t);f.fail();await f.worker.submit({requestId:'one',query:'123'});await f.tick();assert.equal(f.worker.status()[0].phase,'review');
  await f.worker.retry('tidal',false);await f.tick();assert.equal(f.worker.status()[0].phase,'synced');assert.equal(f.calls.filter(row=>row.action==='append').length,1);
});
