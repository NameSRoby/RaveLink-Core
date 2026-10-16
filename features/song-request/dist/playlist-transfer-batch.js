const { text, normalizeTrack } = require('./portable-track');
module.exports = ({ library, sources, limit }) => ({
  async prepare(input) {
    if (!['library','spotify','tidal'].includes(input.sourceKind) || !Array.isArray(input.playlists) || !input.playlists.length || input.playlists.length > 100) throw Error('transfer_sources_invalid');
    const seen = new Set(), queue = input.playlists.map(row => {
      const id = text(row.id,160);
      if (!id || seen.has(id)) throw Error('transfer_sources_invalid');seen.add(id);
      return { id, name: text(row.name,80) };
    });
    if (input.sourceKind === 'library') {
      const rows = [];
      for (const entry of queue) {
        const collection = library.get(entry.id);if (!collection) throw Error('playlist_not_found');entry.name = collection.name;
        if (rows.length + collection.tracks.length > limit()) throw Error('playlist_track_limit');
        rows.push(...collection.tracks.map(track => ({ track:structuredClone(track),choices:[],selected:null,include:true,error:'',sourcePlaylist:{...entry} })));
      }
      return { rows, kind:'local', queue };
    }
    // Validate every reference before replacing the current review. Only the
    // first source is opened here; remaining sources are read by the worker.
    for (const entry of queue) {
      if (input.sourceKind === 'spotify') entry.id = sources.spotifyId(entry.id);
      else if (!/^[A-Za-z0-9_-]{1,160}$/.test(entry.id)) throw Error('tidal_playlist_invalid');
    }
    if (new Set(queue.map(row=>row.id)).size !== queue.length) throw Error('transfer_sources_invalid');
    const first = await sources.begin({action:'read_'+input.sourceKind,id:queue[0].id,name:queue[0].name},limit());
    queue[0].name = first.name;
    return { rows:[], kind:input.sourceKind, queue, first };
  },
  async advance(job) {
    if (!job.sourcePlaylists || job.sourceIndex + 1 >= job.sourcePlaylists.length) { job.state = 'review';return; }
    // Persist the next index before opening it so a failed lookup can resume
    // without appending the previous playlist's last page twice.
    job.sourceIndex++;job.sourcePending = true;job.cursor = '';
  },
  async open(job) {
    const entry = job.sourcePlaylists[job.sourceIndex];
    const {name,kind,...source} = await sources.begin({action:'read_'+job.sourceKind,id:entry.id,name:entry.name},limit());
    entry.name = name;Object.assign(job,source,{sourcePending:false});
  },
  async read({job,rows,store,save}) {
    if(job.sourcePending){await this.open(job);await save();return;}
    const reply=await sources.read(job);if(!reply)return;
    if(rows.length+reply.tracks.length>limit()||job.pages>=1000)throw Error('playlist_track_limit');
    const before=rows.length;
    rows.push(...reply.tracks.map(track=>({track:normalizeTrack(track),error:track?'':'Unavailable or non-track playlist item',choices:[],selected:null,include:Boolean(track),...(job.sourcePlaylists?{sourcePlaylist:{...job.sourcePlaylists[job.sourceIndex]}}:{})})));
    job.count=rows.length;job.cursor=reply.cursor;job.pages++;job.processed=rows.length;
    for(let index=Math.floor(before/5)*5;index<rows.length;index+=5)await store.page(job,rows,index);
    if(!reply.cursor)await this.advance(job);await save();
  }
});
