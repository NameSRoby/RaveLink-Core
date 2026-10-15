window.installTransferFlow = function ({ panel, sourceControls, account, activity, organization }) {
  const providers = window.PlaylistProviderUI;
  const stepper = document.createElement('nav'); stepper.id = 'transferSteps'; stepper.setAttribute('aria-label','Transfer steps');
  const route = document.createElement('div'); route.id = 'transferRoute'; route.hidden = true;
  const sections = [1,2,3].map((number,index) => {
    const section = document.createElement('section'); section.id = 'transferStep'+number; section.className = 'transferStep';
    const heading = document.createElement('h3'); heading.textContent = [ '1. Choose your playlist', '2. Where should it go?', '3. Check your matches' ][index]; section.append(heading);
    const button = document.createElement('button'); button.type='button'; button.dataset.step=number; button.textContent = [ '1  Source', '2  Destination', '3  Check matches' ][index]; button.onclick=()=>show(number); stepper.append(button); return section;
  });
  const sourceCards=document.createElement('div'); sourceCards.id='transferSourceChoices'; sourceCards.className='providerChoices';
  const targetCards=document.createElement('div'); targetCards.id='transferTargetChoices'; targetCards.className='providerChoices';
  sections[0].append(sourceCards, sourceControls); sections[1].append(targetCards);
  const introduction=[...panel.children].find(node=>node.tagName==='P'); (introduction||panel.querySelector('h2')).after(stepper,route,$('transferNotice'),activity,...sections);
  const sourceSelect=$('transferSource'),targetSelect=$('transferTarget'); sourceSelect.hidden=targetSelect.hidden=true;
  sourceSelect.closest('label').hidden=targetSelect.closest('label').hidden=true; sourceSelect.selectedIndex=-1;
  for(const [provider,detail]of [['library','Choose a saved playlist'],['tidal','Your TIDAL account or playlist link'],['csv','Load a CSV file']])
    sourceCards.append(providers.card(provider,detail,()=>{sourceSelect.value=provider;sourceSelect.onchange();}));
  for(const [provider,detail]of [['youtube','Save matched tracks in RaveLink'],['tidal','Create a playlist in your account'],['soundcloud','Save matched tracks in RaveLink'],['csv','Download the original track details'],['library','Save an original local copy']])
    targetCards.append(providers.card(provider,detail,()=>chooseTarget(provider)));
  const destination=$('transferTarget').closest('.band'); destination.id='transferDestination';destination.previousElementSibling.remove();
  sections[1].append(destination,$('saveLocal').closest('.band'));
  const exportBox=document.createElement('div');exportBox.id='transferCsvDestination';exportBox.innerHTML='<p>Export the loaded playlist with its original track details.</p>';exportBox.append($('exportCollection'));sections[1].append(exportBox);
  sections[2].append($('transferReview')); sections[2].querySelector('h3').after(organization);
  const finalActions=document.createElement('div');finalActions.id='transferSaveActions';finalActions.className='band';finalActions.append($('saveMatched'),$('writeTidal'));
  sections[2].append(finalActions);
  destination.append($('destinationHelp')); destination.removeAttribute('class');destination.className='destinationAction';
  const csvHelp=document.createElement('p');csvHelp.textContent='The CSV is downloaded by your browser; a copy is also kept under Saved CSV exports.';exportBox.append(csvHelp);
  $('saveLocal').closest('.band').id='transferSourceSave';
  const names = {youtube:'YouTube',tidal:'TIDAL',soundcloud:'SoundCloud'};
  let step=1,job=null,lastId='',choice='',connected=false,loadingLink=false;
  function chooseTarget(provider){choice=provider;if(names[provider]){targetSelect.value=provider;targetSelect.onchange();}show(2);}
  function show(number){step=number;paint();}
  function paint(){
    const busy=['reading','matching','writing','uncertain'].includes(job?.state),complete=job?.state==='complete',matched=job?.kind==='matching', changed=matched&&choice!==job.target;
    sections.forEach((section,index)=>section.hidden=step!==index+1);
    [...stepper.children].forEach((button,index)=>{const n=index+1;button.setAttribute('aria-current',step===n?'step':'false');button.disabled=loadingLink||n===1&&busy||n===2&&(!job||busy||complete)||n===3&&(!matched&&!complete||changed);});
    for(const button of sourceCards.children){button.setAttribute('aria-pressed',String(button.dataset.provider===sourceSelect.value));button.disabled=busy||loadingLink;}
    for(const button of targetCards.children){button.setAttribute('aria-pressed',String(button.dataset.provider===choice));button.disabled=busy||Boolean(job?.targetLocked);}
    for(const name of ['csv','library','tidal'])$(name+'Source').hidden=sourceSelect.value!==name;
    const service=Boolean(names[choice]);destination.hidden=!service;$('transferSourceSave').hidden=choice!=='library';exportBox.hidden=choice!=='csv';
    if(service){targetSelect.value=choice;$('matchTidal').textContent='Find '+names[choice]+' matches';}
    $('matchTidal').disabled=!job||busy||Boolean(job.targetLocked)||choice==='tidal'&&!connected;
    $('saveLocal').disabled=!job||busy;$('exportCollection').disabled=!job||busy;
    $('saveMatched').hidden=!matched||job.target==='tidal'||complete;$('writeTidal').hidden=!matched||job.target!=='tidal'||complete;
    $('saveMatched').disabled=!matched||changed||busy||!job.selected; $('previewTransferPlan').disabled=!matched||changed||busy||!job.selected;
    finalActions.hidden=!matched||changed||complete||busy||job?.state==='paused';organization.hidden=finalActions.hidden;
    $('transferReview').hidden=!job||changed||busy||complete||job.state==='paused';$('exportTransferReport').hidden=!job;
    const needsAccount=!connected&&((step===1&&sourceSelect.value==='tidal')||(step===2&&choice==='tidal'));
    account.hidden=!needsAccount;if(needsAccount){account.open=true;(step===1?sections[0]:sections[1]).append(account);}
    route.hidden=!job;if(job){route.replaceChildren(providers.badge(job.sourceKind==='csv'?'csv':job.sourceProviders?.length===1?job.sourceProviders[0]:job.sourceKind==='tidal'?'tidal':'library'));const name=document.createElement('span');name.textContent=job.name+' · '+job.count+' tracks';route.append(name);if(choice){const arrow=document.createElement('span');arrow.textContent='→';route.append(arrow,providers.badge(choice));}}
    $('transferStartNew').hidden=!job||busy||step===1;$('transferStartNew').textContent='Change source';
  }
  $('transferStartNew').onclick=()=>show(1);
  return { render(current){job=current;if(job?.id!==lastId){lastId=job?.id||'';choice=job?.kind==='matching'?job.target:'';step=job?job.kind==='matching'?3:job.state==='reading'?1:2:1;}
      if(job?.state==='matching'||job?.state==='writing'||job?.state==='uncertain'||job?.state==='complete')step=3;
      if(job?.state==='review'&&job.kind!=='matching'&&step===1&&job.sourceKind==='tidal')step=2;paint(); },
    source(){show(1);},account(value){connected=value;paint();},loading(value){loadingLink=value;paint();},getSource:()=>sourceSelect.value,show
  };
};
(() => {const style=document.createElement('style');style.textContent='#transferSteps{display:flex;gap:8px;margin:18px 0;flex-wrap:wrap}#transferSteps button{height:38px;color:var(--muted);font-size:13px}#transferSteps [aria-current=step]{color:var(--text);border-color:var(--accent);background:var(--surface,#121b2e)}.transferStep{border:1px solid var(--edge);border-radius:12px;padding:20px;margin:16px 0;background:var(--panel,#0b101b)}.transferStep>h3{font-size:20px;margin:0 0 12px}#transferRoute{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0;color:var(--muted);font-size:13px}#transferActivity h3{font-size:16px}#transferSourceControls>.band{border:0;padding:0;margin-top:16px}.destinationAction{display:flex;flex-wrap:wrap;align-items:center;gap:12px}#transferSaveActions{border:0;margin:18px 0 0;padding:14px 0 0;justify-content:flex-end}#transferSaveActions button{min-width:220px}#transferProgress{font-size:11px}#transferReview table{margin-top:18px}#transferReview td:first-child .providerBadge{display:flex;margin-bottom:6px;font-size:11px}#transferReview td:first-child .providerMark{width:14px;height:14px}.matchConfidence{display:inline-block;border:1px solid currentColor;border-radius:20px;padding:3px 8px;margin-bottom:8px;font-size:11px;font-weight:700}.matchConfidence[data-level=strong]{color:#73dfac}.matchConfidence[data-level=review]{color:#efd282}.matchConfidence[data-level=weak]{color:#ff8e9e}#matchReviewTools>p{font-size:12px;line-height:1.5;color:var(--muted)}#matchQuickChoices{margin:0}#transferOrganization{padding:4px 0;border:0}#transferOrganization>label{display:inline-grid;margin:12px 8px 12px 0}#transferActivity #transferMeter{height:7px}#transferNotice:empty{display:none}#matchReviewTools>.band{display:grid;grid-template-columns:160px minmax(180px,1fr) auto;align-items:end}#matchQuickChoices{display:flex;gap:6px;flex-wrap:wrap;grid-column:1/-1;order:4}#matchReviewTools input,#matchReviewTools select{min-width:0;width:100%}#transferActivity[data-state=review]{padding:14px 18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}#transferActivity[data-state=review] h3{margin:0;font-size:16px}#transferActivity[data-state=review] #transferStage,#transferActivity[data-state=review] #transferNextStep{display:none}#transferActivity[data-state=review] #transferStatusActions,#transferActivity[data-state=review] #transferStartNew{margin:0}#transferActivity[data-state=review] #transferStats{margin-right:auto}@media(max-width:620px){.transferStep{padding:14px}#matchReviewTools>.band{grid-template-columns:1fr}#matchQuickChoices{grid-column:1}#transferSteps{gap:5px}#transferSteps button{padding:0 9px;font-size:11px}#transferRoute{gap:8px}#transferSaveActions button{width:100%;min-width:0}}';document.head.append(style);})();
