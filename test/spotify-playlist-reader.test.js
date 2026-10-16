const test = require('node:test'), assert = require('node:assert/strict');
const reader = require('../integrations/spotify-desktop/playlist-reader.cjs');
const createFacade = require('../integrations/spotify-desktop/native-facade.cjs');
const ID = 'A'.repeat(22), URI = 'spotify:playlist:' + ID, TRACK = 'spotify:track:' + 'B'.repeat(22);
test('native Spotify playlist reads preserve repeats, metadata and unavailable positions without playback methods', async () => {
  const calls = [], api = { getPlaylist: async (id, options, page) => { calls.push({id,page});return { metadata:{isLoaded:true,name:'Source',totalLength:27},contents:{items:Array.from({length:page.offset ? 2 : 25},(_,i)=>i===1?null:{uri:TRACK,name:'Song',artists:[{name:'Artist'}],album:{name:'Album'},duration:{milliseconds:180000}})} }; } };
  const facade = createFacade({PlaylistAPI:api,RootlistAPI:{getContents:async()=>({items:[{uri:URI,name:'Source'},{type:'folder',items:[{uri:URI,name:'Duplicate reference'}]}]})}});
  const first = await facade.readPlaylist(reader.normalize({action:'read',id:'https://open.spotify.com/playlist/'+ID+'?si=tracking'}));
  assert.equal(first.tracks.length,25);assert.equal(first.cursor,'25');assert.equal(first.tracks[1],null);assert.equal(first.tracks[0].album,'Album');assert.equal(first.tracks[0].artists[0],'Artist');
  assert.equal(first.tracks[0].providerItemId,first.tracks[2].providerItemId);
  assert.equal((await facade.readPlaylist({action:'read',id:URI,offset:25})).cursor,'');assert.deepEqual(calls[0].page,{offset:0,limit:25});
  assert.deepEqual((await facade.readPlaylist({action:'list',offset:0})).playlists,[{id:URI,name:'Source'}]);
  assert.equal((await reader.read(()=>null,{action:'read',id:URI,offset:0})).error,'spotify_playlist_unavailable');
});
test('Spotify playlist commands reject foreign URLs, malformed writes and malformed pages', () => {
  for(const id of ['https://evil.example/playlist/'+ID,'https://user:secret@open.spotify.com/playlist/'+ID,'https://open.spotify.com:444/playlist/'+ID,'spotify:track:'+ID])assert.equal(reader.normalize({action:'read',id}),null);
  assert.equal(reader.normalize({action:'append',id:URI}),null);assert.equal(reader.normalize({action:'read',id:URI,offset:-1}),null);
  assert.equal(reader.result({ok:true,total:10,tracks:[]},{action:'read',offset:0}),null);
  assert.equal(reader.result({ok:true,playlists:[],cursor:'https://evil.example'},{action:'list',offset:0}),null);
});

test('Spotify community writes expose only bounded native create and append operations',async()=>{
  const calls=[];
  const service=name=>name==='RootlistAPI'?{createPlaylist:async(name,position)=>{calls.push([name,position]);return URI}}:{add:async(...args)=>calls.push(args)};
  assert.deepEqual(await reader.read(service,reader.normalize({action:'create',name:'Community'})),{ok:true,id:URI});
  assert.deepEqual(await reader.read(service,reader.normalize({action:'append',id:URI,ids:[TRACK]})),{ok:true});
  assert.deepEqual(calls[1],[URI,[TRACK],{after:'end'}]);
  assert.equal(reader.normalize({action:'append',id:URI,ids:Array(26).fill(TRACK)}),null);
  assert.equal(reader.normalize({action:'create',name:''}),null);
});
