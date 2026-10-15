window.installPlaylistWorkspace = function installPlaylistWorkspace({ panel, libraryView, startTransfer }) {
  const style = document.createElement('style'); style.textContent = '#transferActivity{border:1px solid var(--edge);border-left:5px solid var(--accent);border-radius:10px;padding:18px;margin:12px 0 22px;background:var(--surface,#111a2b)}#transferActivity[data-attention=true]{border-left-color:var(--warn,#e8b44d)}#transferActivity h3{font-size:21px;margin:4px 0 10px}#transferActivity progress{display:block;width:100%;height:12px;accent-color:var(--accent);margin:12px 0}#transferStage{font-size:14px;font-weight:800}#transferNextStep{line-height:1.6;margin:8px 0}#transferStats{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);font-size:12px}#transferProgress{font-size:12px;color:var(--muted)}#transferNotice:not(:empty){padding:12px;border:1px solid var(--edge);border-radius:7px;background:var(--surface)}#transferReview>h3{margin-top:20px}.playlistTools{padding:10px 0;border-bottom:1px solid var(--edge);margin-bottom:14px}.playlistTools summary{cursor:pointer;font-weight:700;padding:6px 0}.playlistTools[open]>.band{margin:10px 0}.libraryHeading{display:flex;gap:12px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin-bottom:16px}.libraryHeading h2{margin:0;font-size:21px}.transferDestination{border:1px solid var(--edge);border-radius:9px;padding:14px;margin:16px 0}#transferReview table{margin-top:12px}#transferStatusActions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}#transferStatusActions button{height:36px}#transferAccountSetup{margin-bottom:14px}#transferStartNew{margin-top:8px}'; document.head.append(style);
  const activity = document.createElement('section'); activity.id = 'transferActivity'; activity.hidden = true; activity.setAttribute('aria-label', 'Current transfer');
  activity.innerHTML = '<div id="transferStage" role="status" aria-live="polite"></div><progress id="transferMeter" max="1" value="0" aria-label="Transfer progress"></progress><p id="transferNextStep"></p><div id="transferStats"></div><div id="transferStatusActions"></div><button id="transferStartNew" hidden>Choose another source</button>';
  panel.querySelector('h2').after(activity);
  const introduction = [...panel.children].find(node => node.tagName === 'P');
  if (introduction) panel.querySelector('h2').after(introduction);
  activity.append($('completedDestinations'), $('destinationLink'));
  activity.prepend($('transferSummary')); activity.append($('transferProgress'));
  for (const id of ['pauseTransfer', 'resumeTransfer', 'cancelTransfer', 'reconcileTransfer']) $('transferStatusActions').append($(id));
  const sourceControls = document.createElement('section'); sourceControls.id = 'transferSourceControls';
  const nameBand = $('transferSource').closest('.band'); sourceControls.append(nameBand, $('csvSource'), $('librarySource'), $('tidalSource')); activity.after(sourceControls);
  const account = $('transferAccount').closest('details'); account.id = 'transferAccountSetup';
  sourceControls.after(account);
  const extras = document.createElement('details'); extras.className = 'playlistTools'; extras.innerHTML = '<summary>Transfer report & library settings</summary>';
  extras.append($('transferProgress'), $('exportTransferReport'), $('trackCapacity').closest('details')); panel.append(extras, $('csvExports'));
  $('csvExports').className = 'playlistTools';
  const sourceSave = $('saveLocal').closest('.band'); sourceSave.id = 'transferSourceSave';
  const destination = $('transferTarget').closest('.band'); destination.classList.add('transferDestination'); destination.id = 'transferDestination';
  const destinationHeading = destination.previousElementSibling; destinationHeading.id = 'transferDestinationHeading';
  const organization = document.createElement('details'); organization.className = 'playlistTools'; organization.id = 'transferOrganization'; organization.innerHTML = '<summary>Organize destination playlists</summary>';
  organization.append($('transferGrouping').closest('label'), $('splitSizeLabel'), $('previewTransferPlan'), $('destinationPlan')); destination.append(organization);
  const heading = document.createElement('div'); heading.className = 'libraryHeading'; heading.innerHTML = '<h2>Your playlists</h2><button id="transferSelectedPlaylist" class="primary">Transfer this playlist</button>';
  libraryView.querySelector('.libraryDetails').prepend(heading);
  $('transferSelectedPlaylist').onclick = () => startTransfer();
  for (const [element, title] of [[$('saveHistory').closest('.band'), 'Save played requests'], [$('importUrl').closest('.band'), 'Import a playlist link']]) {
    const details = document.createElement('details'); details.className = 'playlistTools'; const summary = document.createElement('summary'); summary.textContent = title; element.before(details); details.append(summary, element);
  }
  const flow = window.installTransferFlow({ panel, sourceControls, account, activity, organization });
  let job = null;
  const stages = { reading: 'Reading your playlist', matching: 'Finding destination matches', writing: 'Creating destination playlists', review: 'Ready to review', paused: 'Transfer paused', uncertain: 'Delivery needs your review', complete: 'Transfer complete', canceled: 'Transfer canceled' };
  function render(current) {
    job = current; activity.hidden = !job; activity.dataset.state = job?.state || '';
    $('exportTransferReport').hidden = !job;
    if (!job) { flow.render(null); return; }
    const running = ['reading', 'matching', 'writing'].includes(job.state), waiting = job.retryAt > Date.now();
    const processed = job.state === 'matching' ? job.processed : job.state === 'writing' ? (job.completedWritten || 0) + job.written : job.count;
    const waitLabel = job.rateLimitSource === 'local' ? 'Waiting for RaveLink search allowance' : job.rateLimitSource === 'soundcloud' ? 'SoundCloud asked us to wait' : job.rateLimitSource === 'concurrency' ? 'Waiting for another catalog search to finish' : 'Waiting for the catalog';
    $('transferStage').textContent = waiting ? waitLabel + ' - will resume automatically' : (job.state === 'review' && job.kind !== 'matching' ? 'Playlist loaded - choose a destination' : stages[job.state] || job.state);
    activity.dataset.attention = String(waiting || ['paused', 'uncertain'].includes(job.state));
    $('transferMeter').max = Math.max(1, job.count); $('transferMeter').value = Math.min(job.count, processed); $('transferMeter').hidden = ['review', 'canceled'].includes(job.state);
    $('transferNextStep').textContent = waiting ? 'Your progress is saved. ' + job.processed + ' of ' + job.count + ' tracks checked. Trying again in about ' + Math.max(1, Math.ceil((job.retryAt - Date.now()) / 1000)) + ' seconds. You can leave this page open or return later.'
      : job.state === 'matching' ? 'Matching continues in the background. Review the results when it finishes.'
      : job.state === 'reading' ? 'Loading tracks from the source. No destination playlist has been changed.'
      : job.state === 'writing' ? 'Sending the selected tracks and verifying the destination. Keep this job until verification finishes.'
      : job.state === 'uncertain' ? 'Check the destination before continuing. Use Check uncertain delivery below; tracks will not be resent automatically.'
      : job.state === 'paused' ? 'Progress is saved. Resolve the issue shown below, then Resume.'
      : job.state === 'complete' ? 'Your playlists are ready. Open the destination below or find local playlists in Library.'
      : job.kind === 'matching' ? 'Review the suggested matches below. Select the tracks you want, then save to the destination.' : 'Save the source locally, or choose a destination below to match its tracks.';
    const saved = job.state === 'complete' && job.kind !== 'matching' ? job.valid : (job.completedWritten || 0) + job.written;
    $('transferStats').textContent = job.count + ' source tracks / ' + (job.kind === 'matching' ? job.selected + ' selected' : job.valid + ' included') + ' / ' + saved + ' saved';
    for (const [id, visible] of [['pauseTransfer', running], ['resumeTransfer', job.state === 'paused'], ['cancelTransfer', running || ['review', 'paused'].includes(job.state)], ['reconcileTransfer', job.state === 'uncertain']]) $(id).hidden = !visible;
    $('transfersTab').textContent = running ? 'Transfers (' + (waiting ? 'waiting' : job.state === 'matching' ? job.processed + '/' + job.count : job.state) + ')' : 'Transfers';
    flow.render(job);
  }
  return { ...flow, render,  library(state) { const selected = state.collections.find(row => row.id === state.selectedId); $('transferSelectedPlaylist').disabled = !selected?.count; heading.querySelector('h2').textContent = selected?.name || 'Your playlists'; } };
};
