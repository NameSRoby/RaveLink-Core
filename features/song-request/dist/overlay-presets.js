const { DEFAULT_OVERLAY, overlayFrom } = require('./overlay-config');
const section=(id,kinds,extra={})=>({id,enabled:true,direction:'column',align:'left',size:'wide',...extra,blocks:kinds.map(kind=>({id:id+'-'+kind,kind,...(kind==='queue'?{count:3}:{})}))});
const entries=[
 ['classic','Classic','The original compact now-playing card.',{}],
 ['album-card','Album card','A frosted album sleeve with a generous cover and quiet typography.',{skin:'glass',width:540,radius:22,padding:18,gap:18,accentWidth:0,opacity:65,artworkSize:120,flow:'row',segments:[section('cover',['artwork'],{size:'compact'}),section('track',['label','title','artists','progress','meta'])]}],
 ['minimal','Minimal','An understated type-led overlay with a fine progress line.',{skin:'minimal',width:440,font:'mono',titleMode:'ellipsis',opacity:0,accentWidth:0,shadow:35,segments:[section('track',['label','title','artists','progress'])]}],
 ['split-panels','Split panels','Separate compact track and timing cards, side by side.',{skin:'duo',width:360,flow:'grid',separated:true,radius:6,padding:10,gap:6,blockGap:3,accentWidth:0,opacity:88,segments:[section('track',['title','artists']),section('timing',['provider','time','progress'])]}],
 ['ribbon','Compact strip','A slim cover, song and progress strip for tight scenes.',{skin:'glass',width:460,flow:'row',radius:8,padding:10,gap:10,accentWidth:0,artworkSize:48,blockGap:3,segments:[section('cover',['artwork'],{size:'compact'}),section('track',['title','artists','progress'])]}],
 ['broadcast','Provider badge','A small provider-colored card. The accent follows the service.',{skin:'classic',width:300,providerColors:true,accentPosition:'top',accentWidth:3,padding:10,radius:6,blockGap:3,segments:[section('track',['provider','title','artists','progress'])]}],
 ['spotlight','Cover chip','A small cover beside the song, artist and playback time.',{skin:'classic',width:320,flow:'row',artworkSize:56,radius:6,padding:10,gap:10,accentWidth:2,blockGap:3,segments:[section('cover',['artwork'],{size:'compact'}),section('track',['title','artists','time'])]}],
 ['two-column','Track + next','A compact song card with a separate upcoming-track strip.',{skin:'classic',width:360,flow:'column',separated:true,radius:6,padding:10,gap:5,accentWidth:2,blockGap:3,segments:[section('track',['title','artists','progress']),section('next',['queue'],{size:'full'})]}]
];
const presets=entries.map(([id,name,description,extra])=>({id,name,description,config:overlayFrom({...DEFAULT_OVERLAY,...extra,preset:id})}));
module.exports={list:()=>presets.map(({id,name,description})=>({id,name,description})),get:id=>presets.find(p=>p.id===id)?.config};
