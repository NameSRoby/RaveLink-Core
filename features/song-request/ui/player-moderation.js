function moderationControls(title, groups) {
  const toolbar = document.createElement('div'); toolbar.className = 'quickModeration'; toolbar.setAttribute('aria-label', title);
  for (const group of groups) {
    const section = document.createElement('section'); section.className = 'moderationGroup'; section.dataset.target = group.title === 'Song' ? 'song' : 'requester';
    section.setAttribute('aria-label', group.title + ' moderation' + (group.description ? ': ' + group.description : ''));
    const heading = document.createElement('h3'); heading.textContent = group.title === 'Requester' ? 'User' : group.title; heading.title = group.description || ''; section.append(heading);
    const nodes = group.controls.flatMap(node => node.matches?.('.rowActions') ? [...node.childNodes] : [node]);
    for (const node of nodes) {
      if (node.tagName === 'SELECT') for (const option of node.options) option.textContent = ({1:'1m',5:'5m',10:'10m',30:'30m',60:'1h',1440:'24h'})[option.value] || option.textContent;
      if (node.tagName === 'BUTTON') {
        const original = node.textContent.trim();
        node.setAttribute('aria-label', original === 'BAN' || original === 'UNBAN' || original === 'TIMEOUT' ? original + ' REQUESTER' : original);
        node.textContent = original.includes('UNBAN') ? 'Unban' : original.includes('BAN') ? 'Ban' : original === 'END TIMEOUT' ? 'End timeout' : original.includes('TIMEOUT') ? 'Timeout' : original;
        node.dataset.moderationAction = /BAN/.test(original) ? 'ban' : 'timeout';
      }
    }
    const controls = document.createElement('div'); controls.className = 'moderationActions';
    controls.append(...nodes.filter(node=>node.dataset?.moderationAction==='ban'), ...nodes.filter(node=>node.tagName==='SELECT'), ...nodes.filter(node=>node.tagName!=='SELECT'&&node.dataset?.moderationAction!=='ban'));
    section.append(controls); toolbar.append(section);
  }
  return toolbar;
}
function createTrackModeration(item, moderate) {
  const minutes = songDuration(item.id || item.candidate.providerItemId), provider = item.candidate.provider;
  const groups = [{ title: 'Song', description: item.candidate.title, controls: [minutes,
    actionButton('TIMEOUT SONG', 'Temporarily block this recording and remove it from playback', () => moderate({ action: 'timeout_song', provider, providerItemId: item.candidate.providerItemId, minutes: Number(minutes.value) }, 'Song timed out.')),
    actionButton('BAN SONG', 'Ban this recording and remove it from playback', () => moderate({ action: 'block_song', provider, providerItemId: item.candidate.providerItemId }, 'Song banned.'), true)] }];
  if (item.requesterKey) groups.push({ title: 'Requester', description: item.requesterLabel || 'Requester', controls: [requesterActions({ requesterKey: item.requesterKey, displayName: item.requesterLabel || 'Requester' }, true)] });
  const toolbar = moderationControls(item.requesterKey ? 'Song and requester moderation' : 'Song moderation', groups);
  if (item.requesterKey) toolbar.dataset.requester = item.requesterLabel || 'Requester';
  return toolbar;
}
function compactQueueModeration(body, rows, moderate) {
  [...body.rows].forEach((row, index) => { const item = rows[index]; if (!item) return;
    const remove = row.cells[3].querySelector('button'), controls = document.createElement('div'); controls.className = 'rowActions';
    if (remove) controls.append(remove); controls.append(createTrackModeration(item, moderate)); row.cells[3].replaceChildren(controls);
  });
}
(() => {
  const requesterTable = $('requesters').closest('table');
  requesterTable.querySelector('thead .hideSmall')?.remove();
  const requesterColumns = document.createElement('style');
  requesterColumns.textContent = 'table:has(#requesters) th:last-child{width:230px}'; document.head.append(requesterColumns);
  const originalRequesters = renderRequesters;
  renderRequesters = function (state) {
    const body = $('requesters'), rows = state.moderation?.recentRequesters || [];
    if (body.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    const signature = JSON.stringify(rows.map(row => [row.requesterKey, row.displayName, row.role, row.pending, row.blocked, row.timedOutUntil > Date.now()]));
    if (body.dataset.moderationSignature === signature) return;
    originalRequesters(state); body.dataset.moderationSignature = signature;
  };
  const style = document.createElement('style');
  style.textContent = '.quickModeration{display:grid!important;gap:5px!important;max-width:100%;text-align:left}.moderationGroup{display:flex;align-items:center;gap:6px;min-width:0}.moderationGroup h3{width:34px;flex:none;font-size:10px;margin:0;color:var(--muted);font-weight:700}.moderationActions{display:flex!important;align-items:center;justify-content:flex-start!important;gap:4px;flex-wrap:wrap}.moderationActions select{width:64px!important;min-width:64px!important;max-width:64px;min-height:28px;height:28px;padding:3px 4px;font-size:11px}.moderationActions button{min-height:28px!important;height:28px;padding:3px 7px!important;font-size:10px!important;white-space:nowrap}.moderationActions [data-moderation-action=ban]{min-width:42px;color:var(--bad,#ff929b)}table:has(#queue) th:last-child,.tidal-mode table:has(#queue) th:last-child{width:300px}#queue td.rowActions>.rowActions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:nowrap}#queue td.rowActions>div>.quickModeration{flex:none}#soundcloudCurrentActions .quickModeration[data-requester]::before{content:"Requested by " attr(data-requester);font-size:11px;color:var(--muted);margin:3px 0}.tidalNowControls .currentSongActions{display:block}@media(max-width:620px){table:has(#queue) thead{display:none}body #queue tr:not(:has(.empty)),body.tidal-mode #queue tr:not(:has(.empty)){display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:4px 8px;padding:8px 0;border-bottom:1px solid var(--edge)}body #queue td,body.tidal-mode #queue td{display:block;border:0;padding:4px 0;min-width:0}body #queue td:nth-child(3){display:none}body.tidal-mode #queue td:nth-child(3){display:block;grid-column:1/-1}body #queue td.rowActions,body.tidal-mode #queue td.rowActions{display:block;grid-column:1/-1}#queue td.rowActions>.rowActions{justify-content:flex-start!important}.quickModeration{gap:4px!important}}';
  document.head.append(style);
})();
