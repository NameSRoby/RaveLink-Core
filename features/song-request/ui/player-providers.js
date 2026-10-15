(function installPlayerProviders() {
  let view = 'player', providerReady = false, savedPlayer = 'youtube';
  const picker = document.createElement('div'); picker.className = 'playerProviderPicker';
  picker.innerHTML = '<label for="songPlayerProvider">PLAYER</label><select id="songPlayerProvider"><option value="youtube">YouTube</option><option value="tidal">TIDAL</option><option value="soundcloud">SoundCloud (Alpha)</option></select><span id="playerProviderHint">Embedded YouTube playback</span>';
  document.querySelector('main').prepend(picker);
  const embedWarning=document.createElement('aside');embedWarning.id='youtubeEmbedWarning';embedWarning.setAttribute('role','note');embedWarning.innerHTML='<strong>YouTube playback warning</strong><p>YouTube embeds can refuse songs because of uploader settings, account, age, region or content restrictions. A successful search does not guarantee playback.</p><p>Repeated failures and rapid automatic skips may overload playback and cause the server to stop or crash. Stop playback if songs keep skipping; try another source or restart Core if it stops responding.</p>';
  document.querySelector('.playerSide').prepend(embedWarning);
  const warningStyle=document.createElement('style');warningStyle.textContent='#youtubeEmbedWarning{border:1px solid #e5b647;border-left:5px solid #e5b647;background:#322818;color:#fff0c0;border-radius:8px;padding:14px;margin-bottom:16px;font-size:13px;line-height:1.5}#youtubeEmbedWarning strong{font-size:16px}#youtubeEmbedWarning p{margin:8px 0 0}';document.head.append(warningStyle);
  const tabs = document.createElement('nav'); tabs.className = 'playerViewTabs'; tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Selected player controls');
  tabs.innerHTML = ['player', 'setup', 'moderation'].map(id => `<button id="playerTab-${id}" type="button" role="tab" data-view="${id}" aria-controls="${id === 'player' ? 'songPlaybackPage' : id === 'setup' ? 'songSetupPage' : 'songModerationPage'}" aria-selected="${id === 'player'}" tabindex="${id === 'player' ? 0 : -1}">${id === 'player' ? 'Playback' : id === 'setup' ? 'Setup' : 'Moderation'}</button>`).join('');
  picker.after(tabs);
  tabs.onclick = event => { const button = event.target.closest('[data-view]'); if (button) showView(button.dataset.view); };
  tabs.onkeydown = event => {
    const keys = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
    if (!(event.key in keys)) return;
    event.preventDefault(); const buttons = [...tabs.querySelectorAll('button')], current = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (current + keys[event.key] + 3) % 3;
    showView(buttons[next].dataset.view); buttons[next].focus();
  };
  const policyGrid = document.querySelector('.queueSide > .settingsGrid'), policy = document.createElement('details');
  policy.className = 'playerAdvancedPolicy';
  const policySummary = document.createElement('summary'); policySummary.textContent = 'Request limits & song length';
  policyGrid.previousElementSibling.replaceWith(policy); policy.append(policySummary, policyGrid);
  const durationControl = document.createElement('label');
  durationControl.innerHTML = 'MAXIMUM SONG LENGTH (MINUTES)<input id="maxSongMinutes" type="number" min="0.5" max="60" step="0.5" value="10">';
  policyGrid.insertBefore(durationControl, $('savePolicy'));
  const nativeLimit = document.createElement('label'); nativeLimit.innerHTML = 'UPCOMING REQUESTS IN TIDAL<input id="tidalQueueLimit" type="number" value="10" disabled title="Extra requests wait in RaveLink. The playing song and underlying playlist do not count.">'; nativeLimit.hidden = true; policyGrid.insertBefore(nativeLimit, $('savePolicy'));
  policyGrid.addEventListener('input', () => { policyDraftDirty = true; });
  policyGrid.addEventListener('change', () => { policyDraftDirty = true; });
  const saveLimits = $('savePolicy').onclick;
  $('savePolicy').onclick = event => { if ($('maxSongMinutes').reportValidity()) return saveLimits(event); };
  const panel = document.createElement('section'); panel.id = 'tidalPlayer'; panel.hidden = true;
  panel.innerHTML = `<header class="tidalHeader"><div><h2>TIDAL</h2><p id="tidalConnection" role="status">Checking your player…</p></div><button id="refreshTidal" title="Refresh account and desktop connection">Refresh</button></header>
    <div class="tidalSetupSteps">
    <section id="tidalCatalogSetup" class="tidalStep"><div class="tidalStepHeading"><span class="tidalStepNumber" aria-hidden="true">1</span><h3>Connect your account</h3><span id="tidalAccountBadge" class="tidalBadge">Not connected</span></div>
    <p id="tidalApiState" role="status">Checking account…</p>
    <p id="tidalAccountHelp">Sign in once for song lookup and playlist/collection transfers. Your password stays with TIDAL.</p>
    <div class="actions"><button id="signInTidal" class="primary">Sign in with TIDAL</button></div>
    <a id="tidalOpenLogin" target="_blank" rel="noopener noreferrer" hidden>Open TIDAL sign-in</a>
    <details id="tidalAccountOptions"><summary>Account & region</summary>
    <div class="actions"><label for="tidalCountry">Catalog country<select id="tidalCountry" required aria-label="Catalog country"><option value="">Loading countries…</option></select></label><button id="saveTidalRegion">Save region</button></div>
    <p class="tidalFinePrint">Choose your TIDAL account's country. Song availability varies by country.</p>
    <div class="actions"><button id="testTidalCatalog">Check connection</button><button id="clearTidalCatalog">Disconnect account</button></div>
    <p class="tidalFinePrint">Sign-in is saved securely on this PC. Disconnect removes the local authorization.</p></details></section>
    <section class="tidalStep"><div class="tidalStepHeading"><span class="tidalStepNumber" aria-hidden="true">2</span><h3>Connect the desktop player</h3><span id="tidalDesktopBadge" class="tidalBadge">Checking</span></div>
    <p id="tidalInstallStatus" role="status"></p>
    <details id="tidalSetup"><summary>Set up desktop connection</summary>
    <ol class="tidalChecklist"><li>Quit TIDAL completely, including its tray icon.</li><li>Install or update the RaveLink companion below.</li><li>Open TIDAL and play a song, then choose Refresh.</li></ol>
    <div class="actions"><button id="installTidalCompanion" class="primary">Install companion</button><button id="updateTidalCompanion" class="primary" hidden>Update companion</button></div>
    <p class="tidalFinePrint">Requires the regular Windows desktop app. The Microsoft Store app is not supported.</p></details>
    <details id="tidalConnectionOptions"><summary>Connection options</summary><div class="actions"><button id="monitorTidal">Use TIDAL for now playing</button><button id="uninstallTidalCompanion">Remove companion</button></div><p class="tidalFinePrint">Close TIDAL before removal or updates. Removing the companion restores the original app files.</p></details></section>
    </div>
    <p id="tidalReadyHelp" class="tidalReadyHelp">Add a song to send it to TIDAL automatically. All accepted requests join the queue in order; your playlist stays intact.</p>
    <details id="tidalHistory"><summary>Recently sent to TIDAL</summary><div id="tidalHandoffs"></div></details>
    <details id="tidalDeveloperSettings" hidden><summary>Developer tools</summary>
    <p id="tidalClientSource"></p>
    <label>CUSTOM CLIENT ID<input id="tidalClientId" type="password" maxlength="160" autocomplete="new-password" placeholder="Write-only override" required></label>
    <p>For a custom app, register this exact local redirect URI at <a href="https://developer.tidal.com" target="_blank" rel="noopener">TIDAL Developer</a>:</p><code id="tidalRedirectUri"></code>
    <p>Permissions: search.read, playlists.read/write, collection.read/write. Transfers change your library only after you review and start them.</p>
    <p id="tidalDiagnostic" class="tidalFinePrint"></p>
    <div class="actions"><button id="saveTidalCatalog">Replace client ID</button><button id="resetTidalClient">Use bundled app</button></div>
    <details><summary>Legacy Luna companion</summary><p>An already paired Luna companion can still use this address:</p><code id="tidalPluginAddress"></code><p>Its pairing-file environment variable must point to:</p><code id="tidalPairingFile"></code></details>
    </details>`;
  document.querySelector('.playerSide').prepend(panel);
  // Subtabs share the live player and controllers; navigation never replaces it.
  const playbackPage = document.createElement('section'); playbackPage.id = 'songPlaybackPage'; playbackPage.setAttribute('role', 'tabpanel');
  document.querySelector('main').append(playbackPage); playbackPage.append(document.querySelector('.playerSide'), document.querySelector('.queueSide'));
  const workspace = document.createElement('section'); workspace.id = 'songWorkspace';
  const setupPage = document.createElement('section'); setupPage.id = 'songSetupPage';
  const moderationPage = document.createElement('section'); moderationPage.id = 'songModerationPage';
  document.querySelector('main').append(workspace); workspace.append(setupPage, moderationPage);
  setupPage.append(panel, $('catalogSettings')); $('catalogSettings').open = true;
  const searchFilters = document.createElement('details'); searchFilters.id = 'songSearchFilters';
  searchFilters.innerHTML = '<summary>Song matching & version filters</summary>';
  searchFilters.append($('minimumSubscribers').closest('.settingsGrid'), $('allowNonMusic').parentElement, $('derivativeFilters'), $('saveCatalogPolicy').parentElement);
  moderationPage.append(policy, searchFilters, $('responseToggles').closest('details'));
  const restrictions = document.createElement('section'); restrictions.id = 'requesterRestrictions';
  restrictions.innerHTML = '<h2>Bans & active timeouts</h2><p>These restrictions apply to Song Request. Remove a ban, change a timeout, or restore access here.</p><table><thead><tr><th>REQUESTER</th><th>RESTRICTION</th><th>ACTIONS</th></tr></thead><tbody id="restrictedRequesters"></tbody></table><div class="actions"><button id="restrictionsPrevious">Previous</button><span id="restrictionsPage"></span><button id="restrictionsNext">Next</button></div>';
  moderationPage.append(restrictions);
  $('restrictionsPrevious').onclick = () => { moderationOffset = Math.max(0, moderationOffset - 25); void refreshState(); };
  $('restrictionsNext').onclick = () => { moderationOffset += 25; void refreshState(); };
  policy.open = true;
  const playbackPanel = document.createElement('section'); playbackPanel.id = 'tidalPlayback'; playbackPanel.hidden = true;
  playbackPanel.innerHTML = '<div><h2>TIDAL Desktop</h2><p id="tidalPlaybackStatus" role="status">Checking desktop connection…</p></div><button id="openSongSetup">Setup</button>';
  $('tidalHistory').hidden = true;
  $('tidalReadyHelp').hidden = true; document.querySelector('.playerSide').prepend(playbackPanel);
  $('openSongSetup').onclick = () => showView('setup');
  const notice = $('notice'); notice.classList.add('workspaceNotice'); document.querySelector('main').append(notice);
  workspace.hidden = true; setupPage.hidden = true; moderationPage.hidden = true;
  for (const [id, node] of [['player', playbackPage], ['setup', setupPage], ['moderation', moderationPage]]) {
    node.setAttribute('role', 'tabpanel'); node.setAttribute('aria-labelledby', `playerTab-${id}`);
  }
  let tidalState = null, refreshingTidal = false, tidalRefreshQueued = false, tidalRefreshTimer = null;
  let companionInstall = null, companionCheckedAt = 0, catalogStatus = null, loginTimer = null, loginDeadline = 0, desktopSetupKey = '';
  const callbackUri = () => { const url = new URL(location.origin); url.hostname = '127.0.0.1'; url.pathname = '/auth/tidal/callback'; return url.href; };
  const selected = () => $('songPlayerProvider').value;
  function showView(next) {
    if (next !== view) setNotice('');
    view = next; document.body.dataset.songView = view; embedWarning.hidden = view !== 'player' || selected() !== 'youtube';
    playbackPage.hidden = view !== 'player'; workspace.hidden = view === 'player';
    setupPage.hidden = view !== 'setup'; moderationPage.hidden = view !== 'moderation';
    document.body.classList.toggle('song-settings-view', view !== 'player');
    for (const button of tabs.querySelectorAll('button')) { const active = button.dataset.view === view; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
    if (view === 'moderation' || view === 'setup' && selected() === 'youtube') void refreshCatalog();
    if (providerReady && view === 'player' && selected() === 'youtube') ensureYoutubePlayer();
    void refreshTidal(); void refreshState();
  }
  const soundcloud = installSoundCloudPlayer(); const volumeControls = installPlayerVolumeControls(soundcloud); window.ravelinkSoundCloud = soundcloud; let soundcloudQueue = null;
  const originalPull = maybePull, originalSubmit = submitRequest, originalRenderQueue = renderQueue;
  const originalModerate = moderate;
  moderate = async function (payload, message) { await originalModerate(selected() === 'tidal' ? { ...payload, provider: 'tidal' } : payload, message); if (selected() === 'tidal') await refreshTidal(); };
  const originalRenderPlayback = renderPlayback, renderNowDetails = installNowPlayingDetails();
  maybePull = async function () { if (providerReady && selected() === 'youtube') return originalPull(); if (providerReady && selected() === 'soundcloud') return soundcloud.pull(); };
  renderPlayback = function (state) {
    if (selected() === 'tidal' && state.playbackSource !== 'tidal') {
      renderNowDetails(null); $('nowTitle').textContent = 'TIDAL'; $('nowArtist').textContent = 'Enable TIDAL now playing in Setup / Connection options.'; $('nowProvider').textContent = 'TIDAL'; return;
    }
    const currentProvider = state.primary?.candidate?.provider || state.primary?.provider;
    const visible = currentProvider && currentProvider !== selected() ? { ...state, primary: null } : state;
    originalRenderPlayback(visible); renderNowDetails(visible.primary);
    if (selected() === "soundcloud" && soundcloudQueue) soundcloud.render(soundcloudQueue, state, originalRenderQueue);
  };
  renderQueue = function (state) {
    if (selected() === 'soundcloud') { soundcloudQueue = state; return; }
    if (selected() === 'youtube') {
      const body = $('queue'), signature = JSON.stringify([state.queue || [], state.counts?.queued]);
      if (body.dataset.youtubeSignature !== signature) { originalRenderQueue(state); compactQueueModeration(body, state.queue || [], moderate); body.dataset.youtubeSignature = signature; }
      return;
    }
    renderTidalQueue();
  };
  let recentRequesters = new Map();
  const originalRenderRequesters = renderRequesters;
  renderRequesters = function (state) { recentRequesters = new Map((state.moderation?.recentRequesters || []).map(row => [row.requesterKey, row])); originalRenderRequesters(state); if (selected() === 'tidal') renderTidalQueue(); };
  function renderTidalQueue() {
    if (selected() === 'tidal') renderTidalRequests({ state: tidalState, installation: companionInstall, requesters: recentRequesters, refresh: refreshTidal, refreshState, moderate });
    renderTidalNowPlaying({ state: selected() === 'tidal' ? tidalState : null, requesters: recentRequesters, moderate, refresh: refreshTidal });
  }
  async function refreshTidal() {
    if (selected() !== 'tidal' || view === 'moderation') return;
    if (refreshingTidal) { tidalRefreshQueued = true; return; }
    refreshingTidal = true;
    try {
      tidalState = await call('song.tidal.experimental.v1', 'status', null);
      if (!tidalState.enabled) { await call('song.tidal.experimental.v1', 'enable', {}); tidalState = await call('song.tidal.experimental.v1', 'status', null); }
      $('tidalConnection').textContent = tidalState.connected && tidalState.ready ? 'Desktop connected · ready to queue songs' : view === 'setup' ? 'Finish the steps below to connect TIDAL.' : 'Open Setup to connect TIDAL.';
      $('monitorTidal').disabled = tidalState.enabled !== true;
      $('tidalPairingFile').textContent = tidalState.pairingFile || 'Select TIDAL to create the pairing file.';
      $('tidalPluginAddress').textContent = location.origin + '/experimental/tidal/plugin/ravelink.tidal-experiment';
      if (view === 'setup' || !companionInstall || Date.now() - companionCheckedAt > 10000) await refreshCompanionInstall();
      if (companionInstall?.installed && !['0.1.6', '0.1.7'].includes(companionInstall.version)) $('tidalConnection').textContent = 'Desktop companion update needed — open Setup';
      if (view === 'setup') await refreshCatalogApi();
      renderTidalQueue();
      if (tidalState.connected && tidalState.ready && !tidalState.delivery?.processing && !tidalState.delivery?.lastError && tidalState.capacity?.available > 0
        && !(companionInstall?.installed && !['0.1.6', '0.1.7'].includes(companionInstall.version))
        && tidalState.queue?.some(entry => !entry.deliveryError && !(tidalState.handoffs || []).some(receipt => receipt.entryId === entry.id && ['unknown', 'pending', 'failed'].includes(receipt.phase)))) {
        await call('song.tidal.experimental.v1', 'flush', {});
      }
    } catch (error) { $('tidalConnection').textContent = error.message; setNotice('TIDAL controls are unavailable. Restart Core after updating Song Request.', true); }
    finally {
      volumeControls.nativeStatus(tidalState); $('tidalPlaybackStatus').textContent = $('tidalConnection').textContent; refreshingTidal = false;
      if (tidalRefreshQueued) { tidalRefreshQueued = false; clearTimeout(tidalRefreshTimer); tidalRefreshTimer = setTimeout(() => void refreshTidal(), 150); }
    }
  }
  async function refreshCatalogApi() {
    const status = await call('song.tidal.experimental.v1', 'catalog', { action: 'status' });
    catalogStatus = status;
    $('tidalApiState').textContent = status.lastError ? tidalErrorMessage(new Error(status.lastError)) : status.pending ? 'Waiting for TIDAL sign-in…' : status.connected ? 'TIDAL account connected. Core searches the catalog.' : 'Sign in for text searches. Direct TIDAL links still work.';
    const countryPicker = $('tidalCountry');
    if (countryPicker.options.length < 2 && Array.isArray(status.countries)) {
      countryPicker.replaceChildren(...status.countries.map(country => new Option(country.name, country.code)));
    }
    if (document.activeElement !== countryPicker) countryPicker.value = status.countryCode || 'US';
    $('tidalClientSource').textContent = status.clientIdSource === 'custom' ? 'Using your custom app registration. The saved ID is not displayed.' : 'Using the bundled app registration. The saved ID is not displayed.';
    $('tidalRedirectUri').textContent = callbackUri();
    $('tidalDiagnostic').textContent = status.lastError ? 'Last API result: ' + status.lastError : 'No API errors reported.';
    $('tidalAccountBadge').textContent = status.pending ? 'Signing in' : status.connected ? 'Connected' : 'Not connected';
    $('tidalAccountBadge').classList.toggle('connected', status.connected === true);
    $('signInTidal').hidden = status.connected && !status.lastError && !status.pending;
    $('signInTidal').hidden = status.connected && !status.lastError; $('signInTidal').textContent = status.connected ? 'Reconnect TIDAL' : 'Sign in with TIDAL';
    $('tidalAccountHelp').hidden = status.connected;
    $('testTidalCatalog').disabled = !status.connected; $('clearTidalCatalog').disabled = !status.connected && !status.pending;
    if (!status.pending) { clearTimeout(loginTimer); loginTimer = null; $('tidalOpenLogin').hidden = true; }
    return status;
  }
  async function manageCatalogApi(action) {
    const buttons = ['saveTidalCatalog', 'resetTidalClient', 'saveTidalRegion', 'testTidalCatalog', 'clearTidalCatalog']; buttons.forEach(id => $(id).disabled = true);
    try {
      if ((action === 'configure' || action === 'region') && !$('tidalCountry').reportValidity()) return;
      if (action === 'configure' && !$('tidalClientId').reportValidity()) return;
      const payload = { action: action === 'region' ? 'configure' : action, ...(action === 'region' ? { countryCode: $('tidalCountry').value.toUpperCase() } : action === 'configure' ? { clientId: $('tidalClientId').value.trim() } : {}) };
      await call('song.tidal.experimental.v1', 'catalog', payload);
      if (action === 'configure' || action === 'reset-client') $('tidalClientId').value = '';
      await refreshCatalogApi();
    } catch (error) { $('tidalApiState').textContent = tidalErrorMessage(error); }
    finally { $('saveTidalCatalog').disabled = false; $('resetTidalClient').disabled = false; $('saveTidalRegion').disabled = false; $('testTidalCatalog').disabled = !catalogStatus?.connected; $('clearTidalCatalog').disabled = !catalogStatus?.connected && !catalogStatus?.pending; }
  }
  async function checkLogin() {
    loginTimer = null;
    try { const status = await refreshCatalogApi(); if (status.pending && Date.now() < loginDeadline) loginTimer = setTimeout(checkLogin, 1500); }
    catch (error) { $('tidalApiState').textContent = tidalErrorMessage(error); }
  }
  async function signInTidal() {
    const popup = window.open('about:blank', 'ravelink-tidal-sign-in', 'popup,width=720,height=760');
    $('signInTidal').disabled = true;
    try {
      const result = await call('song.tidal.experimental.v1', 'catalog', { action: 'begin', redirectUri: callbackUri(), playlists: true });
      const url = new URL(result.authorizationUrl);
      if (url.origin !== 'https://login.tidal.com' || url.pathname !== '/authorize') throw new Error('Invalid TIDAL authorization address');
      $('tidalOpenLogin').href = url.href; $('tidalOpenLogin').hidden = false;
      if (popup) { popup.opener = null; popup.location.href = url.href; }
      $('tidalApiState').textContent = popup ? 'Finish signing in on TIDAL, then return here.' : 'Popup blocked. Select Open TIDAL sign-in.';
      clearTimeout(loginTimer); loginDeadline = Date.now() + 300000; loginTimer = setTimeout(checkLogin, 1500);
    } catch (error) { popup?.close(); $('tidalApiState').textContent = tidalErrorMessage(error); }
    finally { $('signInTidal').disabled = false; }
  }
  async function refreshCompanionInstall() {
    companionInstall = await call('song.tidal.experimental.v1', 'companion', { action: 'status' });
    companionCheckedAt = Date.now();
    const ready = tidalState?.connected && tidalState?.ready, needsUpdate = companionInstall.installed && companionInstall.version !== '0.1.7';
    if (needsUpdate) $('tidalConnection').textContent = 'Desktop companion update needed';
    $('tidalInstallStatus').textContent = needsUpdate ? 'Close TIDAL, choose Update companion below, then reopen TIDAL. Your original app and playlist are preserved.' : ready ? 'Connected. Requests join the queue in order without replacing your playlist.'
      : companionInstall.installed ? 'Companion installed. Open TIDAL, play a song and choose Refresh.'
      : companionInstall.foreignLoader ? 'Another desktop integration is installed. Remove it before connecting RaveLink.'
      : companionInstall.available ? 'One-time setup connects RaveLink to your desktop player.' : 'Install TIDAL Desktop first, then choose Refresh.';
    $('tidalDesktopBadge').textContent = needsUpdate ? 'Update needed' : ready ? 'Connected' : 'Setup needed';
    $('tidalDesktopBadge').classList.toggle('connected', Boolean(ready && !needsUpdate));
    $('tidalSetup').hidden = Boolean(ready && !needsUpdate);
    const setupKey = `${Boolean(ready)}:${Boolean(companionInstall.installed)}:${Boolean(needsUpdate)}`;
    if (setupKey !== desktopSetupKey) { $('tidalSetup').open = !ready || needsUpdate; $('tidalConnectionOptions').open = Boolean(needsUpdate); desktopSetupKey = setupKey; }
    $('installTidalCompanion').disabled = !tidalState?.enabled || !companionInstall.available || companionInstall.installed || companionInstall.foreignLoader;
    $('installTidalCompanion').hidden = companionInstall.installed;
    $('updateTidalCompanion').hidden = !needsUpdate;
    $('updateTidalCompanion').disabled = !needsUpdate || !tidalState?.enabled;
    $('uninstallTidalCompanion').disabled = !companionInstall.installed;
  }
  async function manageCompanion(action) {
    $('installTidalCompanion').disabled = true; $('updateTidalCompanion').disabled = true; $('uninstallTidalCompanion').disabled = true;
    try {
      const coreUrl = new URL(location.origin); coreUrl.hostname = '127.0.0.1';
      await call('song.tidal.experimental.v1', 'companion', { action, ...(['install', 'update'].includes(action) ? { coreUrl: coreUrl.origin } : {}) });
      setNotice(action === 'uninstall' ? 'Companion removed. TIDAL archive restored.' : 'Companion installed. Start TIDAL normally, then refresh status.');
    } catch (error) { setNotice(error.message, true); $('tidalInstallStatus').textContent = error.message; }
    finally { await refreshCompanionInstall(); }
  }
  async function submitForPlayer(event) {
    if (selected() === 'soundcloud') return soundcloud.submit(event);
    if (selected() === 'youtube') return originalSubmit(event);
    event?.preventDefault?.(); const query = $('videoInput').value.trim(); if (!query) { setRequestNotice('Enter an artist and song, TIDAL link, or track ID.', true); return; }
    $('addSong').disabled = true; setRequestNotice('Looking up the track through TIDAL…');
    try { const result = await call('song.tidal.experimental.v1', 'submit', { query, requestId: crypto.randomUUID() }); $('videoInput').value = ''; setRequestNotice(`Added ${result.entry?.candidate?.title || 'track'}; sending to TIDAL automatically.`); await refreshTidal(); }
    catch (error) { setRequestNotice(tidalErrorMessage(error), true); }
    finally { $('addSong').disabled = false; }
  }
  function choosePlayer() {
    embedWarning.hidden = view !== 'player' || selected() !== 'youtube';
    delete $('queue').dataset.youtubeSignature;
    delete $('queue').dataset.signature;
    const tidal = selected() === 'tidal';
    document.body.classList.toggle('tidal-mode', tidal);
    if (tidal) player?.pauseVideo?.();
    panel.hidden = !tidal; playbackPanel.hidden = !tidal; $('playerFrame').hidden = tidal; startPlayer.hidden = tidal; $('skip').hidden = tidal;
    document.querySelector('.volumeControl').hidden = false; $('catalogSettings').hidden = tidal;
    $('responseToggles').closest('details').hidden = tidal; $('titleInput').closest('label').hidden = tidal;
    $('volumeFloor').closest('label').hidden = tidal; $('volumeCeiling').closest('label').hidden = tidal;
    $('minimumSubscribers').closest('label').hidden = tidal; $('minimumViews').closest('label').hidden = tidal; $('allowNonMusic').parentElement.hidden = tidal;
    $('catalogStatus').hidden = tidal; $('songSearchFilters').hidden = false;
    $('viewerLimit').closest('label').hidden = tidal; $('vipLimit').closest('label').hidden = tidal;
    nativeLimit.hidden = !tidal;
    tabs.setAttribute('aria-label', `${tidal ? 'TIDAL' : 'YouTube'} controls`);
    policy.hidden = false; policySummary.textContent = tidal ? 'Request limits & song length' : 'Request limits & song length';
    $('playerProviderHint').textContent = tidal ? 'Search songs · queue in order in TIDAL Desktop' : 'Embedded YouTube playback';
    $('videoInput').closest('label').firstChild.textContent = 'SONG QUERY OR TRUSTED LINK';
    $('videoInput').placeholder = tidal ? 'Artist and song, TIDAL link, or track ID' : 'Artist and song, YouTube, or Spotify';
    $('requestNotice').textContent = tidal ? 'Add an artist and song. Accepted requests are sent to TIDAL automatically, in order.' : 'Enter a song name or a trusted YouTube or Spotify link.';
    $('requestNotice').className = 'notice requestNotice';
    const requesterTable = $('requesters').closest('table'); requesterTable.hidden = tidal; requesterTable.previousElementSibling.hidden = tidal;
    $('queue').closest('table').querySelectorAll('th')[2].textContent = tidal ? 'STATUS' : 'POSITION';
    $('clear').textContent = tidal ? 'CLEAR WAITING REQUESTS' : 'CLEAR QUEUE';
    if ($('tidalQueueTools')) $('tidalQueueTools').hidden = !tidal;

    if (view === 'moderation' || view === 'setup' && !tidal) void refreshCatalog();
    if (tidal) void refreshTidal(); else if (selected() === 'youtube' && view === 'player') ensureYoutubePlayer();
    const staleControls = $('tidalNowControls'); if (staleControls) staleControls.hidden = !tidal;
    void soundcloud.select(); void volumeControls.select();
    void refreshState();
  }
  $('songPlayerProvider').onchange = async () => { const picker = $('songPlayerProvider'); providerReady = true; choosePlayer(); picker.disabled = true; try { const result = await call('song.player.preferences.v1', 'select', { player: picker.value }); if (!result.ok) throw new Error('Could not save your player selection.'); savedPlayer = picker.value; } catch(error) { picker.value = savedPlayer; choosePlayer(); setNotice(error.message, true); } finally { picker.disabled = false; } };
  $('requestForm').onsubmit = submitForPlayer; $('addSong').onclick = submitForPlayer;
  $('monitorTidal').onclick = async () => { $('monitorTidal').disabled = true; try { await call('song.tidal.experimental.v1', 'monitor', {}); setNotice('TIDAL Windows monitoring enabled.'); await refreshState(); } catch (error) { setNotice(error.message, true); } finally { $('monitorTidal').disabled = false; } };
  async function refreshDelivery() { companionCheckedAt = 0; await refreshTidal(); if (selected() === 'tidal') { await call('song.tidal.experimental.v1', 'flush', {}); await refreshTidal(); } }
  $('refreshTidal').onclick = () => void refreshDelivery().catch(error => setNotice(tidalErrorMessage(error), true));
  const refreshPlayer = $('refresh').onclick;
  $('refresh').onclick = () => { refreshPlayer(); if (selected() === 'tidal') void refreshDelivery().catch(error => setNotice(tidalErrorMessage(error), true)); };
  $('installTidalCompanion').onclick = () => manageCompanion('install');
  $('updateTidalCompanion').onclick = () => manageCompanion('update');
  $('uninstallTidalCompanion').onclick = () => manageCompanion('uninstall');
  $('saveTidalCatalog').onclick = () => manageCatalogApi('configure');
  $('resetTidalClient').onclick = () => manageCatalogApi('reset-client');
  $('saveTidalRegion').onclick = () => manageCatalogApi('region');
  $('signInTidal').onclick = signInTidal;
  $('testTidalCatalog').onclick = () => manageCatalogApi('test');
  $('clearTidalCatalog').onclick = () => manageCatalogApi('disconnect');
  window.addEventListener('pagehide', () => { clearTimeout(loginTimer); clearTimeout(tidalRefreshTimer); loginTimer = null; });
  window.addEventListener('focus', () => { if (selected() === 'tidal') void refreshCatalogApi(); });

  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.channel !== CHANNEL || event.data.type !== 'presentation') return;
    $('tidalDeveloperSettings').hidden = event.data.developerMode !== true;
  });
  eventListeners.add(() => { if (view === 'player' && selected() === 'tidal') { clearTimeout(tidalRefreshTimer); tidalRefreshTimer = setTimeout(() => void refreshTidal(), 150); } });
  $('songPlayerProvider').disabled = true; $('playerProviderHint').textContent = 'Restoring your player selection...';
  const playerRestored = (async () => { try { const saved = await call('song.player.preferences.v1', 'status', null); if (!saved.ok) throw new Error('Could not restore your player selection. Choose a player to retry.'); savedPlayer = saved.player; $('songPlayerProvider').value = saved.player; providerReady = true; choosePlayer(); } catch(error) { setNotice(error.message, true); } finally { $('songPlayerProvider').disabled = false; } })();
  let libraryStarting = false;
  window.addEventListener('message', async event => {
    if(event.source!==parent||event.origin!==location.origin||event.data?.channel!==CHANNEL||event.data.type!=='playlist-start'||!['youtube','soundcloud'].includes(event.data.provider)||libraryStarting)return;
    libraryStarting=true;
    try {
      await playerRestored;
      if($('songPlayerProvider').value!==event.data.provider){$('songPlayerProvider').value=event.data.provider;await $('songPlayerProvider').onchange();}
      if($('songPlayerProvider').value!==event.data.provider)throw new Error('Could not select the playlist player.');
      showView('player');
      if(event.data.provider==='soundcloud')await $('soundcloudStart').onclick();
      else {const deadline=Date.now()+12000;while(!playerReady&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));await startPlayer.onclick();}
    }catch(error){setNotice(error.message,true);}finally{libraryStarting=false;}
  });
})();
