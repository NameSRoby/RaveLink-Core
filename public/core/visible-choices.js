function installVisibleChoices() {
  if(window.RaveLinkChoices)return;
  const shortIds=new Set(['twitchRoutingMode','lightingProfileStrategy','layoutKind','labSpatialDirection','songPlayerProvider','catalogMode','csvDelimiter','transferGrouping','matchReviewFilter','preview-mode','font','titleMode','anchor','motion','accentPosition','flow','heightMode','contentAlign']);
  const listIds=new Set(['lightingProfileSelect','profile-select']);
  const records=new WeakMap();let serial=0,scheduled=false;
  const style=document.createElement('style');style.textContent='.choiceBacking{display:none!important}.visibleChoiceControl{min-width:0;max-width:100%;font-size:12px;letter-spacing:0}.visibleChoices{display:flex;flex-wrap:wrap;gap:5px;min-width:0;max-width:100%}.visibleChoices button{height:auto!important;min-height:32px!important;min-width:0;max-width:100%;padding:6px 9px!important;font-size:12px!important;line-height:1.3;white-space:normal;text-align:center;border:1px solid var(--edge,#304261);border-radius:6px;color:var(--text,#eee);background:var(--surface,#131c2b)}.visibleChoices button[aria-checked=true]{border-color:var(--accent,#b31132);background:color-mix(in srgb,var(--accent,#b31132) 22%,var(--surface,#131c2b));box-shadow:inset 0 -2px var(--accent,#b31132)}.visibleChoices button:focus-visible{outline:2px solid var(--accent,#b31132);outline-offset:2px}.visibleChoiceList{width:min(100%,560px)}.visibleChoiceList>input{width:100%;min-width:0;height:36px;margin-bottom:7px}.visibleChoiceList .visibleChoices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.visibleChoiceList button{text-align:left}.visibleChoiceFooter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:7px;font-size:11px;color:var(--muted,#aab)}.visibleChoiceFooter button{font-size:11px;min-height:28px;height:auto;padding:4px 8px}.visibleChoiceStatus{font-size:11px;line-height:1.5;color:var(--muted,#aab);margin:6px 0}.playerProviderPicker>.visibleChoiceControl{flex:none}.segment-head .visibleChoices button{font-size:11px!important}#navigationChoices .visibleChoiceControl{flex:none}#navigationChoices .visibleChoices button{font-size:11px!important;min-height:30px!important}@media(max-width:620px){#navigationChoices label{flex-direction:column;align-items:flex-start}#navigationChoices .visibleChoiceControl{width:100%}.visibleChoiceList .visibleChoices{grid-template-columns:1fr}.visibleChoices button{font-size:11px!important}.playerProviderPicker>.visibleChoiceControl{flex:1 1 100%}}';style.textContent+='#designer-tasks .style-panel .visibleChoices{gap:4px}#designer-tasks .style-panel .visibleChoices button{min-height:26px!important;font-size:10px!important;padding:4px 6px!important}#designer-tasks [data-choice-for=anchor] .visibleChoices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}';document.head.append(style);
  function labelFor(select){
    if(select.getAttribute('aria-label'))return select.getAttribute('aria-label');
    const label=select.labels?.[0]?.cloneNode(true);label?.querySelectorAll('select,.visibleChoiceControl,input,button').forEach(node=>node.remove());
    return label?.textContent.trim().replace(/\s+/g,' ').slice(0,100)||'Choose an option';
  }
  function install(select,list){
    const root=document.createElement('div');root.className='visibleChoiceControl'+(list?' visibleChoiceList':'');
    if(!select.id)select.id='choice-select-'+(++serial);root.dataset.choiceFor=select.id;
    const group=document.createElement('div');group.className='visibleChoices';group.setAttribute('role','radiogroup');group.setAttribute('aria-label',labelFor(select));
    let search=null,status=null,footer=null,previous=null,next=null,count=null,page=0,lastValue=select.value,signature='';
    if(list){search=document.createElement('input');search.type='search';search.placeholder='Search saved profiles';search.setAttribute('aria-label','Search '+labelFor(select));status=document.createElement('p');status.className='visibleChoiceStatus';footer=document.createElement('div');footer.className='visibleChoiceFooter';previous=document.createElement('button');next=document.createElement('button');count=document.createElement('span');previous.type=next.type='button';previous.textContent='Previous';next.textContent='Next';footer.append(previous,count,next);root.append(search,status);}
    root.append(group);if(footer)root.append(footer);select.after(root);select.classList.add('choiceBacking');select.setAttribute('aria-hidden','true');select.tabIndex=-1;
    const options=()=>[...select.options].filter(option=>!option.hidden);
    function choose(value){select.value=value;select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));render();}
    function render(){
      if(!select.isConnected)return;
      const all=options(),needle=search?.value.trim().toLocaleLowerCase()||'',filtered=all.filter(option=>option.textContent.toLocaleLowerCase().includes(needle)),disabled=select.matches(':disabled');
      if(list&&select.value!==lastValue&&!needle)page=Math.max(0,Math.floor(filtered.findIndex(option=>option.value===select.value)/6));
      lastValue=select.value;page=Math.max(0,Math.min(page,Math.ceil(filtered.length/6)-1));
      const shown=list?filtered.slice(page*6,page*6+6):all,key=JSON.stringify(shown.map(option=>[option.value,option.textContent,option.disabled]));
      if(key!==signature){signature=key;group.replaceChildren();for(const option of shown){const button=document.createElement('button');button.type='button';button.setAttribute('role','radio');button.dataset.choiceValue=option.value;button.textContent=option.textContent;button.onclick=()=>choose(option.value);group.append(button);}}
      for(const button of group.children){const option=shown.find(row=>row.value===button.dataset.choiceValue),selected=button.dataset.choiceValue===select.value;button.disabled=disabled||Boolean(option?.disabled);button.setAttribute('aria-checked',String(selected));button.tabIndex=selected&&!button.disabled?0:-1;}
      if(!group.querySelector('[tabindex="0"]')){const first=[...group.children].find(button=>!button.disabled);if(first)first.tabIndex=0;}
      root.hidden=select.hidden;group.setAttribute('aria-disabled',String(disabled));
      if(list){search.disabled=disabled;status.textContent='Selected: '+(select.selectedOptions[0]?.textContent||'None');count.textContent=filtered.length?`${page*6+1}–${Math.min(filtered.length,page*6+6)} of ${filtered.length}`:'No matching profiles';previous.disabled=disabled||page===0;next.disabled=disabled||(page+1)*6>=filtered.length;footer.hidden=filtered.length<=6;search.hidden=all.length<=6;}
    }
    group.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;const buttons=[...group.children].filter(button=>!button.disabled);if(!buttons.length)return;event.preventDefault();const index=buttons.indexOf(document.activeElement),at=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+buttons.length)%buttons.length;const button=buttons[at];choose(button.dataset.choiceValue);button.focus();};
    if(list){search.oninput=()=>{page=0;signature='';render();};previous.onclick=()=>{page--;signature='';render();};next.onclick=()=>{page++;signature='';render();};}
    select.addEventListener('change',render);
    // Existing controllers set select.value directly while restoring state.
    for(const name of ['value','selectedIndex']){const descriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,name);if(descriptor?.set)Object.defineProperty(select,name,{configurable:true,get(){return descriptor.get.call(this);},set(value){descriptor.set.call(this,value);render();}});}
    records.set(select,{render});render();
  }
  function scan(){
    scheduled=false;
    for(const select of document.querySelectorAll('select')){
      const record=records.get(select);if(record){record.render();continue;}
      const short=shortIds.has(select.id)||select.matches('[data-field="mode"],#navigationChoices select,#selected-piece-controls select,.format-tray select');
      if(listIds.has(select.id))install(select,true);else if(short&&select.options.length>=2&&select.options.length<=6)install(select,false);
    }
    const gallery=document.getElementById('preset-gallery'),picker=document.querySelector('#preset-library .preset-selector');if(gallery&&picker&&picker.hidden!==(gallery.childElementCount>0))picker.hidden=gallery.childElementCount>0;
  }
  const observer=new MutationObserver(changes=>{if(scheduled||changes.every(change=>change.target.closest?.('.visibleChoiceControl')))return;scheduled=true;queueMicrotask(scan);});
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','hidden','selected','value','label']});
  window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});window.RaveLinkChoices={refresh:scan};scan();
}
if(typeof module!=='undefined'&&module.exports)module.exports=installVisibleChoices;
else installVisibleChoices();
