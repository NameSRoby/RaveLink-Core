const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium } = require('playwright');
const createCore = require('../src/app/core/create-core-server');
const extension = require('../src/app/optional/create-feature-platform-extension');
test('community redemptions use each selected provider and expose saved lists and the new reward choice',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ravelink-community-'));
  for(const name of ['song-request','twitch-integration']) fs.cpSync(path.join(__dirname,'../features',name),path.join(root,'installed',name),{recursive:true});
  const candidate=provider=>({provider,providerItemId:provider==='youtube'?'abcdefghijk':provider==='spotify'?'A'.repeat(22):'123',title:'Community '+provider,artists:['Artist'],durationMs:180000});
  const providers={
    'youtube.catalog.host.v1/resolve':()=>({ok:true,candidate:candidate('youtube')}),
    'soundcloud.catalog.host.v1/resolve':()=>({ok:true,candidate:candidate('soundcloud')}),
    'tidal.desktop.experimental.v1/resolve':()=>({ok:true,candidate:candidate('tidal')}),
    'tidal.desktop.experimental.v1/status':()=>({ok:true,enabled:true,connected:false,ready:false}),
    'tidal.playlists.host.v1/action':()=>({ok:false,error:'tidal_playlist_sign_in_required'}),
    'spotify.desktop.host.v1/resolve':()=>({ok:true,candidate:candidate('spotify')}),
    'spotify.desktop.host.v1/status':()=>({ok:true,connected:false,ready:false,capacity:{available:0},handoffs:[]}),
    'spotify.desktop.host.v1/playlist':()=>({ok:false,error:'spotify_playlist_unavailable'})
  };
  const created=createCore({rootDir:path.join(__dirname,'..'),runtimeDir:path.join(root,'runtime'),dryRun:true,capabilities:{features:true},extend:extension({featuresRoot:path.join(root,'installed'),runtimeRoot:path.join(root,'features'),allowUnsafeRuntime:true,providers})});
  await created.extension.startup;
  const server=await new Promise(resolve=>{const s=created.app.listen(0,'127.0.0.1',()=>resolve(s))});
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await created.extension.shutdown();await created.services.lifecycle.stopAll();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true})});
  const registry=created.extension.registry;
  for(const provider of ['youtube','soundcloud','tidal','spotify']) {
    await registry.request('song-request','song.player.preferences.v1','select',{player:provider});
    const reply=await registry.request('song-request','song.queue.submit.v1','submit',{requestId:'community-'+provider,requesterId:'viewer-'+provider,query:'Artist Song',addToPlaylist:true});
    assert.equal(reply.value?.community?.saved,true,JSON.stringify(reply));
  }
  const lists=await registry.request('song-request','song.playlist.read.v1','status',{});
  assert.equal(lists.value.community.length,4);
  assert.ok(lists.value.collections.filter(row=>row.name.startsWith('Community - ')).every(row=>row.count===1));
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const base='http://127.0.0.1:'+server.address().port;
  await page.goto(base+'/features-ui/song-request/server-playlist');
  const frame=page.locator('#surface').contentFrame();await frame.locator('#communityPlaylists').waitFor();
  assert.equal(await frame.locator('#communityPlaylists').getByRole('button',{name:'View songs',exact:true}).count(),4);
  assert.match(await frame.locator('#communityPlaylists').innerText(),/Saved locally/);
  await page.goto(base+'/features-ui/twitch-integration/connection');
  const twitch=page.locator('#surface').contentFrame();await twitch.getByRole('button',{name:'Rewards',exact:true}).click();await twitch.locator('[data-value="add_to_playlist"]').click();
  assert.equal(await twitch.locator('#rewardPurpose').inputValue(),'add_to_playlist');
  assert.equal(await twitch.locator('#rewardTitle').inputValue(),'Add to playlist');
  assert.deepEqual(errors,[]);
});
