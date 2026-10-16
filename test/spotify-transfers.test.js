const test=require('node:test'),assert=require('node:assert/strict');
const transfers=require('../features/song-request/dist/playlist-transfers');
const {createPlaylistLibrary}=require('../features/song-request/dist/playlist-library');
const ID='A'.repeat(22),DEST='B'.repeat(22),TRACK='C'.repeat(22);
const track=(provider='spotify',providerItemId=TRACK)=>({provider,providerItemId,title:'Song',artists:['Artist'],album:'Album',durationMs:180000});
function fixture(t,count=53,source='tidal'){
  t.mock.timers.enable({apis:['setTimeout']});
  const library=createPlaylistLibrary(),list=library.create({name:'Source'}).collection;
  library.replace(list.id,Array.from({length:count},()=>track(source,source==='tidal'?'123':TRACK)));
  const storage=new Map(),ids=[],calls=[],destinations=new Map();let fail='',missing=false,creates=0;
  const context={callCapability:async(cap,method,payload)=>{
    if(cap==='ravelink.storage.v1'){
      if(method==='get')return{ok:true,found:storage.has(payload.key),value:structuredClone(storage.get(payload.key))};
      if(method==='remove')storage.delete(payload.key);else storage.set(payload.key,structuredClone(payload.value));return{ok:true};
    }
    assert.equal(cap,'spotify.desktop.host.v1');calls.push({method,...payload});
    if(method==='resolve')return missing?{ok:false,error:'spotify_match_not_found'}:{ok:true,candidate:track()};
    assert.equal(method,'playlist');
    if(payload.action==='create'){creates++;const id=creates===1?DEST:'D'.repeat(22);destinations.set(id,[]);return fail==='create'?{ok:false,error:'spotify_playlist_write_uncertain'}:{ok:true,id:'spotify:playlist:'+id};}
    if(payload.action==='append'){
      assert.ok(payload.ids.length<=25);ids.push(...payload.ids);destinations.get(payload.id.replace(/^spotify:playlist:/,''))?.push(...payload.ids);
      if(fail==='append'){fail='';return{ok:false,error:'spotify_playlist_write_uncertain'};}return{ok:true};
    }
    if(payload.action==='read'){
      const values=payload.id===ID?Array.from({length:27},(_,i)=>i===1?null:track()):(destinations.get(payload.id.replace(/^spotify:playlist:/,''))||[]).map(id=>track('spotify',id));
      const offset=payload.offset||0;return{ok:true,name:'Spotify source',tracks:values.slice(offset,offset+25),total:values.length,cursor:offset+25<values.length?String(offset+25):''};
    }
    throw Error('Unexpected action');
  }};
  let worker=transfers({context,library,saveLibrary:async()=>{}});t.after(()=>worker.stop());
  const call=async(action,extra={})=>worker.handle({action,jobId:(await worker.handle({action:'status'})).job?.id,...extra});
  const run=async(n=count+2)=>{for(let i=0;i<n;i++){t.mock.timers.tick(1000);await new Promise(r=>setImmediate(r));}};
  const prepare=async()=>{await call('source_library',{collectionId:list.id});await call('match',{target:'spotify'});await run();await call('accept_matches');};
  return{library,list,call,run,prepare,ids,calls,creates:()=>creates,fail:value=>{fail=value;},missing:()=>{missing=true;},restart:async()=>{worker.stop();worker=transfers({context,library,saveLibrary:async()=>{}});await worker.load();}};
}
test('Spotify imports pages, preserves duplicates and unavailable positions, and can save locally',async t=>{
  const f=fixture(t);const result=await f.call('read_spotify',{id:'https://open.spotify.com/playlist/'+ID+'?si=tracking'});assert.equal(result.ok,true);
  await f.run(2);const review=await f.call('status');assert.equal(review.job.state,'review');assert.equal(review.job.count,27);assert.equal(review.job.valid,26);assert.equal(review.rows[1].track,null);
  assert.equal((await f.call('save_local')).job.state,'complete');assert.equal(f.creates(),0);
});
test('reviewed Spotify destination writes in bounded batches, preserves duplicates, verifies and locks the destination',async t=>{
  const f=fixture(t);await f.prepare();assert.equal(f.creates(),0);
  assert.equal((await f.call('write_tidal')).code,'transfer_review_required');
  assert.equal((await f.call('write_spotify')).ok,true);await f.run(5);
  const done=await f.call('status');assert.equal(done.job.state,'complete');assert.equal(done.job.verified,true);assert.equal(f.creates(),1);
  assert.deepEqual(f.calls.filter(c=>c.action==='append').map(c=>c.ids.length),[25,25,3]);assert.deepEqual(f.ids,Array(53).fill(TRACK));
  assert.equal((await f.call('write_spotify')).code,'transfer_destination_locked');
});
test('an unconfirmed Spotify append survives restart and reconciles without sending tracks twice',async t=>{
  const f=fixture(t,27);await f.prepare();f.fail('append');await f.call('write_spotify');await f.run(1);
  assert.equal((await f.call('status')).job.state,'uncertain');assert.equal(f.ids.length,25);
  await f.restart();assert.equal((await f.call('resume')).code,'transfer_busy');assert.equal((await f.call('reconcile')).ok,true);
  await f.call('resume');await f.run(3);assert.equal((await f.call('status')).job.verified,true);assert.equal(f.ids.length,27);assert.equal(f.creates(),1);
});
test('unconfirmed Spotify creation requires an explicit destination link and never guesses or recreates it',async t=>{
  const f=fixture(t,2);await f.prepare();f.fail('create');await f.call('write_spotify');await f.run(1);await f.restart();
  assert.equal((await f.call('reconcile')).code,'spotify_playlist_destination_required');
  assert.equal((await f.call('reconcile',{destinationId:'https://foreign.invalid/playlist/'+DEST})).code,'spotify_playlist_invalid');
  assert.equal((await f.call('status')).job.destinationId,'');
  assert.equal((await f.call('reconcile',{destinationId:'https://open.spotify.com/playlist/'+DEST})).ok,true);
  await f.call('resume');await f.run(3);assert.equal((await f.call('status')).job.verified,true);assert.equal(f.creates(),1);assert.equal(f.ids.length,2);
});
test('missing Spotify matches stay reviewable',async t=>{
  const f=fixture(t,2);f.missing();await f.prepare();const review=await f.call('status');assert.equal(review.job.state,'review');assert.equal(review.job.selected,0);assert.equal((await f.call('write_spotify')).code,'transfer_review_required');
});
test('same-catalog Spotify copies preserve exact identities and split into verified playlists',async t=>{
  const f=fixture(t,3,'spotify');await f.prepare();
  assert.equal(f.calls.some(c=>c.method==='resolve'),false);
  assert.equal((await f.call('write_spotify',{groupBy:'size',splitSize:2})).ok,true);await f.run(5);
  const done=await f.call('status');assert.equal(done.job.verified,true);assert.deepEqual(done.job.destinations.map(d=>d.count),[2,1]);assert.equal(f.creates(),2);assert.deepEqual(f.ids,Array(3).fill(TRACK));
});
