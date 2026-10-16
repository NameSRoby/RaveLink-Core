const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..','features','song-request','ui');
let failed=false;
for(const page of ['overlay-editor.html','obs-overlay.html']){
 const file=path.join(root,page);let content=fs.readFileSync(file,'utf8');
 for(const [kind,source]of [['style','overlay-renderer.css'],['script','overlay-renderer.js']]){
  const marker='SONG_OVERLAY_'+kind.toUpperCase(),block='<!-- '+marker+'_START -->\n<'+kind+'>\n'+fs.readFileSync(path.join(root,source),'utf8').trim()+'\n</'+kind+'>\n<!-- '+marker+'_END -->';
  const re=new RegExp('<!-- '+marker+'_START -->[\\s\\S]*?<!-- '+marker+'_END -->');
  content=content.replace(re,block);
 }
 if(page==='overlay-editor.html')for(const [kind,source]of [['style','designer.css'],['script','designer-controls.js']]){
  const marker='SONG_DESIGNER_'+kind.toUpperCase(),block='<!-- '+marker+'_START -->\n<'+kind+'>\n'+fs.readFileSync(path.join(root,source),'utf8').trim()+'\n</'+kind+'>\n<!-- '+marker+'_END -->';
  content=content.replace(new RegExp('<!-- '+marker+'_START -->[\\s\\S]*?<!-- '+marker+'_END -->'),block);
 }
 if(process.argv.includes('--check')){if(content!==fs.readFileSync(file,'utf8')){console.error(page+': shared renderer is stale');failed=true}}
 else fs.writeFileSync(file,content);
}
if(failed)process.exitCode=1;
