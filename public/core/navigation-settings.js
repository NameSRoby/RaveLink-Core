(() => {
  const nav=document.getElementById('tabs'),more=document.querySelector('#moreNav .moreNavMenu');
  const known={lights:'Lights',fixtures:'Fixtures',widget:'Widget',updates:'Updates',features:'Packages',mods:'Community mods','feature:song-request':'Song Request','feature:twitch-integration':'Twitch Integration','feature:clip-studio':'Clip Studio (Alpha)'};
  let saved={},loaded=false;
  const dialog=document.createElement('dialog');dialog.id='navigationSettings';
  dialog.innerHTML='<h2>Choose your tabs</h2><p>Keep everyday controls in Main, occasional tools in More, or hide tabs you don’t use. Hiding a tab does not stop or uninstall its feature.</p><div id="navigationChoices"></div><p id="navigationNotice" role="status"></p><div class="actions"><button id="saveNavigation" class="primary">Save tab layout</button><button id="resetNavigation">Use default layout</button><button id="closeNavigation">Cancel</button></div>';
  document.body.append(dialog);
  const open=document.createElement('button');open.id='customizeTabs';open.type='button';open.textContent='CHOOSE TABS';open.onclick=()=>{draw();dialog.showModal();};
  document.getElementById('themePanel').append(open);
  const menuOpen=document.createElement('button');menuOpen.type='button';menuOpen.textContent='CHOOSE TABS';menuOpen.onclick=()=>{document.getElementById('moreNav').open=false;open.click();};more.append(menuOpen);
  const defaultMode=id=>['lights','fixtures','widget','feature:song-request','feature:twitch-integration'].includes(id)?'main':'more';
  function apply(){
    if(!loaded)return;
    for(const button of [...nav.querySelectorAll('[data-tab]')]){
      const id=button.dataset.tab,mode=saved[id]||defaultMode(id),target=mode==='main'?nav:more;
      button.classList.toggle('navigationHidden',mode==='hidden');
      if(button.parentElement!==target){if(target===nav)nav.insertBefore(button,document.getElementById('moreNav'));else more.insertBefore(button,menuOpen);}
    }
    const active=nav.querySelector('[data-tab].active');
    if(active?.classList.contains('navigationHidden')){const next=[...nav.querySelectorAll('[data-tab]')].find(button=>!button.hidden&&!button.classList.contains('navigationHidden'));next?.click();}
  }
  function draw(){
    const choices=document.getElementById('navigationChoices');choices.replaceChildren();
    for(const [id,name] of Object.entries(known)){
      const label=document.createElement('label'),select=document.createElement('select');select.dataset.tabId=id;
      for(const [value,text]of [['main','Main tabs'],['more','More menu'],['hidden','Hidden']])select.add(new Option(text,value));
      select.value=saved[id]||defaultMode(id);label.append(document.createTextNode(name),select);choices.append(label);
    }
    document.getElementById('navigationNotice').textContent=loaded?'You can change this layout any time from the settings gear.':'Could not load your layout. Close this window and try again.';
    document.getElementById('saveNavigation').disabled=!loaded;
  }
  async function save(tabs){
    const notice=document.getElementById('navigationNotice'),button=document.getElementById('saveNavigation');button.disabled=true;notice.textContent='Saving tab layout…';
    try{const response=await fetch('/api/presentation/navigation',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({tabs})});const result=await response.json();if(!response.ok||!result.ok)throw new Error('Could not save your tab layout.');saved=result.tabs;apply();notice.textContent='Tab layout saved.';}
    catch(error){notice.textContent=error.message;}finally{button.disabled=!loaded;}
  }
  document.getElementById('saveNavigation').onclick=()=>save({...saved,...Object.fromEntries([...dialog.querySelectorAll('select')].map(select=>[select.dataset.tabId,select.value]))});
  document.getElementById('resetNavigation').onclick=async()=>{await save({});draw();};
  document.getElementById('closeNavigation').onclick=()=>dialog.close();
  new MutationObserver(apply).observe(nav,{childList:true,subtree:true});
  fetch('/api/presentation/navigation').then(response=>{if(!response.ok)throw new Error();return response.json();}).then(result=>{if(!result.ok)throw new Error();saved=result.tabs;loaded=true;apply();}).catch(()=>{});
})();
