const test=require('node:test'),assert=require('node:assert/strict');
const {createFeatureRuntimeHarness}=require('./support/feature-runtime-harness');
const feature=require('../features/song-request/dist/main');

test('every player replies to Twitch intake, failures and confirmed playback exactly once',async t=>{
  for(const player of ['youtube','soundcloud','tidal','spotify'])await t.test(player,async()=>{
    const storage=new Map([['player-preferences-v1',{player}]]),sent=[];
    const candidate={provider:player,providerItemId:{youtube:'dQw4w9WgXcQ',soundcloud:'123',tidal:'123',spotify:'AAAAAAAAAAAAAAAAAAAAAA'}[player],title:'Shared song',artists:['Artist'],durationMs:180000};
    let reject=false,current=null,handoffs=[];
    const status=()=>({ok:true,enabled:true,ready:false,connected:false,capacity:{available:0},current,handoffs});
    const resolve=()=>{if(reject==='throw')throw Error('private provider exception');return reject?{ok:false,reason:player+'_search_unavailable',error:player+'_search_unavailable'}:{ok:true,candidate};};
    const harness=createFeatureRuntimeHarness(feature,{featureId:'song-request',providers:{
      'ravelink.storage.v1/get':async({key})=>({ok:true,found:storage.has(key),value:structuredClone(storage.get(key))}),
      'ravelink.storage.v1/set':async({key,value})=>{storage.set(key,structuredClone(value));return{ok:true}},
      'ravelink.storage.v1/remove':async({key})=>{storage.delete(key);return{ok:true}},
      'twitch.chat.send.v1/send':async payload=>{sent.push(payload);return{ok:true}},
      'youtube.catalog.host.v1/resolve':resolve,'soundcloud.catalog.host.v1/resolve':resolve,
      'tidal.desktop.experimental.v1/resolve':resolve,'spotify.desktop.host.v1/resolve':resolve,
      'tidal.desktop.experimental.v1/status':status,'spotify.desktop.host.v1/status':status,
      'media.windows.now-playing.v1/control':async()=>({ok:true})
    }});
    try{
      await harness.start();
      await harness.request('song.queue.admin.v1','configure',{responses:{queued:true,queue_failed:true,now_playing:true,remove_failed:true}});
      const payload={requestId:'chat-1',requesterId:'viewer',requesterName:'Viewer',query:'Shared song',notifyChat:true,responseMessageId:'message-1'};
      const result=await harness.request('song.queue.submit.v1','submit',payload);
      assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.entry.chatNotify,true);
      assert.equal(sent.length,1);assert.match(sent[0].message,/@Viewer Queued "Shared song"/);assert.equal(sent[0].replyParentMessageId,'message-1');
      await harness.request('song.queue.submit.v1','submit',payload);assert.equal(sent.length,1,'request replay stays silent');
      reject=true;
      const failed=await harness.request('song.queue.submit.v1','submit',{...payload,requestId:'failed',query:'Missing'});
      assert.equal(failed.ok,false);assert.equal(sent.length,2);assert.match(sent[1].message,/Song Request failed/);reject=false;
      await harness.request('song.queue.admin.v1','moderate',{action:'remove',entryId:'missing',provider:player,notifyChat:true});
      assert.equal(sent.length,3);assert.match(sent[2].message,/Remove failed/);
      if(['youtube','soundcloud'].includes(player)){
        await harness.request('song.queue.admin.v1','moderate',{action:'playback_start',source:player});
        const action=(await harness.request('song.playback.driver.v1','pull',{driverId:'fixture',providers:[player]})).action;
        assert.ok(action);
        const ack={driverId:'fixture',leaseId:action.leaseId,state:'started'};
        await harness.request('song.playback.driver.v1','acknowledge',ack);
        await harness.request('song.playback.driver.v1','acknowledge',ack);
      }else{
        handoffs=[{entryId:result.entry.id,uid:'requested',phase:'appended'}];current={uid:'personal'};
        const observation={provider:player,sourceId:'fixture',available:true,status:'playing',title:candidate.title};
        await harness.request('song.playback.observe.v1','observe',observation);assert.equal(sent.length,3,'handoff is not playback');
        handoffs[0].phase='playing';current={uid:'requested',entryId:result.entry.id,paused:false};
        await harness.request('song.playback.observe.v1','observe',observation);
        await harness.request('song.playback.observe.v1','observe',{...observation,status:'paused'});
        await harness.request('song.playback.observe.v1','observe',observation);
        await harness.stop();await harness.start();
        await harness.request('song.playback.observe.v1','observe',observation);
      }
      assert.equal(sent.length,4,'confirmed playback announces once across polling and restart');assert.match(sent[3].message,/Now playing "Shared song", requested by @Viewer/);
      reject='throw';const unavailable=await harness.request('song.queue.submit.v1','submit',{...payload,requestId:'unavailable'});assert.equal(unavailable.ok,false);assert.equal(sent.length,5);assert.match(sent[4].message,/Song Request failed/);assert.equal(sent[4].message.includes('private provider exception'),false);
    }finally{await harness.stop()}
  });
});
