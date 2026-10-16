const { youtubeVideoId } = require('../../../shared/media/youtube-reference');
const { classifySongInput, resolveSpotifySongInput } = require('./spotify-link-resolver');

const clean = value => String(value || '').replace(/<[^>]*>/g,' ').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/\s+/g,' ').trim().slice(0,300);
function classify(value) {
  const query=String(value||'').trim();
  if(!/https?:\/\/|\bwww\.|^spotify:/i.test(query))return {ok:true,source:'text',query};
  if(/^spotify:track:[a-zA-Z0-9]{22}$/.test(query))return {ok:true,source:'spotify',id:query.slice(14),query:'https://open.spotify.com/track/'+query.slice(14)};
  let url;try{url=new URL(query);}catch{return {ok:false,reason:'catalog_untrusted_link'};}
  if(url.protocol!=='https:'||url.username||url.password||url.port)return {ok:false,reason:'catalog_untrusted_link'};
  const youtube=youtubeVideoId(query);
  if(youtube)return {ok:true,source:'youtube',id:youtube,query:'https://www.youtube.com/watch?v='+youtube};
  if(['open.spotify.com','spotify.link'].includes(url.hostname)){
    const parsed=classifySongInput(query);return parsed.ok?{ok:true,source:'spotify',id:parsed.trackId,query:parsed.url}:{ok:false,reason:parsed.reason};
  }
  if(['tidal.com','www.tidal.com','listen.tidal.com'].includes(url.hostname)){
    const id=/^\/(?:browse\/)?track\/([1-9][0-9]{0,19})\/?$/.exec(url.pathname)?.[1];
    return id?{ok:true,source:'tidal',id,query:'https://tidal.com/track/'+id}:{ok:false,reason:'song_link_track_required'};
  }
  // Preserve the existing direct SoundCloud track resolver.
  if(['soundcloud.com','www.soundcloud.com','m.soundcloud.com'].includes(url.hostname))return {ok:true,source:'soundcloud',query};
  return {ok:false,reason:'catalog_untrusted_link'};
}

module.exports = function createSongLinkInput(options={}) {
  const fetchImpl=options.fetchImpl||fetch,cache=new Map(),pending=new Map();
  async function read(url,json=false){
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(4000),redirect:'error',credentials:'omit',headers:{accept:json?'application/json':'text/html'}});
    if(!response.ok)throw Error('song_link_metadata_unavailable');
    if(Number(response.headers?.get?.('content-length')||0)>1048576)throw Error('song_link_metadata_unavailable');
    if(!response.body?.getReader){const text=await response.text();if(Buffer.byteLength(text)>1048576)throw Error('song_link_metadata_unavailable');return json?JSON.parse(text):text;}
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw Error('song_link_metadata_unavailable');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
    const text=Buffer.concat(chunks).toString('utf8');return json?JSON.parse(text):text;
  }
  async function metadata(link){
    if(link.source==='youtube'){
      const body=await read('https://www.youtube.com/oembed?format=json&url='+encodeURIComponent(link.query),true);
      return clean([body.author_name,body.title].filter(Boolean).join(' '));
    }
    if(link.source==='spotify'){
      if(!link.id){const resolved=await resolveSpotifySongInput(link.query,fetchImpl,AbortSignal.timeout(4000));if(!resolved.ok)throw Error(resolved.reason);link={...link,id:resolved.trackId};}
      try{
        const html=await read('https://open.spotify.com/embed/track/'+link.id);
        const raw=/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
        const entity=JSON.parse(raw).props?.pageProps?.state?.data?.entity;
        const title=clean(entity?.title||entity?.name),artists=(entity?.artists||[]).map(row=>clean(row.name)).filter(Boolean);
        if(title&&artists.length)return clean([...artists,title].join(' '));
      }catch{}
      const resolved=await resolveSpotifySongInput('https://open.spotify.com/track/'+link.id,fetchImpl,AbortSignal.timeout(4000));
      if(!resolved.ok)throw Error(resolved.reason);return clean(resolved.query);
    }
    if(link.source==='tidal'){
      if(options.tidalMetadata){try{const result=await options.tidalMetadata(link.id);if(result?.ok&&result.candidate?.title)return clean([...(result.candidate.artists||[]),result.candidate.title].join(' '));}catch{}}
      const html=await read(link.query);
      for(const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
        try{const raw=JSON.parse(match[1]),rows=Array.isArray(raw)?raw:raw['@graph']||[raw];const song=rows.find(row=>row['@type']==='MusicRecording');if(song?.name){const artist=song.byArtist;return clean([...(Array.isArray(artist)?artist:[artist]).map(row=>row?.name).filter(Boolean),song.name].join(' '));}}catch{}
      }
      const title=/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
      const match=/^(.+?)\s+by\s+(.+?)\s+on\s+TIDAL\s*$/i.exec(clean(title));
      if(match)return clean(match[2]+' '+match[1]);
    }
    throw Error('song_link_metadata_unavailable');
  }
  async function normalize(query,target){
    let link=classify(query);if(!link.ok)return link;
    if(link.source==='spotify'&&target==='spotify'&&!link.id){
      const resolved=await resolveSpotifySongInput(link.query,fetchImpl,AbortSignal.timeout(4000));
      if(!resolved.ok)return {ok:false,reason:resolved.reason};
      link={...link,id:resolved.trackId,query:'https://open.spotify.com/track/'+resolved.trackId};
    }
    if(link.source==='text'||link.source===target)return {...link,translated:false};
    if(link.source==='soundcloud')return {ok:false,reason:'catalog_untrusted_link'};
    const old=cache.get(link.query);if(old&&old.until>Date.now())return {ok:true,query:old.query,translated:true};
    if(!pending.has(link.query)){
      if(pending.size>=8)return {ok:false,reason:'song_link_metadata_unavailable'};
      const work=metadata(link).then(query=>{if(!query)throw Error();if(cache.size>=128)cache.delete(cache.keys().next().value);cache.set(link.query,{query,until:Date.now()+300000});return {ok:true,query,translated:true};}).catch(()=>({ok:false,reason:'song_link_metadata_unavailable'})).finally(()=>pending.delete(link.query));pending.set(link.query,work);
    }
    return pending.get(link.query);
  }
  return {normalize};
};
module.exports.classify=classify;
