window.createSharedThemeSaver=function(onFailure){
let themeSaveTimer, themeSavePending = null, themeSaving = false;
function saveSharedTheme(value) {
  themeSavePending = value; clearTimeout(themeSaveTimer);
  themeSaveTimer = setTimeout(flushSharedTheme, 250);
}
async function flushSharedTheme() {
  if (themeSaving || !themeSavePending) return;
  const theme = themeSavePending; themeSavePending = null; themeSaving = true;
  try { const response = await fetch('/api/presentation/theme', { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({theme}) }); if (!response.ok) throw new Error('theme_save_failed'); }
  catch { onFailure(); }
  finally { themeSaving = false; if(themeSavePending)void flushSharedTheme(); }
}

return saveSharedTheme;
};
