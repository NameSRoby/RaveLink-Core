// One renderer is embedded into both the designer and the OBS page at build time.
(function(root){
  const sizes={small:10,medium:14,large:19,display:27},artSizes={small:52,medium:80,large:110,display:150};
  const fonts={system:'"Segoe UI","Yu Gothic UI",Meiryo,"Microsoft YaHei UI","Malgun Gothic",Arial,sans-serif',serif:'Georgia,"Yu Mincho",serif',mono:'Consolas,"MS Gothic",monospace',cjk:'"Yu Gothic UI",Meiryo,"Microsoft YaHei UI",sans-serif'};
  const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=String(text);return n};
  const rgba=(hex,opacity)=>'rgba('+[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(',')+','+opacity/100+')';
  const clock=ms=>{const s=Math.max(0,Math.floor(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
  function clockData(n,current){n.dataset.playbackClock='';n.dataset.position=String(current.positionMs||0);n.dataset.duration=String(current.durationMs||0);n.dataset.observed=String(current.observedAt||Date.now());n.dataset.status=current.status||'';return n}
  function update(stage){stage.querySelectorAll('[data-playback-clock]').forEach(n=>{const d=n.dataset,duration=Number(d.duration),base=Number(d.position),position=Math.min(duration||Infinity,base+(d.status==='playing'?Math.max(0,Date.now()-Number(d.observed)):0));if(n.classList.contains('playbackTime'))n.textContent=duration?clock(position)+' / '+clock(duration):'';else n.style.width=duration?Math.min(100,Math.max(0,position/duration*100))+'%':'0%'})}
  function block(raw,item,current,next,config){let n;const kind=raw.kind;
    if(kind==='label')n=node('div','label','NOW PLAYING');
    else if(kind==='title'){n=node('div','titleViewport title');const track=node('div','marqueeTrack');track.append(node('h1','',item.title||'Untitled'));n.append(track)}
    else if(kind==='artists')n=node('p','artists muted',(item.artists||[]).join(', '));
    else if(kind==='album'){if(!item.album)return null;n=node('p','album muted',item.album)}
    else if(kind==='artwork'){n=node('div','artwork');if(item.artworkUrl){const img=node('img');img.src=item.artworkUrl;img.alt='';img.referrerPolicy='no-referrer';n.append(img)}}
    else if(kind==='provider')n=node('div','provider',String(item.provider||current.provider||current.source||'').toUpperCase());
    else if(kind==='meta'||kind==='time'){n=node('div','meta');if(kind==='meta')n.append(node('span','',String(item.provider||current.provider||current.source||'').toUpperCase()));n.append(clockData(node('span','playbackTime'),current))}
    else if(kind==='progress'){n=node('div','bar progress');n.append(clockData(node('span','playbackProgress'),current))}
    else if(kind==='queue'){if(!next.length)return null;n=node('div','queue','NEXT  //  '+next.slice(0,raw.count||3).join('  /  '))}
    else return null;
    n.classList.add('block','pv');n.dataset.blockId=raw.id;
    const s=raw.style||{},target=kind==='title'?n.querySelector('h1'):n;
    if(sizes[s.size]){if(kind==='artwork')n.style.setProperty('--oart',artSizes[s.size]*config.scale/100+'px');else if(kind==='progress')n.style.height=({small:2,medium:4,large:7,display:10})[s.size]+'px';else target.style.fontSize=sizes[s.size]*config.scale/100+'px'}
    if(fonts[s.font])target.style.fontFamily=fonts[s.font];if(s.color){target.style.color=s.color;if(kind==='progress')n.firstElementChild.style.background=s.color}if(s.bold)target.style.fontWeight='800';if(s.italic)target.style.fontStyle='italic';if(s.uppercase)target.style.textTransform='uppercase';
    return n;
  }
  function marquee(stage){if(!stage.classList.contains('title-scroll'))return;stage.querySelectorAll('.titleViewport:not([data-marquee-ready])').forEach(view=>{const track=view.firstElementChild,title=track?.firstElementChild,width=Math.ceil(title?.scrollWidth||0),available=view.clientWidth;if(!available||!width)return;view.dataset.marqueeReady='true';if(width<=available+1)return;const gap=Math.max(28,available*.12),distance=width+gap,copy=title.cloneNode(true);copy.setAttribute('aria-hidden','true');track.append(copy);view.style.setProperty('--marquee-gap',gap+'px');view.style.setProperty('--marquee-distance',distance+'px');view.style.setProperty('--marquee-duration',Math.max(8,distance/32)+'s');view.classList.add('scrolling')})}
  function render(stage,config,current,rows=[],theme={},options={}){
    const c={...config};if(c.followAppColors!==false){for(const [key,source] of Object.entries({accent:'accent',surface:'surface',text:'text',muted:'muted'}))if(/^#[0-9a-f]{6}$/i.test(theme[source]||''))c[key]=theme[source]}
    const vars={owidth:c.width+'px',oheight:c.height+'px',oscale:c.scale/100,ogap:c.gap+'px',obgap:c.blockGap+'px',opad:c.padding+'px',oradius:c.radius+'px',oedge:c.accentWidth+'px',oshadow:c.shadow/100,oaccent:c.accent,osurface:rgba(c.surface,c.opacity),otext:c.text,omuted:c.muted,ofont:fonts[c.font]||fonts.system,oart:(c.artworkSize||110)*c.scale/100+'px',oborder:(c.borderWidth||0)+'px',oborderColor:c.borderColor||c.accent};
    for(const [key,value]of Object.entries(vars))stage.style.setProperty('--'+key,value);
    const idClass=stage.id==='preview'?'preview':'stage';stage.className=idClass+' song-overlay skin-'+(c.skin||'classic')+' '+c.flow+' '+c.anchor+' content-'+c.contentAlign+' edge-'+(c.accentPosition||'left')+' title-'+(c.titleMode||'scroll')+(c.separated?' separated':'')+(c.autoHeight?'':' height-fixed');
    const item=current.candidate||current,next=rows.filter(r=>r.id!==current.entryId).map(r=>r.candidate?.title||r.query);
    stage.replaceChildren(...c.segments.filter(s=>s.enabled).map(s=>{const n=node('section','segment preview-segment '+s.direction+' '+s.size+' align-'+s.align+(s.wrap===false?' no-wrap':''));n.dataset.segmentId=s.id;n.append(...s.blocks.map(b=>block(b,item,current,next,c)).filter(Boolean));const style=s.style||{};if(style.surface||style.opacity!==null&&style.opacity!==undefined)n.style.background=rgba(style.surface||c.surface,style.opacity??c.opacity);if(style.accent)n.style.borderLeftColor=style.accent;for(const [key,prop]of Object.entries({padding:'padding',radius:'borderRadius',accentWidth:'borderLeftWidth'}))if(style[key]!==null&&style[key]!==undefined)n.style[prop]=style[key]+'px';if(style.accentWidth)n.style.borderLeftStyle='solid';return n}).filter(n=>n.childElementCount));
    if(options.animate&&c.motion!=='off')stage.classList.add(c.motion);stage.classList.toggle('hidden',!stage.childElementCount);update(stage);requestAnimationFrame(()=>requestAnimationFrame(()=>marquee(stage)));
  }
  root.SongOverlayRenderer={render,update,marquee,clockData};
})(window);
