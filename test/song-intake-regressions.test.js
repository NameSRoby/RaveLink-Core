const test=require('node:test'),assert=require('node:assert/strict');
const {createFeatureRuntimeHarness}=require('./support/feature-runtime-harness');
const feature=require('../features/song-request/dist/main');
const position=require('../features/song-request/dist/desktop-queue-position');
test('community rewards announce success or failure once at the outer request boundary',async t=>{
 for(const player of ['youtube','tidal','spotify','soundcloud'])await t.test(player,async()=>{
  const sent=[],store=new Map([['player-preferences-v1',{player}]]);let reject=false;
  const candidate={provider:player,providerItemId:player==='youtube'?'dQw4w9WgXcQ':player==='spotify'?'AAAAAAAAAAAAAAAAAAAAAA':'123',title:'Song',artists:['Artist'],durationMs:10000};
  const resolve=async()=>reject?{ok:false,error:player+'_search_unavailable',reason:player+'_search_unavailable'}:{ok:true,candidate};
  const harness=createFeatureRuntimeHarness(feature,{featureId:'song-request',providers:{
   'ravelink.storage.v1/get':async({key})=>({ok:true,found:store.has(key),value:store.get(key)}),
   'ravelink.storage.v1/set':async({key,value})=>{store.set(key,structuredClone(value));return{ok:true}},
   'ravelink.storage.v1/remove':async()=>({ok:true}),
   'twitch.chat.send.v1/send':async input=>{sent.push(input);return{ok:true}},
   'youtube.catalog.host.v1/resolve':resolve,'tidal.desktop.experimental.v1/resolve':resolve,'spotify.desktop.host.v1/resolve':resolve,'soundcloud.catalog.host.v1/resolve':resolve,
   'tidal.desktop.experimental.v1/status':async()=>({ok:true,enabled:true,ready:false,handoffs:[]}),
   'spotify.desktop.host.v1/status':async()=>({ok:true,ready:false,capacity:{available:0},handoffs:[]})
  }});
  try{
   await harness.start();await harness.request('song.queue.admin.v1','configure',{responses:{queued:true,queue_failed:true}});
   const payload={requestId:'community',requesterId:'moderator',requesterName:'Mod',requesterRole:'moderator',query:'Song',notifyChat:true,addToPlaylist:true};
   const good=await harness.request('song.queue.submit.v1','submit',payload);assert.equal(good.ok,true);assert.equal(sent.length,1);assert.match(sent[0].message,/Queued/);
   await harness.request('song.queue.submit.v1','submit',payload);assert.equal(sent.length,1,'a replay does not re-announce a saved contribution');
   reject=true;const bad=await harness.request('song.queue.submit.v1','submit',{...payload,requestId:'failure'});assert.equal(bad.ok,false);assert.equal(sent.length,2);assert.match(sent[1].message,/failed/);
  }finally{await harness.stop()}
 });
});
test('desktop request positions include handed-off requests without counting them twice',async()=>{
 const entry={id:'new'},waiting=[{id:'pending'},entry],queue={status:()=>({queue:waiting,counts:{queued:2}})};
 const status={ok:true,current:{uid:'playing'},handoffs:[{entryId:'playing',uid:'playing',phase:'playing'},...['one','two','three','four'].map(id=>({entryId:id,uid:id,phase:'appended'})),{entryId:'pending',phase:'pending'}]};
 assert.equal((await position(queue,'tidal',{ok:true,entry,position:2},async()=>status)).position,6);
 status.handoffs.push({entryId:'new',uid:'new',phase:'appended'});waiting.pop();
 assert.equal((await position(queue,'tidal',{ok:true,entry,position:1},async()=>status)).position,5);
 assert.equal((await position(queue,'tidal',{ok:true,entry,position:1},async()=>{throw Error('offline')})).position,undefined,'unavailable telemetry must not produce a misleading position');
});
