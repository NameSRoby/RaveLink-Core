const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require('playwright');
const createCoreServer=require('../src/app/core/create-core-server');
const extension=require('../src/app/optional/create-feature-platform-extension');
test('overlay designer presets, profiles, undo and shared app colors work through the supervised bridge',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ravelink-overlay-profiles-'));
  fs.cpSync(path.join(__dirname,'../features/song-request'),path.join(root,'installed/song-request'),{recursive:true});
  const created=createCoreServer({rootDir:path.join(__dirname,'..'),runtimeDir:path.join(root,'runtime'),dryRun:true,capabilities:{features:true},extend:extension({featuresRoot:path.join(root,'installed'),runtimeRoot:path.join(root,'runtime/features'),allowUnsafeRuntime:true,providers:{'youtube.catalog.host.v1/resolve':async()=>({ok:true,candidate:{provider:'youtube',providerItemId:'M7lc1UVf-VE',title:'A very long song title that keeps scrolling across every layout in this test',artists:['Artist'],durationMs:200000}})}})});
  await created.extension.startup;
  const server=await new Promise(r=>{const s=created.app.listen(0,'127.0.0.1',()=>r(s))});
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await created.extension.shutdown();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})});
  const base='http://127.0.0.1:'+server.address().port;
  async function call(method,payload={},capability='song.overlay.admin.v1'){
    const r=await fetch(base+'/api/features/song-request/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capability,method,payload})});const body=await r.json();assert.equal(body.ok,true,JSON.stringify(body));return body.value;
  }
  const page=await browser.newPage({viewport:{width:1400,height:1000}});
  await page.goto(base+'/features-ui/song-request/overlay-editor');
  const editor=page.locator('#surface').contentFrame();
  await editor.locator('#preset option').nth(7).waitFor({state:'attached'});
  assert.equal(await editor.locator('.task-navigation button[aria-pressed=true]').textContent(),'Style');
  assert.equal(await editor.locator('.profile-bar').isVisible(),false);
  assert.equal(await editor.locator('.content-panel').isVisible(),false);
  assert.ok((await editor.locator('.preview-wrap').boundingBox()).y<250,'preview appears before the preset gallery');
  for(const name of ['Look','Spacing','Colors','Borders','Size & position']){
    await editor.locator('.style-navigation').getByRole('button',{name,exact:true}).click();
    await editor.locator('.appearance').evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const geometry=await editor.locator('.appearance').evaluate(el=>{
      const preview=document.querySelector('.preview-wrap').getBoundingClientRect();
      const controls=el.querySelector('.style-panel:not([hidden])').getBoundingClientRect();
      return {preview:{top:preview.top,bottom:preview.bottom,right:preview.right},controls:{top:controls.top,bottom:controls.bottom,left:controls.left}};
    });
    assert.ok(geometry.controls.top<geometry.preview.bottom&&geometry.controls.left>=geometry.preview.right,name+' stays beside the preview');
    assert.ok(geometry.controls.bottom<800,name+' fits without scrolling away from the preview');
    assert.equal(await editor.locator('.style-panel:visible').count(),1);
    if(name==='Spacing'&&process.env.RAVELINK_CAPTURE_UI==='1'){
      const output=path.join(__dirname,'../runtime/logs');fs.mkdirSync(output,{recursive:true});
      await page.screenshot({path:path.join(output,'overlay-spacing-inspector.png'),fullPage:true});
    }
  }
  await editor.locator('.style-navigation').getByRole('button',{name:'Look',exact:true}).click();
  assert.equal(await editor.locator('#preset-library').isVisible(),false);
  await editor.locator('.task-navigation').getByRole('button',{name:'Presets',exact:true}).click();
  await editor.locator('.preset-card').nth(7).waitFor();
  await editor.locator('.preset-thumb .song-overlay').nth(7).waitFor();
  assert.equal(await editor.locator('#composition').isVisible(),false);
  assert.equal(await editor.locator('.preset-thumb .song-overlay').count(),8);
  const thumbnails=await editor.locator('.preset-thumb').evaluateAll(thumbs=>thumbs.map(thumb=>{
    const bounds=thumb.getBoundingClientRect(),art=thumb.querySelector('.song-overlay').getBoundingClientRect();
    return {fits:art.left>=bounds.left-1&&art.right<=bounds.right+1&&art.top>=bounds.top-1&&art.bottom<=bounds.bottom+1,width:art.width,height:art.height};
  }));
  assert.ok(thumbnails.every(t=>t.fits&&t.width>30&&t.height>15),JSON.stringify(thumbnails));
  if(process.env.RAVELINK_CAPTURE_UI==='1'){
    const output=path.join(__dirname,'../runtime/logs');fs.mkdirSync(output,{recursive:true});
    await page.screenshot({path:path.join(output,'overlay-designer-presets.png'),fullPage:true});
  }
  await editor.locator('.task-navigation').getByRole('button',{name:'Presets',exact:true}).click();await editor.locator('[data-preset="album-card"]').click();
  await editor.locator('#designer-tasks[data-active-task="Style"]').waitFor();
  await editor.locator('#status').filter({hasText:'Preset loaded locally'}).waitFor();
  assert.equal(await editor.locator('#preset-library').isVisible(),false);
  await editor.locator('#preview [aria-label="Style Song title"]').click();
  await editor.locator('#selection-inspector').waitFor();
  await editor.locator('#selected-piece-controls [data-choice-value=display]').click();
  assert.equal(await editor.locator('#preview h1').first().evaluate(el=>getComputedStyle(el).fontSize),'27px');
  await editor.locator('.task-navigation').getByRole('button',{name:'Content & layout',exact:true}).click();await editor.locator('#content-controls').getByText('Artists',{exact:true}).click();
  assert.equal(await editor.locator('#preview .artists').count(),0);
  assert.equal(await editor.locator('.task-navigation').getByRole('button',{name:'Layout',exact:true}).count(),0);
  await editor.locator('.content-navigation').getByRole('button',{name:'Arrangement',exact:true}).click();
  assert.equal(await editor.locator('#content-controls').isVisible(),false);
  assert.equal(await editor.locator('#workspace>.segment:visible').count(),1);
  await editor.locator('#section-picker button').last().click();
  assert.equal(await editor.locator('#workspace>.segment:visible').count(),1);
  await editor.locator('#workspace .piece').filter({hasText:'Song title'}).first().dragTo(editor.locator('#section-picker button').first());
  assert.equal(await editor.locator('#workspace>.segment:visible .piece').filter({hasText:'Song title'}).count(),1,'pieces can move between sections without showing every section');
  const previewBounds=await editor.locator('.preview-wrap').boundingBox(),arrangementBounds=await editor.locator('#composition').boundingBox();
  assert.ok(arrangementBounds.x>=previewBounds.x+previewBounds.width,'arrangement controls stay beside the preview');
  await editor.locator('.content-navigation').getByRole('button',{name:'Information',exact:true}).click();
  await editor.locator('#discard').click();await editor.locator('#status').filter({hasText:'Unsaved changes undone'}).waitFor();
  await editor.locator('.task-navigation').getByRole('button',{name:'Presets',exact:true}).click();
  assert.equal(await editor.locator('#followAppColors').isChecked(),true);
  const initial=await call('status',null,'song.overlay.read.v1');
  const gallery=[];
  for(const preset of initial.presets){
    await editor.locator('.task-navigation').getByRole('button',{name:'Presets',exact:true}).click();await editor.locator('[data-preset="'+preset.id+'"]').click();
    await editor.locator('#status').filter({hasText:'Preset loaded locally'}).waitFor();
    await editor.locator('.task-navigation').getByRole('button',{name:'Style',exact:true}).click();await editor.locator('#preview').evaluate(e=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const layout=await editor.locator('#preview').evaluate(el=>({width:el.clientWidth,height:el.clientHeight,pieces:[...el.querySelectorAll('.block')].map(b=>({width:b.clientWidth,height:b.clientHeight})),config:structuredClone(config)}));
    assert.ok(layout.width>200&&layout.height>20,preset.id);
    assert.ok(layout.pieces.every(p=>p.width>0&&p.height>0),preset.id+JSON.stringify(layout));
    gallery.push({name:preset.name,config:layout.config});
    assert.equal((await call('status',null,'song.overlay.read.v1')).revision,initial.revision,'preset selection is local');
  }
  if(process.env.RAVELINK_CAPTURE_UI==='1'){
    await editor.locator('.task-navigation').getByRole('button',{name:'Presets',exact:true}).click();
    await editor.locator('[data-preset="album-card"]').click();
    await editor.locator('#designer-tasks[data-active-task="Style"]').waitFor();
    await editor.locator('#status').filter({hasText:'Preset loaded locally'}).waitFor();
    await page.screenshot({path:path.join(__dirname,'../runtime/logs/overlay-designer-canvas.png'),fullPage:true});
    await editor.locator('.task-navigation').getByRole('button',{name:'Presets',exact:true}).click();
  }
  await editor.locator('.task-navigation').getByRole('button',{name:'Profiles',exact:true}).click();await editor.locator('#profile-name').fill('Stream card');await editor.locator('#profile-new').click();
  await editor.locator('#status').filter({hasText:'Profile saved and applied'}).waitFor();
  const saved=await call('status',null,'song.overlay.read.v1');const id=saved.activeProfileId;assert.ok(id);
  await editor.locator('.task-navigation').getByRole('button',{name:'Style',exact:true}).click();await editor.locator('#followAppColors').uncheck();await editor.locator('.style-navigation').getByRole('button',{name:'Colors',exact:true}).click();await editor.locator('#accent').fill('#abcdef');
  await editor.locator('.task-navigation').getByRole('button',{name:'Profiles',exact:true}).click();
  await editor.locator('#profile-name').fill('Renamed card');await editor.locator('#profile-update').click();
  await editor.locator('#status').filter({hasText:'Profile updated and applied'}).waitFor();
  assert.equal((await call('profile',{action:'load',id})).profile.config.accent,'#abcdef');
  await editor.locator('.task-navigation').getByRole('button',{name:'Presets',exact:true}).click();
  await editor.locator('.task-navigation').getByRole('button',{name:'Presets',exact:true}).click();await editor.locator('[data-preset="classic"]').click();await editor.locator('#status').filter({hasText:'Preset loaded locally'}).waitFor();
  await editor.locator('#discard').click();await editor.locator('#status').filter({hasText:'Unsaved changes undone'}).waitFor();
  assert.equal(await editor.locator('#followAppColors').isChecked(),false);
  assert.equal(await editor.locator('#profile-name').inputValue(),'Renamed card');
  await page.setViewportSize({width:390,height:844});
  await editor.locator('body').evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await editor.locator('body').evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),true);
  await page.setViewportSize({width:1400,height:1000});
  await fetch(base+'/api/features/song-request/restart',{method:'POST'});
  await page.reload();await editor.locator('.task-navigation').getByRole('button',{name:'Profiles',exact:true}).click();await editor.locator('#profile-delete:not([disabled])').waitFor();
  assert.equal(await editor.locator('#profile-name').inputValue(),'Renamed card');
  await editor.locator('#profile-delete').click();await editor.locator('#profile-delete-confirm').click();
  await editor.locator('#status').filter({hasText:'Profile deleted'}).waitFor();
  assert.equal((await call('status',null,'song.overlay.read.v1')).profiles.length,0);
  const theme={accent:'#00cc88',bg:'#010203',surface:'#223344',text:'#ffdd99',glow:30};
  const put=()=>fetch(base+'/api/presentation/theme',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({theme})});
  assert.equal((await put()).status,200);
  await editor.locator('.task-navigation').getByRole('button',{name:'Presets',exact:true}).click();
  await editor.locator('.task-navigation').getByRole('button',{name:'Presets',exact:true}).click();await editor.locator('[data-preset="album-card"]').click();await editor.locator('#status').filter({hasText:'Preset loaded locally'}).waitFor();
  await editor.locator('#save').click();await editor.locator('#status').filter({hasText:'Overlay saved'}).waitFor();
  const submitted=await call('submit',{requestId:'overlay-track',requesterId:'viewer',query:'Long track',candidate:{provider:'youtube',providerItemId:'M7lc1UVf-VE',title:'音楽 / A very long song title that keeps scrolling across every layout in this test',artists:['Artist'],durationMs:200000}},'song.queue.submit.v1');assert.equal(submitted.ok,true,JSON.stringify(submitted));
  await call('moderate',{action:'playback_start'},'song.queue.admin.v1');
  const pulled=await call('pull',{driverId:'test',providers:['youtube']},'song.playback.driver.v1');
  await call('acknowledge',{driverId:'test',leaseId:pulled.action.leaseId,state:'started',positionMs:20000,durationMs:200000},'song.playback.driver.v1');
  const obs=await browser.newPage({viewport:{width:1280,height:720}});await obs.goto(base+'/features-ui/song-request/obs-overlay');
  const stage=obs.locator('#surface').contentFrame().locator('#stage:not(.hidden)');await stage.waitFor();
  await stage.evaluate(el=>new Promise((resolve,reject)=>{const started=Date.now();const check=()=>getComputedStyle(el).getPropertyValue('--oaccent').trim()==='#00cc88'?resolve():Date.now()-started>6000?reject(Error('theme did not arrive')):setTimeout(check,50);check()}));
  for(const preset of initial.presets){
    const result=await call('preset',{id:preset.id},'song.overlay.read.v1');await call('configure',{config:result.config});
    await stage.evaluate((el,id)=>new Promise((resolve,reject)=>{const at=Date.now();const check=()=>lastConfig?.preset===id?resolve():Date.now()-at>6000?reject(Error('preset did not arrive: '+id)):setTimeout(check,30);check()}),preset.id);
    const box=await stage.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}});
    assert.ok(box.left>=11&&box.top>=11&&box.right<=1269&&box.bottom<=709,preset.id+JSON.stringify(box));
  }
  for(const mode of ['wrap','ellipsis','scroll']){
    const result=await call('preset',{id:'album-card'},'song.overlay.read.v1');
    result.config.width=360;result.config.titleMode=mode;result.config.segments[1].direction='row';
    await call('configure',{config:result.config});
    await stage.evaluate((el,mode)=>new Promise((resolve,reject)=>{const at=Date.now();const check=()=>lastConfig?.titleMode===mode&&el.classList.contains('title-'+mode)?resolve():Date.now()-at>6000?reject(Error('mode did not arrive')):setTimeout(check,30);check()}),mode);
    const dimensions=await stage.evaluate(el=>{const segment=el.querySelectorAll('.segment')[1],view=segment.querySelector('.titleViewport'),title=view.querySelector('h1');return {segment:segment.clientWidth,view:view.clientWidth,title:title.clientWidth,height:title.clientHeight,line:Number.parseFloat(getComputedStyle(title).lineHeight)}});
    assert.ok(dimensions.view<=dimensions.segment+1,JSON.stringify(dimensions));
    if(mode==='wrap')assert.ok(dimensions.title<=dimensions.view+1&&dimensions.height>dimensions.line*2,JSON.stringify(dimensions));
    if(mode==='ellipsis')assert.ok(dimensions.title<=dimensions.view+1,JSON.stringify(dimensions));
  }
  await page.reload();
  await editor.locator('.task-navigation').getByRole('button',{name:'Behavior',exact:true}).click();
  await editor.locator('#hidePaused').check();await editor.locator('#pauseHideSeconds').fill('5');await editor.locator('#pauseHideSeconds').dispatchEvent('change');
  await editor.locator('#providerColors').check();await editor.locator('#remainingTime').check();
  await editor.locator('[data-preview-provider=soundcloud]').click();
  assert.equal(await editor.locator('#preview').evaluate(el=>el.style.getPropertyValue('--oaccent')),'#ff9655');
  await editor.getByRole('button',{name:'Pause preview',exact:true}).click();
  assert.equal(await editor.locator('#preview').getAttribute('aria-hidden'),'false');
  await editor.locator('#save').click();await editor.locator('#status').filter({hasText:'Overlay saved'}).waitFor();
  const behaviorSaved=await call('status',null,'song.overlay.read.v1');
  assert.equal(behaviorSaved.config.hidePaused,true);assert.equal(behaviorSaved.config.pauseHideSeconds,5);assert.equal(behaviorSaved.config.providerColors,true);assert.equal(behaviorSaved.config.remainingTime,true);
  await page.reload();await editor.locator('.task-navigation').getByRole('button',{name:'Behavior',exact:true}).click();
  assert.equal(await editor.locator('#hidePaused').isChecked(),true);assert.equal(await editor.locator('#pauseHideSeconds').inputValue(),'5');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await editor.locator('body').evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  if(process.env.RAVELINK_CAPTURE_UI==='1'){
    const output=path.join(__dirname,'../runtime/logs');fs.mkdirSync(output,{recursive:true});
    const view=await browser.newPage({viewport:{width:1200,height:2200}});
    const css=fs.readFileSync(path.join(__dirname,'../features/song-request/ui/overlay-renderer.css'),'utf8');
    await view.setContent('<style>body{background:#202531;color:white;font:16px Arial}.cell{position:relative;height:240px;border-bottom:1px solid #555}h2{font-size:14px;margin:0;padding:4px}</style><style>'+css+'</style>'+gallery.map((p,i)=>'<h2>'+p.name+'</h2><div class="cell" style="height:'+(p.config.preset==='spotlight'?350:200)+'px"><div id="stage'+i+'"></div></div>').join(''));
    await view.addScriptTag({path:path.join(__dirname,'../features/song-request/ui/overlay-renderer.js')});
    await view.evaluate(({gallery,theme})=>gallery.forEach((p,i)=>SongOverlayRenderer.render(document.getElementById('stage'+i),p.config,{status:'paused',positionMs:84000,durationMs:200000,candidate:{provider:'youtube',title:'Example track with a long title',artists:['Artist name']}},[{id:'next',query:'Next track'}],theme)),{gallery,theme});
    await view.screenshot({path:path.join(output,'song-overlay-preset-gallery.png'),fullPage:true});
  }
});
