let designerPresetConfigs=new Map(),designerPresetLoad=null,demoLongTitle=false,selectedPreviewPiece='',inspectedPiece=null,inspectedSectionId='',demoProvider='youtube',demoStatus='paused',demoObservedAt=Date.now();
function demoTrack(){return {status:demoStatus,provider:demoProvider,positionMs:84000,durationMs:200000,observedAt:demoObservedAt,candidate:{provider:demoProvider,title:demoLongTitle?'Midnight City / a deliberately long song title to test the overlay':'Midnight City',artists:['The Midnight Sessions'],album:'Live on stream'}}}
function renderQuickControls(){
  const host=$('content-controls');if(!host)return;
  const enabled=new Set(config.segments.filter(s=>s.enabled).flatMap(s=>s.blocks.map(b=>b.kind)));
  host.replaceChildren(...KINDS.map(kind=>{
    const label=node('label','content-toggle'),input=node('input');input.type='checkbox';input.checked=enabled.has(kind);
    input.onchange=()=>{
      if(input.checked){const target=config.segments.findIndex(s=>s.enabled&&s.blocks.some(b=>b.kind==='title'));addBlock(kind,target<0?0:target)}
      else{
        const remaining=config.segments.flatMap(s=>s.blocks).filter(b=>b.kind!==kind);
        if(!remaining.length){input.checked=true;return status('Keep at least one information piece.')}
        for(const segment of config.segments)segment.blocks=segment.blocks.filter(b=>b.kind!==kind);changed(true);
      }
    };
    label.append(input,node('span','',NAMES[kind]));return label;
  }));
  $('preview-size').textContent=config.width+'px wide / '+(config.autoHeight?'fit content':config.height+'px high');
  $('skin').value=config.skin||'classic';
  $('preset-help').textContent=presets.find(p=>p.id===config.preset)?.description||'Your custom design. Save it as a profile to use it again.';
  for(const card of $('preset-gallery').querySelectorAll('button'))card.setAttribute('aria-pressed',String(card.dataset.preset===config.preset));
  syncBehaviorControls();
}
function syncBehaviorControls(){
  for(const id of ['hidePaused','hideStopped','hideLoading','providerColors','remainingTime'])if($(id))$(id).checked=config[id]===true;
  if($('pauseHideSeconds')){$('pauseHideSeconds').value=config.pauseHideSeconds||5;$('pauseHideSeconds').disabled=!config.hidePaused;}
}
function setupBehaviorControls(){
  const panel=$('behavior-panel');
  panel.innerHTML='<h2>Overlay behavior</h2><p>Optional behaviors for OBS. Save overlay to apply them. Your existing display stays unchanged until you enable an option.</p>';
  for(const [id,title,help]of [['hidePaused','Hide when paused','Fade out after the delay below; return as soon as playback resumes.'],['hideStopped','Hide when stopped','Hide a stopped track instead of keeping its last details visible.'],['hideLoading','Hide while loading','Keep the overlay out of the way while a track buffers.'],['providerColors','Use provider colors','YouTube red, SoundCloud orange, TIDAL pale blue. Overrides the accent only.'],['remainingTime','Show time remaining','Show the time left instead of elapsed time.']]){
    const label=node('label','behavior-option'),input=node('input');input.type='checkbox';input.id=id;input.onchange=()=>{config[id]=input.checked;changed(true);status('Behavior updated locally. Save overlay to apply.')};
    const text=node('span');text.append(node('strong','',title),node('small','',help));label.append(input,text);panel.append(label);
    if(id==='hidePaused'){const delay=node('label','behavior-delay','Pause delay (seconds)'),seconds=node('input');seconds.id='pauseHideSeconds';seconds.type='number';seconds.min=1;seconds.max=120;seconds.value=5;seconds.onchange=()=>{if(seconds.reportValidity()){config.pauseHideSeconds=Number(seconds.value);changed(true);status('Pause delay updated locally. Save overlay to apply.')}};delay.append(seconds);panel.append(delay);}
  }
  const test=node('section','behavior-test');test.innerHTML='<h3>Try it in the preview</h3><p>This does not control your music.</p>';
  const colors=node('div','behavior-buttons');colors.setAttribute('aria-label','Preview provider');
  for(const [provider,name]of [['youtube','YouTube'],['tidal','TIDAL'],['soundcloud','SoundCloud']]){const button=node('button','',name);button.type='button';button.dataset.previewProvider=provider;button.onclick=()=>{demoProvider=provider;for(const row of colors.children)row.setAttribute('aria-pressed',String(row===button));renderPreview()};button.setAttribute('aria-pressed',String(provider===demoProvider));colors.append(button);}
  const actions=node('div','behavior-buttons');
  for(const [state,name]of [['paused','Pause preview'],['playing','Resume preview'],['stopped','Stop preview']]){const button=node('button','',name);button.type='button';button.onclick=()=>{demoStatus=state;demoObservedAt=Date.now();SongOverlayRenderer.reset($('preview'));$('preview').dataset.testVisibility='true';renderPreview();status('Preview '+state+'. Live playback is unchanged.')};actions.append(button);}
  test.append(colors,actions);panel.append(test);document.querySelector('.designer-sidebar').append(panel);syncBehaviorControls();
  const timer=setInterval(()=>SongOverlayRenderer.update($('preview')),250);addEventListener('pagehide',()=>clearInterval(timer),{once:true});
}
function updatePieceInspector(){
  const selected=config.segments.flatMap(s=>s.blocks).find(b=>b.id===selectedPreviewPiece);
  const inspector=$('selection-inspector');inspector.hidden=!selected;
  for(const el of $('preview').querySelectorAll('[data-block-id]')){
    const piece=config.segments.flatMap(s=>s.blocks).find(b=>b.id===el.dataset.blockId);
    el.tabIndex=0;el.setAttribute('role','button');el.setAttribute('aria-label','Style '+(NAMES[piece?.kind]||'piece'));
    el.classList.toggle('selected-piece',el.dataset.blockId===selectedPreviewPiece);
  }
  if(selected&&selected!==inspectedPiece){
    inspectedPiece=selected;$('selected-piece-name').textContent=NAMES[selected.kind];
    const tray=formatBlock(selected);tray.hidden=false;$('selected-piece-controls').replaceChildren(tray);
  }
}
async function renderPresetGallery(){
  if(designerPresetLoad)return designerPresetLoad;
  designerPresetLoad=(async()=>{
    for(const entry of presets){
      if(!designerPresetConfigs.has(entry.id)){
        const result=await call('song.overlay.read.v1','preset',{id:entry.id});
        if(result.ok)designerPresetConfigs.set(entry.id,result.config);
      }
    }
    const gallery=$('preset-gallery');
    gallery.replaceChildren(...presets.map(entry=>{
      const button=node('button','preset-card'),thumb=node('div','preset-thumb'),canvas=node('div','preset-canvas'),stage=node('div');
      button.type='button';button.dataset.preset=entry.id;button.title=entry.description;
      canvas.append(stage);thumb.append(canvas);button.append(thumb,node('strong','',entry.name),node('span','preset-description',entry.description));
      button.onclick=async()=>{
        $('preset').value=entry.id;await $('preset').onchange();$('preset-library').open=true;document.getElementById('designer-tasks').selectTask?.('Style');
        $('preview-heading').scrollIntoView({block:'nearest',behavior:'smooth'});
      };
      return button;
    }));
    updatePresetThumbnails();renderQuickControls();
  })().catch(()=>{designerPresetLoad=null;$('preset-gallery').textContent='Presets could not be loaded. Use the preset selector to retry.'});
  return designerPresetLoad;
}
function updatePresetThumbnails(){
  for(const card of $('preset-gallery').querySelectorAll('.preset-card')){
    const c=designerPresetConfigs.get(card.dataset.preset);if(!c)continue;
    const thumb=card.querySelector('.preset-thumb'),canvas=card.querySelector('.preset-canvas'),stage=canvas.firstChild;
    if(!thumb.clientWidth)continue;
    canvas.style.width=(c.width+32)+'px';canvas.style.height='600px';
    SongOverlayRenderer.render(stage,{...c,motion:'off',titleMode:'ellipsis'},demoTrack(),[{id:'next',query:'Next: After Hours'}],appTheme);
    const scale=Math.min(thumb.clientWidth/(c.width+32),thumb.clientHeight/(stage.scrollHeight+24));
    canvas.style.width=(thumb.clientWidth/scale)+'px';canvas.style.height=(thumb.clientHeight/scale)+'px';canvas.style.transform='scale('+scale+')';
  }
}
function setupDesignerControls(){
  document.querySelector('.designer-sidebar').prepend(document.querySelector('.appearance'));
  setupStyleInspector();
  setupContentInspector();
  setupBehaviorControls();
  $('designer-tasks').addEventListener('task-change',event=>{
    if(event.detail!=='Behavior'){$('preview').dataset.testVisibility='false';demoStatus='paused';}
    requestAnimationFrame(()=>{renderPreview();updatePresetThumbnails()});
  });
  $('skin').onchange=()=>{config.skin=$('skin').value;changed(true)};
  $('demo-long-title').onchange=()=>{demoLongTitle=$('demo-long-title').checked;renderPreview()};
  $('preview-mode').onchange=()=>{document.querySelector('.preview-wrap').dataset.mode=$('preview-mode').value;renderPreview()};
  $('preset-library').ontoggle=()=>{if($('preset-library').open)requestAnimationFrame(updatePresetThumbnails)};
  new ResizeObserver(()=>{requestAnimationFrame(updatePresetThumbnails)}).observe($('preset-gallery'));
  const selectPiece=event=>{const el=event.target.closest('[data-block-id]');if(!el)return;selectedPreviewPiece=el.dataset.blockId;updatePieceInspector()};
  $('preview').onclick=selectPiece;
  $('preview').onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();selectPiece(event)}};
  $('close-piece-inspector').onclick=()=>{selectedPreviewPiece='';inspectedPiece=null;updatePieceInspector()};
  void renderPresetGallery();
}
function setupStyleInspector(){
  const appearance=document.querySelector('.appearance');
  const groups=[
    ['Look',['skin','font','titleMode','motion','opacity']],
    ['Spacing',['radius','padding','scale','gap','blockGap']],
    ['Colors',['accent','surface','text','muted']],
    ['Borders',['accentPosition','accentWidth','borderWidth','borderColor']],
    ['Size & position',['anchor','width','artworkSize','heightMode','height','contentAlign','shadow','flow']]
  ];
  const nav=node('nav','style-navigation');nav.setAttribute('aria-label','Overlay appearance controls');
  const panels=[];
  for(const [name,ids] of groups){
    const panel=node('section','style-panel'),fields=node('div','fields');
    panel.dataset.stylePanel=name;
    panel.append(node('h3','',name),fields);
    for(const id of ids)fields.append($(id).closest('label'));
    panels.push(panel);
    const button=node('button','',name);button.type='button';
    button.onclick=()=>select(name);nav.append(button);
  }
  appearance.querySelectorAll('.control-group,.fields').forEach(el=>{if(!panels.some(p=>p.contains(el)))el.remove()});
  appearance.append(nav,...panels);
  function select(name){
    for(const panel of panels)panel.hidden=panel.dataset.stylePanel!==name;
    for(const button of nav.children)button.setAttribute('aria-pressed',String(button.textContent===name));
  }
  select('Look');
}
function setupContentInspector(){
  const panel=document.querySelector('.content-panel'),nav=node('nav','style-navigation content-navigation');
  nav.setAttribute('aria-label','Content and layout controls');
  panel.querySelector('h2').textContent='Content & layout';
  panel.querySelector('p').textContent='Choose information, then arrange it in sections.';
  const information=$('content-controls'),composition=$('composition');
  composition.open=true;panel.append(composition);
  for(const name of ['Information','Arrangement']){
    const button=node('button','',name);button.type='button';
    button.onclick=()=>{
      information.hidden=name!=='Information';composition.hidden=name!=='Arrangement';
      for(const item of nav.children)item.setAttribute('aria-pressed',String(item===button));
    };
    nav.append(button);
  }
  panel.insertBefore(nav,information);nav.firstChild.click();
  const selector=node('div','section-picker');selector.id='section-picker';
  composition.querySelector('.builder').prepend(selector);
  const general=node('div','arrangement-options');
  general.append($('flow').closest('label'),$('separated').closest('label'));
  selector.after(general);
  const add=$('addSegment').onclick;
  $('addSegment').onclick=()=>{add();inspectedSectionId=config.segments.at(-1)?.id||'';updateArrangementSelection()};
  updateArrangementSelection();
}
function updateArrangementSelection(){
  const selector=$('section-picker');if(!selector)return;
  if(!config.segments.some(row=>row.id===inspectedSectionId))inspectedSectionId=config.segments[0]?.id||'';
  selector.replaceChildren(...config.segments.map((row,index)=>{
    const button=node('button','',row.name||'Section '+(index+1));button.type='button';
    button.dataset.sectionId=row.id;button.title='Select section, or drop a piece here to move it into this section';
    const select=()=>{inspectedSectionId=row.id;showInspectedSection()};
    button.onclick=select;button.ondragenter=()=>{if(drag)select()};
    button.ondragover=event=>event.preventDefault();
    button.ondrop=event=>{event.preventDefault();select();dropInto(index)};return button;
  }));
  showInspectedSection();
}
function showInspectedSection(){
  for(const button of $('section-picker').children)button.setAttribute('aria-pressed',String(button.dataset.sectionId===inspectedSectionId));
  for(const [index,card] of [...$('workspace').children].entries())card.hidden=config.segments[index]?.id!==inspectedSectionId;
}
