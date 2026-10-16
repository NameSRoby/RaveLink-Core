const fs = require('node:fs');
const path = require('node:path');
const { rateLimit } = require('express-rate-limit');
const { isLocalOrSameHostRequest, validateBrowserOrigin } = require('../runtime/request-security.middleware');
const DEFAULT_THEME = Object.freeze({ accent:'#8b001f', bg:'#050507', surface:'#121a2f', text:'#eaeaea', glow:65 });
module.exports = function registerPresentationRoutes(app, { runtimeDir, rateLimitOptions = {} }) {
  const file = path.join(runtimeDir, 'system', 'presentation-theme.json');
  let theme = { ...DEFAULT_THEME }, revision = 0;
  const valid = value => value && ['accent','bg','surface','text'].every(k=>/^#[0-9a-f]{6}$/i.test(value[k]||'')) && Number.isInteger(value.glow) && value.glow>=0 && value.glow<=100;
  const project = value => Object.fromEntries(Object.keys(DEFAULT_THEME).map(k=>[k,value[k]]));
  try { const stored=JSON.parse(fs.readFileSync(file,'utf8'));if(valid(stored.theme)){theme=project(stored.theme);revision=Number.isSafeInteger(stored.revision)&&stored.revision>0?stored.revision:1} } catch {}
  const local = (req,res,next) => isLocalOrSameHostRequest(req) && validateBrowserOrigin(req).ok ? next() : res.status(403).json({ok:false,error:'presentation_loopback_required'});
  app.get('/api/presentation/theme', local, (_req,res)=>{res.setHeader('Cache-Control','no-store');res.json({ok:true,revision,theme})});
  const saveLimit = rateLimit({ windowMs: 60000, limit: 30, keyGenerator: () => 'theme', standardHeaders: 'draft-8', legacyHeaders: false, ...rateLimitOptions, message: { ok:false,error:'presentation_rate_limited' } });
  app.put('/api/presentation/theme', local, saveLimit, (req,res)=>{
    if(!valid(req.body?.theme))return res.status(400).json({ok:false,error:'presentation_theme_invalid'});
    const next=project(req.body.theme);if(JSON.stringify(next)!==JSON.stringify(theme)||!revision){
      try{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify({revision:revision+1,theme:next})+'\n');fs.renameSync(file+'.tmp',file);theme=next;revision++}catch{return res.status(503).json({ok:false,error:'presentation_theme_save_failed'})}
    }
    return res.json({ok:true,revision,theme});
  });
};
