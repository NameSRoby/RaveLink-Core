const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require('playwright');
const createCoreServer=require('../src/app/core/create-core-server');
const extension=require('../src/app/optional/create-feature-platform-extension');
test('shared chat response controls stay visible for all players and preserve edits during polling',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ravelink-provider-chat-'));
  fs.cpSync(path.join(__dirname,'../features/song-request'),path.join(root,'installed/song-request'),{recursive:true});
  const status=()=>({ok:true,enabled:false,ready:false,connected:false,capacity:{available:0},handoffs:[]});
  const created=createCoreServer({rootDir:path.join(__dirname,'..'),runtimeDir:path.join(root,'runtime'),dryRun:true,capabilities:{features:true},extend:extension({featuresRoot:path.join(root,'installed'),runtimeRoot:path.join(root,'runtime/features'),allowUnsafeRuntime:true,providers:{'spotify.desktop.host.v1/status':status,'tidal.desktop.experimental.v1/status':()=>({ok:true,enabled:true,connected:true,ready:true,capacity:{available:0},queue:[],handoffs:[]}),'tidal.desktop.experimental.v1/manage-companion':()=>({ok:false,error:'installation_probe_unavailable'})}})});
  await created.extension.startup;
  const server=await new Promise(r=>{const s=created.app.listen(0,'127.0.0.1',()=>r(s))});
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await created.extension.shutdown();await created.services.lifecycle.stopAll();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})});
  const base='http://127.0.0.1:'+server.address().port;
  const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://www.youtube.com/**',route=>route.abort());
  async function call(capability,method,payload){const r=await fetch(base+'/api/features/song-request/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capability,method,payload})});const j=await r.json();assert.equal(j.ok,true,JSON.stringify(j));return j.value;}
  for(const [index,player] of ['youtube','tidal','spotify','soundcloud'].entries()){
    assert.equal((await call('song.player.preferences.v1','select',{player})).ok,true);
    await page.goto(base+'/features-ui/song-request/player');
    const frame=page.locator('#surface').contentFrame();
    await frame.locator('#songPlayerProvider:not([disabled])').waitFor({state:'attached'});
    if(player==='tidal'){
      await frame.locator('#tidalPlaybackStatus').filter({hasText:'Desktop connected'}).waitFor();
      assert.equal(await frame.locator('#notice').innerText(),'','an optional installation probe must not claim working controls are unavailable');
    }
    await frame.getByRole('tab',{name:'Moderation',exact:true}).click();
    await frame.locator('summary').filter({hasText:'TWITCH CHAT RESPONSES'}).click();
    const toggle=frame.locator('[data-response=queued]');
    assert.equal(await toggle.isVisible(),true,player+' exposes shared chat settings');
    assert.equal(await toggle.isChecked(),index>0,'settings carry across player switches');
    await toggle.check();await toggle.uncheck();
    await frame.locator('body').evaluate(()=>renderResponses({responses:{queued:true},integrations:{}}));
    assert.equal(await toggle.isChecked(),false,'polling preserves unsaved edits');
    await toggle.check();await frame.locator('#saveResponses').click();
    await frame.locator('#notice').filter({hasText:'chat responses saved'}).waitFor();
    assert.equal((await call('song.queue.read.v1','status',{})).responses.queued,true);
  }
  assert.deepEqual(errors,[]);
});
