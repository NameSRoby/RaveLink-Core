function track(id, title = 'Query Song', artist = 'Fixture Artist', extra = {}) {
  return {id,kind:'track',title,user_id:123,sharing:'public',state:'finished',streamable:true,policy:'ALLOW',embeddable_by:'all',duration:180000,full_duration:180000,
    permalink_url:'https://soundcloud.com/fixture/track-'+id,publisher_metadata:{artist,album_title:'Fixture album'},...extra};
}
function html(query, tracks) {
  const entities = { tracks:Object.fromEntries(tracks.map(data=>['soundcloud:tracks:'+data.id,{data}])), users:{'soundcloud:users:123':{data:{username:'Fixture Artist',verified:true}}},
    searchResultsCollections:{['sounds:'+query]:{data:{collection:tracks.map(t=>({schema:'track',id:'soundcloud:tracks:'+t.id}))}}} };
  return '<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{initialStoreState:{entities}}}})+'</script>';
}
module.exports = {track,html};
