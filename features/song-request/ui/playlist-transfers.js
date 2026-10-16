(() => {
  const style = document.createElement('style'); style.textContent = '#transfersView [hidden]{display:none!important}#transfersView table{table-layout:fixed}#transfersView td{overflow-wrap:anywhere}#transfersView td select{width:100%;min-width:0}#transfersView label{max-width:100%}#columnMapping label{width:180px}#transfersView input[type=file]{width:280px;max-width:100%}#transfersView select{max-width:100%}#destinationHelp{flex-basis:100%;margin:4px 0;line-height:1.5}#exportsFolder,#exportFiles{overflow-wrap:anywhere}#transferNotice{margin:14px 0;line-height:1.5}'; document.head.append(style);
  const nav = document.createElement('nav'); nav.className = 'band';
  nav.innerHTML = '<button id="libraryTab" class="primary">Library</button><button id="transfersTab">Transfers</button>';
  const main = document.querySelector('main'), libraryView = document.createElement('section'); libraryView.id = 'libraryView';
  libraryView.append(...main.childNodes); main.append(nav, libraryView);
  const panel = document.createElement('section'); panel.hidden = true; panel.id = 'transfersView'; main.append(panel);
  panel.innerHTML = `<h2>Playlist transfers</h2><details><summary>Library capacity</summary><div class="band"><label>Songs per playlist / transfer<input id="trackCapacity" type="number" min="5000" max="10000" step="500" value="5000"></label><button id="saveTrackCapacity">Save capacity</button></div><p>Default 5,000; adjustable up to 10,000. The feature storage quota and service limits still apply.</p></details><p>Import, export or match playlists. Your current playback stays untouched.</p>
    <div class="band"><label>Source<select id="transferSource"><option value="csv">CSV file</option><option value="library">Saved RaveLink playlist</option><option value="tidal">TIDAL account playlist</option><option value="spotify">Spotify account playlist</option><option value="url">Playlist URL</option></select></label>
    <label>Playlist name<input id="transferName" maxlength="80" placeholder="Imported playlist"></label></div>
    <section id="csvSource"><div class="band"><label>CSV file<input type="file" id="transferFile" accept=".csv,.tsv,text/csv,text/tab-separated-values"></label><label>Delimiter<select id="csvDelimiter"><option value=",">Comma</option><option value=";">Semicolon</option><option value="tab">Tab</option></select></label><button id="readCsv">Read file</button></div>
    <p><span id="csvLimit">Up to 8 MiB and 5,000 rows.</span> Repeated tracks keep their original order.</p><div id="columnMapping" class="band" hidden></div><button id="previewCsv" hidden>Preview import</button></section>
    <section id="librarySource" hidden><div class="band"><label>Saved playlist<select id="transferCollection"></select></label><button id="useCollection">Review playlist</button><button id="exportCollection">Export CSV</button></div></section>
    <section id="tidalSource" hidden><div class="band"><button id="listTidal">Load account playlists</button><label>Account playlist<select id="tidalPlaylist"></select></label><button id="moreTidal" hidden>Load more from TIDAL</button></div><div class="band"><button id="readTidal" hidden>Read selected playlist</button></div></section>
    <section id="spotifySource" hidden><p>Read playlists from your signed-in Spotify desktop companion. Playback does not need to be running.</p><div class="band"><button id="listSpotify">Load Spotify playlists</button><label>Spotify playlist<select id="spotifyPlaylist"></select></label><button id="moreSpotify" hidden>Load more Spotify playlists</button><button id="readSpotify">Read selected playlist</button></div><p id="spotifySourceStatus" role="status">Open Spotify with RaveLink from Player / Setup first.</p></section>
    <section id="urlSource" hidden><p>Paste a YouTube, SoundCloud, TIDAL or Spotify playlist link. Load it here, then choose its destination.</p></section>
    <details><summary>TIDAL account connection</summary><p id="transferAccount">Checking connection…</p><button id="connectPlaylistAccount">Connect TIDAL playlist access</button><button id="checkPlaylistAccount">Check connection</button><a id="transferSignInLink" target="_blank" rel="noopener noreferrer" hidden>Open TIDAL sign-in</a><p>Transfer sign-in requests playlist and collection read/write access. Liked-song transfer controls are planned. New TIDAL playlists are unlisted and accessible by link.</p></details>
    <details id="csvExports"><summary>Saved CSV exports</summary><p id="exportsFolder"></p><button id="openExports">Open exports folder</button><button id="refreshExports">Refresh files</button><ul id="exportFiles"></ul><p>CSV copies are saved here before downloading. Your browser chooses the download folder; enable Ask where to save each file in its download settings to choose a different destination each time.</p></details><p id="transferNotice" class="notice" role="status"></p>
    <section id="transferReview" hidden><h3 id="transferSummary"></h3><p id="transferProgress"></p>
    <div class="band"><button id="saveLocal">Save as new local playlist</button></div><h3>Match to another service</h3><div class="band"><label>Destination<select id="transferTarget"><option value="tidal">TIDAL</option><option value="spotify">Spotify</option><option value="youtube">YouTube (local playlist)</option><option value="soundcloud">SoundCloud (local playlist)</option></select></label><button id="matchTidal">Find TIDAL matches</button><button id="saveMatched">Save matched local playlists</button><p id="destinationHelp">TIDAL and Spotify can create account playlists. Spotify requires the RaveLink desktop companion. YouTube and SoundCloud save matched tracks in your RaveLink library.</p><button id="acceptMatches">Select strong matches (95%+)</button><label>Destination organization<select id="transferGrouping"><option value="single">One playlist</option><option value="playlist">Keep source playlists separate</option><option value="size">Split by song count</option><option value="artist">By primary artist</option><option value="album">By artist and album</option><option value="genre">By primary genre</option></select></label><label id="splitSizeLabel" hidden>Songs per part<input id="transferSplitSize" type="number" min="1" max="10000" value="500"></label><button id="previewTransferPlan">Preview destination playlists</button><button id="writeTidal" class="primary">Create unlisted TIDAL playlist</button><div id="destinationPlan" class="notice"></div><div id="completedDestinations"></div></div>
    <div class="band"><button id="pauseTransfer">Pause</button><button id="resumeTransfer">Resume</button><button id="cancelTransfer">Cancel</button><label id="spotifyDestinationRecovery" hidden>Created Spotify playlist link<input id="spotifyRecoveryUrl" type="url" placeholder="Paste the playlist link to check its tracks"></label><button id="reconcileTransfer">Check uncertain delivery</button><button id="exportTransferReport">Export transfer report (CSV)</button><a id="destinationLink" target="_blank" rel="noopener" hidden>Open created TIDAL playlist</a></div>
    <table><thead><tr><th>Source track</th><th>Review / destination match</th></tr></thead><tbody id="transferRows"></tbody></table>
    <div class="pager"><button id="transferPrevious">Previous</button><span id="transferPage"></span><button id="transferNext">Next</button></div></section>`;
  const librarySidebar = libraryView.firstElementChild, libraryDetails = document.createElement('section'); librarySidebar.classList.add('librarySidebar'); libraryDetails.className = 'libraryDetails'; for (const node of [...libraryView.childNodes]) if (node !== librarySidebar) libraryDetails.append(node); libraryView.append(libraryDetails);
  $('urlSource').append($('importUrl').closest('.band'));
  const playlistBrowsers = {};
  for (const [id, label] of [['collections', 'server playlists'], ['transferCollection', 'saved playlists'], ['tidalPlaylist', 'TIDAL playlists'], ['spotifyPlaylist', 'Spotify playlists']]) playlistBrowsers[id]=window.installPlaylistBrowser($(id), label, {multiple:id!=='collections'});
  for(const [id,button] of [['transferCollection','useCollection'],['tidalPlaylist','readTidal'],['spotifyPlaylist','readSpotify']])$(id).addEventListener('change',()=>{const count=playlistBrowsers[id].selected().length;$(button).textContent=id==='transferCollection'?(count>1?'Review '+count+' playlists':'Review playlist'):(count>1?'Read '+count+' selected playlists':'Read selected playlist');});
  const workspace = window.installPlaylistWorkspace({ panel, libraryView, reviewSource:()=>perform('review_source'), dismissTransfer: async () => { if (await perform('dismiss')) { message('');$('importUrl').value='';$('importName').value='';$('importState').textContent='Choose a playlist link to start a new transfer.';$('playlistLinkProvider').replaceChildren();$('transferSource').selectedIndex=-1;workspace.show(1); } }, startTransfer: async () => { await $('transfersTab').onclick(); $('transferSource').value = 'library'; $('transferSource').onchange(); playlistBrowsers.transferCollection.select([$('collections').value]); $('useCollection').onclick(); } });
  window.playlistWorkspace = workspace;
  window.installCommunityPlaylists(libraryView);
  let renderedRows = '';
  let state = null, pageOffset = 0, poll = null, visible = false, loading = false, nextCursor = '', loadedPlaylists = [];
  const matchingControls = window.installPlaylistMatchReview({ refresh: () => { pageOffset = 0; void refreshTransfer(); }, accept: threshold => void perform('accept_matches', { threshold }) });
  const transfer = payload => call('song.playlist.transfer.v1', 'action', payload);
  const message = (value, bad = false) => { $('transferNotice').textContent = value; $('transferNotice').classList.toggle('bad', bad); };
  const errors = { transfer_sources_invalid: 'Select between 1 and 100 distinct playlists.', playlist_track_limit: 'These playlists exceed this transfer capacity. Select fewer playlists or increase capacity under library settings.', spotify_playlist_destination_required: 'Spotify may already have created the playlist. Paste its link above and check delivery before resuming.', spotify_playlist_reconcile_required: 'The Spotify playlist differs from the expected tracks. Check it in Spotify; nothing will be resent automatically.', spotify_playlist_write_uncertain: 'Spotify did not confirm this write. Check uncertain delivery before resuming.', spotify_delivery_unconfirmed: 'Spotify did not confirm delivery. Check the destination before resuming.', spotify_playlist_invalid: 'Select a Spotify playlist, or paste its playlist link under Playlist URL.', spotify_playlist_changed: 'This Spotify playlist changed while loading. Load it again to read a consistent source.', spotify_playlist_unavailable: 'Prepare the updated Spotify companion in Player / Setup, then fully quit Spotify and open it with RaveLink.', spotify_playlist_read_failed: 'Spotify could not read this playlist. Check the link and account access, then try again.', spotify_companion_unavailable: 'Open Spotify with RaveLink in Player / Setup, then try again.', exports_folder_full: 'The exports folder is full. Open it and move or remove older CSV files, then export again.', export_file_limit: 'This CSV exceeds the 8 MiB export limit. Split the playlist into smaller parts.', playlist_collection_limit: 'There is not enough room for these destination playlists. Use fewer groups or remove unused local playlists.', transfer_review_required: 'Find destination matches and select the tracks to save first.', csv_title_column_required: 'Map a title column before previewing.', csv_quotes_invalid: 'The CSV has an unclosed or misplaced quote.', csv_file_limit: 'Choose a UTF-8 CSV file no larger than 8 MiB.', csv_row_limit: 'This file exceeds the supported track limit.', csv_field_limit: 'A CSV field or row has too many columns or characters.', tidal_playlist_sign_in_required: 'Connect TIDAL playlist access, then try again.', transfer_busy: 'An operation is still running. Wait for it to finish or pause the job.', transfer_changed: 'The transfer changed. Refresh this view.', tidal_playlist_create_review_required: 'The destination could not be identified safely. Check your TIDAL account before starting another transfer.', tidal_playlist_reconcile_required: 'The destination differs from the expected tracks. Check it in TIDAL; nothing will be resent automatically.' };
  async function execute(action, extra = {}) {
    const reply = await transfer({ action, ...(state?.job ? { jobId: state.job.id } : {}), ...extra });
    if (!reply.ok) throw new Error(errors[reply.code || reply.error] || reply.code || reply.error || 'Transfer failed');
    return reply;
  }
  let actionBusy = false;
  async function perform(action, extra = {}) { if (actionBusy) return; actionBusy = true; panel.inert = true; try { const reply = await execute(action, extra); if (reply.job) { render(reply); if (matchingControls.options().review !== 'all') await refreshTransfer(); } else await refreshTransfer(); message(({ source_batch: 'Selected playlists loaded. Choose a destination and whether to keep them separate or merge them.', review_source: 'Source ready. Choose another destination or transfer these playlists again.', match: 'Matching started. Progress is shown above.', source_library: 'Playlist loaded. Choose a destination below.', preview_csv: 'CSV import ready for review.', save_local: 'Playlist saved in Library.', save_matched: 'Matched playlists saved in Library.', accept_matches: 'Strong matches selected. Review the remaining tracks before saving.', choose: 'Track selection updated.', pause: 'Transfer paused. Progress is saved.', resume: 'Transfer resumed.', cancel: 'Transfer canceled.', reconcile: 'Destination checked. Review its current state before continuing.', write_spotify: 'Spotify transfer started. Progress is shown above.', write_tidal: 'TIDAL transfer started. Progress is shown above.', set_limit: 'Library capacity saved.' })[action] || 'Action completed.'); return true; } catch (error) { message(error.message, true); return false; } finally { panel.inert = false; actionBusy = false; } }
  const destinationUrl = (job, id) => job.target === 'spotify' ? 'https://open.spotify.com/playlist/' + encodeURIComponent(id.replace(/^spotify:playlist:/, '')) : 'https://tidal.com/playlist/' + encodeURIComponent(id);
  function render(reply) {
    if (state?.job?.id !== reply.job?.id) { $('spotifyRecoveryUrl').value = ''; $('transferGrouping').value=reply.job?.groupBy||'single'; $('transferBatchMode').value=reply.job?.groupBy==='playlist'?'playlist':'single'; }
    state = reply; const job = reply.job; $('transferReview').hidden = !job;
    workspace.render(job);
    if (!job) { if (reply.recovering) { message('Recovering the saved transfer?'); clearTimeout(poll); poll = setTimeout(() => void refreshTransfer(), 1500); } return; }
    $('transferSummary').textContent = job.name;
    $('transferProgress').textContent = `${job.state} · ${job.count} rows · ${job.valid} valid · ${job.selected} ${({youtube:'YouTube',soundcloud:'SoundCloud',spotify:'Spotify',tidal:'TIDAL'})[job.target] || 'TIDAL'} selections · ${(job.completedWritten || 0) + job.written} written${job.verified ? ' · destination verified' : ''}${job.error ? ' · ' + (errors[job.error] || job.error) : ''}${job.state === 'matching' ? ' · ' + job.processed + ' checked' : ''}`;
    const editable = !job.targetLocked && ['review', 'complete', 'paused', 'canceled'].includes(job.state);
    if (job.target) $('transferTarget').value = job.target;
    updateTarget(); $('transferTarget').disabled = !editable;
    $('saveMatched').disabled = !editable || !job.selected;
    for (const id of ['saveLocal', 'matchTidal', 'acceptMatches']) $(id).disabled = !editable || Boolean(job.destinationId);
    $('previewTransferPlan').disabled = !editable || !job.selected; $('transferGrouping').disabled = !editable; $('transferSplitSize').disabled = !editable;
    $('completedDestinations').replaceChildren(...(job.destinations || []).map(item => { const link = document.createElement('a'); link.href = destinationUrl(job, item.id); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = item.name + ' (' + item.count + ')'; const paragraph = document.createElement('p'); paragraph.append(link); return paragraph; }));
    $('writeTidal').hidden = !['tidal','spotify'].includes(job.target || $('transferTarget').value);
    $('completedDestinations').append(...(job.localDestinations || []).map(item => { const node = document.createElement('p'); node.textContent = item.name + ': ' + item.count + ' tracks saved in Library'; return node; }));
    $('writeTidal').disabled = job.state !== 'review' || !job.selected || Boolean(job.destinationId);
    $('pauseTransfer').disabled = !['matching', 'reading', 'writing'].includes(job.state); $('resumeTransfer').disabled = job.state !== 'paused';
    $('cancelTransfer').disabled = !['matching', 'reading', 'writing', 'paused', 'review'].includes(job.state); $('reconcileTransfer').hidden = job.state !== 'uncertain';
    $('destinationLink').hidden = !job.destinationId; if (job.destinationId) { $('destinationLink').href = destinationUrl(job, job.destinationId); $('destinationLink').textContent = 'Open created ' + (job.target === 'spotify' ? 'Spotify' : 'TIDAL') + ' playlist'; }
    $('spotifyDestinationRecovery').hidden = job.target !== 'spotify' || job.state !== 'uncertain' || Boolean(job.destinationId);
    const body = $('transferRows');
    const signature = JSON.stringify([job.id, job.kind, editable, reply.rows]);
    if (signature !== renderedRows || !body.contains(document.activeElement)) {
      renderedRows = signature;
      body.replaceChildren();
      for (const row of reply.rows) {
        const tr = body.insertRow(), original = row.track?.candidate || row.raw;
        const sourceCell = tr.insertCell(); if(original?.provider) sourceCell.append(window.PlaylistProviderUI.badge(original.provider)); const sourceTitle=document.createElement('div');sourceCell.append(sourceTitle);if(row.sourcePlaylist){const origin=document.createElement('small');origin.textContent='From: '+row.sourcePlaylist.name;sourceCell.append(origin);}sourceTitle.textContent = original ? `${original.title} — ${(original.artists || []).join(', ')}${original.version ? ' (' + original.version + ')' : ''}` : 'Unavailable source item';
        const cell = tr.insertCell(), select = document.createElement('select'); select.setAttribute('aria-label', 'Selection for row ' + (row.index + 1));
        select.add(new Option(job.kind === 'matching' ? 'Skip / not matched' : 'Include source track', '-1'));
        if (job.kind === 'matching') {
          row.choices.forEach((choice, index) => select.add(new Option(`${choice.score}% · ${choice.title} — ${choice.artists.join(', ')} · ${Math.round(choice.durationMs / 1000)}s · ${choice.reason}`, String(index))));
          select.value = String(row.choices.findIndex(choice => choice.providerItemId === row.selected?.providerItemId));
        } else { select.options[0].value = '0'; select.add(new Option('Skip source row', '-1')); select.value = row.include === false ? '-1' : '0'; }
        select.disabled = !editable || Boolean(job.destinationId) || !row.track;
        select.onchange = () => void perform('choose', { index: row.index, choice: Number(select.value), offset: pageOffset });
        if(job.kind==='matching'){const score=row.selected?.score ?? row.choices[0]?.score;const confidence=document.createElement('span');confidence.className='matchConfidence';confidence.dataset.level=score>=90?'strong':score>=70?'review':'weak';confidence.textContent=score===undefined?'No match found':(row.selected?'Selected: ':'Best match: ')+score+'%';cell.append(confidence);}
        cell.append(select); if (row.error) { const note = document.createElement('p'); note.textContent = row.error; note.className = 'notice bad'; cell.append(note); }
      }
    }
    $('transferPrevious').disabled = !pageOffset; $('transferNext').disabled = !reply.page.hasMore; $('transferPage').textContent = `Rows ${reply.page.total ? pageOffset + 1 : 0}–${Math.min(pageOffset + 5, reply.page.total)} of ${reply.page.total}`;
    workspace.render(job); matchingControls.render(job);
    clearTimeout(poll); if (visible && ['reading', 'matching', 'writing'].includes(job.state)) poll = setTimeout(() => void refreshTransfer(), 1500);
  }
  async function refreshTransfer() { if (loading) return; loading = true; try { render(await execute('status', { offset: pageOffset, ...matchingControls.options() })); } catch (error) { message(error.message, true); } finally { loading = false; } }
  async function account() { try { const reply = await execute('account'); const enabled = reply.playlistsEnabled && reply.connected; workspace.account(enabled); $('connectPlaylistAccount').hidden = enabled; $('transferSignInLink').hidden = true; $('connectPlaylistAccount').textContent = reply.connected ? 'Enable transfers' : 'Sign in with TIDAL'; $('transferAccount').textContent = enabled ? 'Using your connected TIDAL account.' : reply.connected ? 'Your TIDAL account is connected for search. Approve the additional permissions once to enable transfers.' : 'Sign in to use your TIDAL account.'; } catch (error) { message(error.message, true); } }
  $('transfersTab').onclick = async () => { visible = true; libraryView.hidden = true; panel.hidden = false; $('transfersTab').classList.add('primary'); $('libraryTab').classList.remove('primary'); await refreshCollections(); await account(); await refreshTransfer(); await refreshExports(); };
  $('libraryTab').onclick = () => { visible = false; libraryView.hidden = false; panel.hidden = true; clearTimeout(poll); $('libraryTab').classList.add('primary'); $('transfersTab').classList.remove('primary'); void refresh(); };
  $('transferSource').onchange = () => { for (const id of ['csv', 'library', 'tidal', 'spotify', 'url']) $(id + 'Source').hidden = $('transferSource').value !== id; workspace.source(); };
  async function refreshCollections() { const reply = await call('song.playlist.read.v1', 'status', { limit: 1 }); if(reply.recovering || reply.recoveryError) { message(reply.recoveryError || 'Restoring your library. Try again shortly.', true); return; } $('transferCollection').replaceChildren(...reply.collections.map(row => new Option(row.name + ' (' + row.count + ')', row.id))); $('transferCollection').value = reply.selectedId; $('trackCapacity').value = reply.limits.tracksPerCollection; $('csvLimit').textContent = 'Up to 8 MiB and ' + reply.limits.tracksPerCollection.toLocaleString() + ' rows.'; }
  $('readCsv').onclick = async () => {
    message('Reading CSV file...');
    const button = $('readCsv'); button.disabled = true;
    try {
      const file = $('transferFile').files[0]; if (!file || file.size > 8388608) throw new Error('Choose a UTF-8 CSV file no larger than 8 MiB.');
      const bytes = await file.arrayBuffer(); let contents; try { contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Save this CSV using UTF-8 encoding and try again.'); }
      await execute('upload_begin', { name: $('transferName').value || file.name.replace(/\.[^.]+$/, ''), delimiter: $('csvDelimiter').value === 'tab' ? '\t' : $('csvDelimiter').value });
      for (let offset = 0, chunk = 0; offset < contents.length; offset += 6000, chunk++) { await execute('upload_chunk', { offset, chunk: contents.slice(offset, offset + 6000) }); if (chunk % 20 === 19) await new Promise(resolve => setTimeout(resolve, 1000)); }
      const result = await execute('upload_headers'), mapping = $('columnMapping'); mapping.replaceChildren();
      const aliases = { title: ['title', 'track name', 'track', 'song'], artists: ['artists', 'artist', 'artist name', 'artist name(s)'], album: ['album', 'album name'] };
      for (const column of ['title', 'artists', 'album', 'duration_ms', 'isrc', 'source_provider', 'source_id', 'source_url', 'version', 'genres']) {
        const label = document.createElement('label'); label.textContent = column.replaceAll('_', ' '); const select = document.createElement('select'); select.dataset.column = column; select.add(new Option('Not provided', '__none__')); result.headers.forEach(header => select.add(new Option(header, header))); select.value = result.headers.find(header => (aliases[column] || [column]).includes(header)) || '__none__'; label.append(select); mapping.append(label);
      }
      mapping.hidden = false; $('previewCsv').hidden = false; message(`${result.count} rows read. Check column mapping, then preview.`);
    } catch (error) { message(error.message, true); } finally { button.disabled = false; }
  };
  $('previewCsv').onclick = async () => { $('previewCsv').disabled = true; pageOffset = 0; await perform('preview_csv', { mapping: Object.fromEntries([...$('columnMapping').querySelectorAll('select')].map(node => [node.dataset.column, node.value])) }); $('previewCsv').disabled = false; };
  $('useCollection').onclick = () => readSelection('library','transferCollection','source_library');
  $('listTidal').onclick = async () => { try { const result = await execute('list_tidal', { cursor: '' }); loadedPlaylists = result.playlists; nextCursor = result.cursor; drawPlaylists(); message(result.playlists.length + ' account playlists loaded. Select one to continue.'); } catch (error) { message(error.message, true); } };
  const drawPlaylists = () => { const selected = $('tidalPlaylist').value; $('tidalPlaylist').replaceChildren(...loadedPlaylists.map(row => new Option(row.name, row.id))); if ([...$('tidalPlaylist').options].some(option => option.value === selected)) $('tidalPlaylist').value = selected; $('moreTidal').hidden = !nextCursor; workspace.source(); };
  $('moreTidal').onclick = async () => { try { const result = await execute('list_tidal', { cursor: nextCursor }); loadedPlaylists.push(...result.playlists); nextCursor = result.cursor; drawPlaylists(); message('Account playlist list updated.'); } catch (error) { message(error.message, true); } };
  $('readTidal').onclick = () => readSelection('tidal','tidalPlaylist','read_tidal');
  for (const [id, action] of [['saveLocal', 'save_local'], ['acceptMatches', 'accept_matches'], ['pauseTransfer', 'pause'], ['resumeTransfer', 'resume'], ['cancelTransfer', 'cancel'], ['reconcileTransfer', 'reconcile']]) $(id).onclick = () => void perform(action, { name: $('transferName').value || state?.job?.name, offset: pageOffset, ...(action==='save_local'?{groupBy:$('transferGrouping').value}:{}) });
  async function readSelection(sourceKind,id,action){
    const playlists=playlistBrowsers[id].selected();
    if(!playlists.length)return message('Select at least one playlist to continue.',true);
    if(playlists.length>100)return message('Select up to 100 playlists per transfer.',true);
    pageOffset=0;
    return playlists.length>1?perform('source_batch',{sourceKind,playlists,name:$('transferName').value}):perform(action,{...(sourceKind==='library'?{collectionId:playlists[0].id}:{id:playlists[0].id}),name:$('transferName').value});
  }
  const targetName = () => ({ tidal: 'TIDAL', youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify' })[$('transferTarget').value];
  function updateTarget() { $('matchTidal').textContent = 'Find ' + targetName() + ' matches'; $('saveMatched').textContent = 'Save matched ' + targetName() + ' playlists locally'; }
  $('transferTarget').onchange = () => { updateTarget(); $('writeTidal').hidden = true; $('saveMatched').disabled = true; $('previewTransferPlan').disabled = true; $('destinationPlan').replaceChildren(); matchingControls.render(state?.job); };
  $('matchTidal').onclick = () => { if(state?.job?.kind==='matching'&&state.job.target===$('transferTarget').value&&state.job.state==='review')return workspace.show(3);pageOffset = 0; void perform('match', { target: $('transferTarget').value, adaptive: matchingControls.adaptive(), name: $('transferName').value || state?.job?.name }); };
  $('saveMatched').onclick = () => void perform('save_matched', destinationOptions());
  $('transferGrouping').onchange = () => { $('transferBatchMode').value=$('transferGrouping').value==='playlist'?'playlist':'single'; $('splitSizeLabel').hidden = $('transferGrouping').value !== 'size'; $('destinationPlan').replaceChildren(); matchingControls.render(state?.job); };
  const destinationOptions = () => ({ name: $('transferName').value || state?.job?.name, groupBy: $('transferGrouping').value, splitSize: Number($('transferSplitSize').value) });
  $('previewTransferPlan').onclick = async () => { try { const reply = await execute('plan', destinationOptions()); $('destinationPlan').replaceChildren(...reply.plan.map(group => { const node = document.createElement('p'); node.textContent = group.name + ': ' + group.count + ' songs'; return node; })); message('Destination plan ready. Review the playlist names and track counts.'); } catch (error) { message(error.message, true); } };
  $('writeTidal').onclick = () => void perform(state?.job?.target === 'spotify' ? 'write_spotify' : 'write_tidal', destinationOptions());
  $('reconcileTransfer').onclick = () => void perform('reconcile', { destinationId: $('spotifyRecoveryUrl').value.trim() });
  $('saveTrackCapacity').onclick = async () => { await perform('set_limit', { trackLimit: Number($('trackCapacity').value) }); await refreshCollections(); };
  async function download(action, collectionId) {
    if (actionBusy) return; actionBusy = true;
    try { message('Saving CSV copy in the exports folder...');
      const saved = await execute('save_export', { ...(collectionId ? { collectionId } : {}), report: action === 'export_report' });
      await refreshExports();
      let offset = 0, csv = '', result, revision;
      do { result = await execute(action, { collectionId, offset, ...(revision ? { revision } : {}) }); csv += result.csv; revision = result.revision; offset += 10; if (offset % 200 === 0) await new Promise(resolve => setTimeout(resolve, 1000)); } while (offset < result.count);
      const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' })); link.download = saved.file.name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); message('Saved ' + saved.file.name + ' in ' + saved.folder + '. A browser download is also available.');
    } catch (error) { message(error.message, true); } finally { actionBusy = false; }
  }
  async function refreshExports() { try { const reply = await execute('list_exports'); $('exportsFolder').textContent = reply.folder; $('exportFiles').replaceChildren(...reply.files.map(file => { const node = document.createElement('li'); node.textContent = file.name + ' / ' + Math.ceil(file.bytes / 1024) + ' KiB / ' + new Date(file.savedAt).toLocaleString(); return node; })); } catch (error) { message(error.message, true); } }
  $('refreshExports').onclick = () => void refreshExports();
  $('openExports').onclick = async () => { try { await execute('open_exports'); } catch (error) { message(error.message, true); } };
  $('exportCollection').onclick = () => void download('export_csv'); $('exportTransferReport').onclick = () => void download('export_report');
  $('transferPrevious').onclick = () => { pageOffset = Math.max(0, pageOffset - 5); void refreshTransfer(); }; $('transferNext').onclick = () => { pageOffset += 5; void refreshTransfer(); };
  $('connectPlaylistAccount').onclick = async () => {
    try {
      const url = new URL(location.origin); url.hostname = '127.0.0.1'; url.pathname = '/auth/tidal/callback';
      const reply = await call('song.tidal.experimental.v1', 'catalog', { action: 'begin', redirectUri: url.href, playlists: true });
      if (!reply.ok) throw new Error(reply.error);
      const authorization = new URL(reply.authorizationUrl);
      if (authorization.origin !== 'https://login.tidal.com' || authorization.pathname !== '/authorize') throw new Error('Invalid account sign-in address');
      const link = $('transferSignInLink'); link.href = authorization.href; link.hidden = false; link.click();
      message('Finish sign-in in the TIDAL window, then check connection. If no window opened, use the sign-in link.');
    } catch (error) { message(error.message, true); }
  };
  $('acceptMatches').onclick = () => { if ($('matchThreshold').reportValidity()) void perform('accept_matches', { threshold: Number($('matchThreshold').value) }); };
  $('checkPlaylistAccount').onclick = () => void account();
  window.installPlaylistLinkImports({
    async load(provider, id, name) { pageOffset = 0;await perform('read_' + provider, { id, name }); },
    async upload(sounds, name, valid) {
      const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
      const headers = ['title','artists','album','duration_ms','source_provider','source_id','source_url'];
      const csv = [headers.join(','), ...sounds.map(sound => [sound.title, sound.user?.username, '', sound.duration, 'soundcloud', sound.id, sound.permalink_url].map(quote).join(','))].join('\r\n');
      await execute('upload_begin', { name, delimiter: ',' });
      for (let offset = 0; offset < csv.length; offset += 6000) { if (!valid()) throw Error('Import canceled.');await execute('upload_chunk', { offset, chunk: csv.slice(offset, offset + 6000) });if (offset && offset % 120000 === 0) await new Promise(resolve=>setTimeout(resolve,1000)); }
      if (!valid()) throw Error('Import canceled.');
      const result = await execute('preview_csv', { sourceKind: 'soundcloud', mapping: Object.fromEntries(headers.map(key=>[key,key])) });render(result);message('SoundCloud playlist loaded. Choose a destination.');
    }, notice: message, loading: value => workspace.loading(value)
  });
  let spotifyPlaylists = [], spotifyCursor = '';
  async function loadSpotify(more = false) {
    const button = $(more ? 'moreSpotify' : 'listSpotify');button.disabled = true;$('spotifySourceStatus').textContent = 'Reading Spotify playlists...';
    try { const result = await execute('list_spotify', { cursor: more ? spotifyCursor : '' });spotifyPlaylists = more ? [...spotifyPlaylists,...result.playlists] : result.playlists;spotifyCursor = result.cursor;
      $('spotifyPlaylist').replaceChildren(...spotifyPlaylists.map(row=>new Option(row.name,row.id)));$('moreSpotify').hidden = !spotifyCursor;$('spotifySourceStatus').textContent = spotifyPlaylists.length + ' playlists loaded. Select one to continue.';workspace.source();
    } catch (error) { $('spotifySourceStatus').textContent = 'Could not read Spotify. Open Spotify with RaveLink; prepare the updated companion if needed. ' + error.message;message(error.message,true); } finally { button.disabled = false; }
  }
  $('listSpotify').onclick = () => loadSpotify();$('moreSpotify').onclick = () => loadSpotify(true);
  $('readSpotify').onclick = () => readSelection('spotify','spotifyPlaylist','read_spotify');
  window.addEventListener('pagehide', () => clearTimeout(poll));
})();
