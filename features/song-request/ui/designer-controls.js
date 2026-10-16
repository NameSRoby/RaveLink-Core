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
  updateCanvasInspector();
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
  setupCanvasControls();
  updateCanvasInspector();
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

let selectedShapeId='',canvasGesture=null,canvasSnap=true,canvasGuides=[],updatingCanvasInspector=false;
const bounded=(value,min,max)=>Math.max(min,Math.min(max,Math.round(value)));
function canvasTarget(){
  const row=selectedPreviewPiece?config.segments.find(s=>s.blocks.some(b=>b.id===selectedPreviewPiece)):config.segments.find(s=>s.id===selectedShapeId);
  return selectedPreviewPiece?row?.blocks.find(b=>b.id===selectedPreviewPiece):row;
}
function enableCanvas(){
  if(config.layoutMode==='canvas')return;
  const stage=$('preview'),ratio=stage.getBoundingClientRect().width/stage.offsetWidth;
  const origin=stage.getBoundingClientRect();
  for(const row of config.segments){
    const el=[...stage.children].find(n=>n.dataset.segmentId===row.id);if(!el)continue;
    const r=el.getBoundingClientRect();
    row.frame={x:bounded((r.left-origin.left)/ratio-stage.clientLeft,0,960),y:bounded((r.top-origin.top)/ratio-stage.clientTop,0,600),width:bounded(r.width/ratio,1,960),height:bounded(r.height/ratio,1,600)};
    row.shape='rounded';
    for(const b of row.blocks){const n=[...el.children].find(n=>n.dataset.blockId===b.id);if(!n)continue;const br=n.getBoundingClientRect();b.frame={x:bounded((br.left-r.left)/ratio-el.clientLeft,0,960),y:bounded((br.top-r.top)/ratio-el.clientTop,0,600),width:bounded(br.width/ratio,1,960),height:bounded(br.height/ratio,1,600)};}
  }
  config.height=bounded(stage.offsetHeight,80,600);config.autoHeight=false;config.layoutMode='canvas';changed(true);
  status('Canvas editing enabled. Drag objects to move; use corner handles to resize. Save overlay to apply.');
}
function setupCanvasControls(){
  const toolbar=node('div','canvas-toolbar');toolbar.id='canvas-toolbar';
  const edit=node('button','','Edit on canvas');edit.id='edit-canvas';edit.onclick=enableCanvas;
  const width=node('input'),height=node('input');
  for(const [input,key,min,max]of [[width,'width',240,960],[height,'height',80,600]]){input.type='number';input.id='canvas-'+key;input.min=min;input.max=max;input.onchange=()=>{if(!input.reportValidity())return;enableCanvas();config[key]=Number(input.value);config.autoHeight=false;changed(true)};}
  const trim=node('button','','Fit to objects');trim.onclick=()=>{enableCanvas();config.height=bounded(Math.max(...config.segments.filter(s=>s.enabled).map(s=>(s.frame?.y||0)+(s.frame?.height||0)))+config.borderWidth*2,80,600);changed(true)};
  const shape=select(['rectangle','rounded','ellipse'],'rounded',()=>{});shape.id='new-shape';shape.setAttribute('aria-label','New shape');
  const add=node('button','','Add shape');add.id='add-shape';add.onclick=()=>{
    if(config.segments.length>=8)return status('Eight shape limit reached');enableCanvas();
    const row={id:'shape-'+Date.now().toString(36),name:'Shape '+(config.segments.length+1),enabled:true,direction:'column',align:'left',size:'wide',shape:shape.value,frame:{x:12,y:12,width:Math.min(180,config.width-24),height:Math.min(80,config.height-24)},style:{surface:config.surface,accent:'',opacity:config.opacity,padding:0,radius:16,accentWidth:0},blocks:[]};
    config.segments.push(row);selectedShapeId=row.id;selectedPreviewPiece='';changed(true);
  };
  const snap=node('input');snap.type='checkbox';snap.id='canvas-snap';snap.checked=true;snap.onchange=()=>canvasSnap=snap.checked;const snapLabel=node('label','switchLabel');snapLabel.append(snap,node('span','','Snap to guides'));toolbar.append(edit,labeled('Width',width),labeled('Height',height),trim,shape,add,snapLabel);
  document.querySelector('.preview-footer').after(toolbar);
  const help=node('p','canvas-help','Click information or a shape to select it. In canvas mode, drag to move, pull a corner to resize, or use the exact size controls. Arrow keys nudge; Shift moves 10px.');toolbar.after(help);
  const library=node('section','canvas-library');library.id='canvas-library';document.querySelector('.content-panel').append(library);
  const info=select(KINDS,'title',()=>{});info.id='new-information';info.setAttribute('aria-label','Information to add');for(const option of info.options)option.textContent=NAMES[option.value];
  const addInfo=node('button','','Add information');addInfo.id='canvas-add-information';addInfo.onclick=()=>{enableCanvas();const row=config.segments.find(s=>s.id===selectedShapeId)||config.segments[0];addBlock(info.value,config.segments.indexOf(row));const b=row.blocks.at(-1);selectedPreviewPiece=b.id;selectedShapeId=row.id;changed(true)};toolbar.append(info,addInfo);
  const inspector=node('section','canvas-inspector');inspector.id='canvas-inspector';inspector.hidden=true;document.querySelector('.left').append(inspector);
  const paletteClick=event=>{const piece=event.target.closest('.piece');if(!piece||config.layoutMode!=='canvas')return;event.stopImmediatePropagation();const kind=KINDS.find(k=>NAMES[k]===piece.querySelector('.piece-name')?.textContent);if(!kind)return;const row=config.segments.find(s=>s.id===selectedShapeId)||config.segments[0];addBlock(kind,config.segments.indexOf(row));const block=row.blocks.at(-1);block.frame={x:8,y:8,width:Math.max(1,Math.min(160,(row.frame?.width||180)-16)),height:kind==='progress'?4:kind==='artwork'?60:28};selectedPreviewPiece=block.id;selectedShapeId=row.id;changed(true)};
  $('palette').addEventListener('click',paletteClick,true);
  const addSection=$('addSegment').onclick;$('addSegment').onclick=()=>{if(config.layoutMode==='canvas')add.click();else addSection()};
  $('preview').onpointerdown=startCanvasGesture;
  $('preview').onclick=event=>{if(canvasGesture)return;const b=event.target.closest('[data-block-id]'),s=event.target.closest('[data-segment-id]');if(event.target.closest('.canvas-selection'))return;selectedPreviewPiece=b?.dataset.blockId||'';selectedShapeId=s?.dataset.segmentId||'';updatePieceInspector()};
  $('preview').onkeydown=event=>{
    if(['Enter',' '].includes(event.key)){event.preventDefault();event.target.click();return;}
    const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];const target=canvasTarget();if(!delta||!target?.frame||config.layoutMode!=='canvas')return;event.preventDefault();target.frame.x=bounded(target.frame.x+delta[0]*(event.shiftKey?10:1),0,960);target.frame.y=bounded(target.frame.y+delta[1]*(event.shiftKey?10:1),0,600);changed();focusCanvasTarget();
  };
}
function updateCanvasInspector(){
  if(updatingCanvasInspector)return;updatingCanvasInspector=true;
  try{
  if(!$('canvas-toolbar'))return;
  document.body.dataset.canvasEditing=String(config.layoutMode==='canvas');
  const library=$('canvas-library');library.replaceChildren(node('h3','','Objects'));
  for(const row of config.segments){const selectObject=(text,id)=>{const button=node('button','canvas-object',text);button.type='button';button.setAttribute('aria-pressed',String(id?selectedPreviewPiece===id:!selectedPreviewPiece&&selectedShapeId===row.id));button.onclick=()=>{selectedShapeId=row.id;selectedPreviewPiece=id||'';updatePieceInspector()};return button};library.append(selectObject(row.name||'Shape'));for(const b of row.blocks)library.append(selectObject('  '+NAMES[b.kind],b.id));}
  for(const key of ['width','height'])if(document.activeElement!==$('canvas-'+key))$('canvas-'+key).value=config[key];
  $('edit-canvas').textContent=config.layoutMode==='canvas'?'Canvas editing active':'Edit on canvas';
  $('preview').querySelectorAll('.canvas-selection,.canvas-guide').forEach(n=>n.remove());
  const target=canvasTarget(),panel=$('canvas-inspector');panel.hidden=!target;
  if(!target)return;
  const row=config.segments.find(s=>s.id===selectedShapeId)||config.segments.find(s=>s.blocks.includes(target));
  const title=node('strong','',selectedPreviewPiece?NAMES[target.kind]:row.name||'Shape');
  const done=node('button','','Deselect');done.onclick=()=>{selectedPreviewPiece='';selectedShapeId='';updatePieceInspector()};
  const heading=node('div','inspector-heading');heading.append(title,done);panel.replaceChildren(heading);
  if(config.layoutMode!=='canvas'){const edit=node('button','','Move and resize on canvas');edit.onclick=enableCanvas;panel.append(edit);return;}
  for(const el of $('preview').querySelectorAll('[data-segment-id]')){el.tabIndex=0;el.setAttribute('role','button');el.setAttribute('aria-label','Select shape '+(config.segments.find(s=>s.id===el.dataset.segmentId)?.name||''));}
  const fields=node('div','canvas-fields');
  for(const key of ['x','y','width','height']){const input=node('input');input.type='number';input.min=['width','height'].includes(key)?1:0;input.max=['x','width'].includes(key)?960:600;input.value=target.frame?.[key]||0;input.dataset.geometry=key;input.onchange=()=>{if(!input.reportValidity()||target.frame[key]===Number(input.value))return;target.frame[key]=Number(input.value);queueMicrotask(()=>changed())};fields.append(labeled(key[0].toUpperCase()+key.slice(1),input));}
  panel.append(fields);
  if(!selectedPreviewPiece){const shape=select(['rectangle','rounded','ellipse'],row.shape||'rectangle',v=>{row.shape=v;changed()});panel.append(labeled('Shape',shape));const tray=formatSegment(row);tray.hidden=false;panel.append(tray);}
  const alignment=node('div','canvas-actions');alignment.setAttribute('aria-label','Align selected object');
  for(const [label,axis,edge]of [['Align left','x',0],['Center horizontally','x',.5],['Align right','x',1],['Align top','y',0],['Center vertically','y',.5],['Align bottom','y',1]]){const button=node('button','',label);button.onclick=()=>{const limit=selectedPreviewPiece?row.frame:config,size=axis==='x'?'width':'height';target.frame[axis]=bounded((limit[size]-target.frame[size])*edge,0,axis==='x'?960:600);changed()};alignment.append(button);}panel.append(alignment);
  if(selectedPreviewPiece){const text=select(['left','center','right'],target.style?.align||'left',value=>{blockStyle(target).align=value;changed()});panel.append(labeled('Text alignment',text));}
  const actions=node('div','canvas-actions');
  const layer=(label,delta)=>{const button=node('button','',label);button.onclick=()=>{const list=selectedPreviewPiece?row.blocks:config.segments,index=list.indexOf(target),next=bounded(index+delta,0,list.length-1);list.splice(index,1);list.splice(next,0,target);changed(true)};return button};
  const remove=node('button','','Delete selected');remove.onclick=()=>{if(selectedPreviewPiece)row.blocks=row.blocks.filter(b=>b!==target);else{if(config.segments.length===1)return status('Keep at least one shape.');config.segments=config.segments.filter(s=>s!==target);}selectedPreviewPiece='';selectedShapeId='';changed(true)};
  actions.append(layer('Send backward',-1),layer('Bring forward',1),remove);panel.append(actions);
  if(selectedPreviewPiece){const move=select(config.segments.map(s=>s.id),row.id,id=>{const next=config.segments.find(s=>s.id===id);row.blocks=row.blocks.filter(b=>b!==target);next.blocks.push(target);selectedShapeId=next.id;target.frame.x=0;target.frame.y=0;changed(true)});for(const option of move.options)option.textContent=config.segments.find(s=>s.id===option.value).name;panel.append(labeled('Move to shape',move));}
  $('preview').querySelector('.canvas-selection')?.remove();
  const el=selectedPreviewPiece?[...$('preview').querySelectorAll('[data-block-id]')].find(n=>n.dataset.blockId===selectedPreviewPiece):[...$('preview').children].find(n=>n.dataset.segmentId===row.id);if(!el)return;
  const frame=target.frame,overlay=node('div','canvas-selection');
  const x=frame.x+(selectedPreviewPiece?(row.frame?.x||0)+el.parentElement.clientLeft:0),y=frame.y+(selectedPreviewPiece?(row.frame?.y||0)+el.parentElement.clientTop:0);
  Object.assign(overlay.style,{left:x+'px',top:y+'px',width:frame.width+'px',height:frame.height+'px'});
  for(const corner of ['nw','ne','sw','se']){const handle=node('span','canvas-handle '+corner);handle.dataset.corner=corner;overlay.append(handle);}
  $('preview').append(overlay);
  for(const guide of canvasGuides){const line=node('div','canvas-guide '+guide.axis);Object.assign(line.style,guide.axis==='x'?{left:guide.value+'px',top:guide.start+'px',height:guide.length+'px'}:{top:guide.value+'px',left:guide.start+'px',width:guide.length+'px'});$('preview').append(line);}
  }
  finally{updatingCanvasInspector=false;}
}
function startCanvasGesture(event){
  if(event.button!==0||config.layoutMode!=='canvas')return;
  const handle=event.target.closest('[data-corner]'),b=event.target.closest('[data-block-id]'),s=event.target.closest('[data-segment-id]');
  if(!handle){selectedPreviewPiece=b?.dataset.blockId||'';selectedShapeId=s?.dataset.segmentId||'';}
  const target=canvasTarget();if(!target?.frame)return;
  event.preventDefault();updatePieceInspector();
  const start={...target.frame},stage=$('preview'),ratio=stage.getBoundingClientRect().width/stage.offsetWidth,px=event.clientX,py=event.clientY,corner=handle?.dataset.corner;
  canvasGesture=true;
  const move=e=>{const dx=Math.round((e.clientX-px)/ratio),dy=Math.round((e.clientY-py)/ratio);const f=target.frame;
    if(!corner){f.x=bounded(start.x+dx,0,960);f.y=bounded(start.y+dy,0,600);}
    else{const west=corner.includes('w'),north=corner.includes('n');f.width=bounded(start.width+(west?-dx:dx),1,960);f.height=bounded(start.height+(north?-dy:dy),1,600);if(west)f.x=bounded(start.x+start.width-f.width,0,960);if(north)f.y=bounded(start.y+start.height-f.height,0,600);}
    canvasGuides=[];
    if(canvasSnap&&!e.altKey)snapCanvasFrame(target,corner,6/ratio);
    config.preset='custom';renderPreview();
  };
  const end=()=>{canvasGuides=[];window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);changed(true);focusCanvasTarget();setTimeout(()=>canvasGesture=null,0)};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
}
function snapCanvasFrame(target,corner,tolerance){
  const row=config.segments.find(s=>s.blocks.includes(target)),parent=row?.frame||config;
  const ox=row?.frame?.x||0,oy=row?.frame?.y||0;
  const siblings=(row?row.blocks:config.segments).filter(s=>s!==target&&(s.enabled!==false)&&s.frame);
  const f=target.frame;
  for(const axis of ['x','y']){
    const size=axis==='x'?'width':'height',limit=parent[size],origin=axis==='x'?ox:oy;
    const lines=[0,limit/2,limit,...siblings.flatMap(s=>[s.frame[axis],s.frame[axis]+s.frame[size]/2,s.frame[axis]+s.frame[size]])];
    const offsets=corner?[corner.includes(axis==='x'?'w':'n')?0:f[size]]:[0,f[size]/2,f[size]];
    let best=null;
    for(const line of lines)for(const offset of offsets){const distance=line-(f[axis]+offset);if(Math.abs(distance)<=tolerance&&(!best||Math.abs(distance)<Math.abs(best.distance)))best={distance,line,offset};}
    if(!best)continue;
    if(!corner)f[axis]=bounded(f[axis]+best.distance,0,axis==='x'?960:600);
    else if(best.offset===0){const end=f[axis]+f[size];f[axis]=bounded(f[axis]+best.distance,0,axis==='x'?960:600);f[size]=Math.max(1,end-f[axis]);}
    else f[size]=bounded(f[size]+best.distance,1,axis==='x'?960:600);
    canvasGuides.push({axis,value:origin+best.line,start:axis==='x'?oy:ox,length:axis==='x'?parent.height:parent.width});
  }
}
function focusCanvasTarget(){
  const selector=selectedPreviewPiece?'[data-block-id]':'[data-segment-id]',id=selectedPreviewPiece||selectedShapeId;
  [...$('preview').querySelectorAll(selector)].find(el=>(el.dataset.blockId||el.dataset.segmentId)===id)?.focus({preventScroll:true});
}
