function installSpotifyAccount({ setup, api, action, refresh, explain }) {
  const desktop = document.createElement('div');desktop.id = 'spotifyDesktopSetup';desktop.append(...setup.childNodes);
  const companion = document.createElement('details');companion.id = 'spotifyCompanionSetup';companion.open = true;
  const companionTitle = document.createElement('summary');companionTitle.textContent = 'Desktop companion: free queue control';companion.append(companionTitle, desktop);
  const account = document.createElement('details');account.id = 'spotifyOfficialSetup';
  account.innerHTML = '<summary>Optional Spotify Premium connection</summary><p>Use the companion for native queue control and connect Premium for official search and playback controls. Both work together on the same device. RaveLink adds no developer-kit charge.</p><p id="spotifyAccountStatus" role="status"></p><div class="actions"><button id="spotifySignIn" class="primary">Sign in with Spotify</button><button id="spotifyAccountCheck">Check connection</button><button id="spotifyDisconnect">Disconnect account</button></div><a id="spotifySignInLink" target="_blank" rel="noopener noreferrer" hidden>Open Spotify sign-in</a><details id="spotifyAppSetup"><summary>Developer app setup</summary><p>Create a free app at <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener noreferrer">Spotify Developer</a>. Its owner needs Premium. Development apps support five allowlisted users; add your account under Users and Access. Register this exact redirect URI:</p><code id="spotifyCallbackUri"></code><p><label>Client ID<input id="spotifyClientId" type="password" maxlength="32" autocomplete="off" spellcheck="false" placeholder="Write-only client ID"></label></p><button id="spotifySaveClient">Save app setup</button><p>Your client ID and account tokens are encrypted on this PC. No client secret is required.</p></details><section><h3>Playback device</h3><p>Open Spotify on the device you want to control. Refresh, choose it below, and start playback there if it is inactive.</p><button id="spotifyDevices">Refresh devices</button><div id="spotifyDeviceChoices" class="actions" role="group" aria-label="Spotify playback devices"></div><p id="spotifyDeviceStatus" role="status"></p></section>';
  setup.append(companion, account);
  const note = document.createElement('p');note.id = 'spotifyOfficialLimit';note.className = 'notice';note.hidden = true;
  note.textContent = 'Official-only queue entries cannot be removed individually. Bans and timeouts still block future requests, and the current song can be skipped. Keep the companion connected for full queue control on future requests.';
  $('queueHeading').after(note);
  const redirect = new URL(location.origin);redirect.hostname = '127.0.0.1';redirect.pathname = '/auth/spotify/callback';$('spotifyCallbackUri').textContent = redirect.href;
  let current = null, devices = [], configuredBefore, connectedBefore;
  function render(state) {
    current = state;const official = state.mode === 'official';
    note.hidden = !official && !state.handoffs?.some(row => row.transport === 'official' && ['appended', 'unknown', 'pending'].includes(row.phase));
    if (connectedBefore !== Boolean(state.account?.connected)) { connectedBefore = Boolean(state.account?.connected);account.open = connectedBefore;companion.open = !connectedBefore || state.sameDevice; }
    const hasRequests = state.queue?.length || state.handoffs?.some(row => ['pending', 'unknown', 'appended', 'playing'].includes(row.phase));
    const officialRequests = state.handoffs?.some(row => row.transport === 'official' && ['pending', 'unknown', 'appended', 'playing'].includes(row.phase));
    $('spotifyAccountStatus').textContent = state.account?.connected ? state.lastError ? explain(state.lastError) : 'Account connected. Choose a playback device below.' : state.account?.configured ? 'App configured. Sign in to connect your Premium account.' : 'Add your developer app once, then sign in with Spotify.';
    if (configuredBefore !== state.account?.configured) { configuredBefore = state.account?.configured;$('spotifyAppSetup').open = !configuredBefore; }
    $('spotifySignIn').disabled = !state.account?.configured;$('spotifyDisconnect').disabled = !state.account?.connected || Boolean(officialRequests);
    for (const button of $('spotifyDeviceChoices').children) { button.setAttribute('aria-pressed', String(button.dataset.device === state.selectedDevice));button.disabled = Boolean(hasRequests) && button.dataset.device !== state.selectedDevice; }
    $('spotifyDeviceStatus').textContent = state.selectedDevice ? state.sameDevice ? 'Combined connection: companion queue control and official Premium controls.' : state.officialControls ? 'Selected device is active. Official controls are available.' : 'Selected device is not active. Start playback there to connect it.' : 'Choose the device that should receive requests.';
    const heading = $('spotifyPlayback').querySelector('h2');const text = [...heading.childNodes].find(node => node.nodeType === Node.TEXT_NODE);if (text) text.textContent = 'Spotify';
    $('playerProviderHint').textContent = official ? 'Official Spotify API · requests queue on your selected device' : 'Search songs · queue in order in Spotify Desktop';
    $('spotifyPlayback').querySelector('.actions').title = official ? 'Controls the selected Spotify Connect device' : 'Controls Spotify Desktop';
  }
  $('spotifySaveClient').onclick = async event => { await action(event.currentTarget, 'setup', { action: 'configure', clientId: $('spotifyClientId').value.trim() }, 'App setup saved. Sign in with Spotify.');$('spotifyClientId').value = ''; };
  $('spotifyDisconnect').onclick = event => action(event.currentTarget, 'setup', { action: 'disconnect' }, 'Spotify account disconnected locally.');
  $('spotifyAccountCheck').onclick = () => refresh();
  $('spotifySignIn').onclick = async event => {
    const button = event.currentTarget;button.disabled = true;
    try {
      const result = await api('setup', { action: 'begin', redirectUri: redirect.href });if (!result.ok) throw Error(result.error);
      const url = new URL(result.authorizationUrl);if (url.origin !== 'https://accounts.spotify.com' || url.pathname !== '/authorize') throw Error('Invalid Spotify sign-in address.');
      const link = $('spotifySignInLink');link.href = url.href;link.hidden = false;link.click();setNotice('Finish sign-in in Spotify, then choose Check connection. If no window opened, use Open Spotify sign-in.');
    } catch (error) { setNotice(explain(error.message), true); } finally { button.disabled = false; }
  };
  $('spotifyDevices').onclick = async event => {
    const button = event.currentTarget;button.disabled = true;
    try {
      const result = await api('setup', { action: 'devices' });if (!result.ok) throw Error(result.error);devices = result.devices;
      $('spotifyDeviceChoices').replaceChildren(...devices.map(device => {
        const choice = document.createElement('button');choice.type = 'button';choice.dataset.device = device.id;choice.textContent = device.name + (device.active ? ' · active' : '');
        choice.onclick = event => action(event.currentTarget, 'setup', { action: 'select-device', deviceId: device.id }, 'Playback device selected.');return choice;
      }));if (current) render(current);setNotice(devices.length ? 'Devices refreshed. Choose where requests should play.' : 'No available devices. Open Spotify, then refresh again.');
    } catch (error) { setNotice(explain(error.message), true); } finally { button.disabled = false; }
  };
  const style = document.createElement('style');style.textContent = '#spotifyCompanionSetup,#spotifyOfficialSetup{padding:12px 0}#spotifyCompanionSetup>summary,#spotifyOfficialSetup>summary{cursor:pointer;font-weight:700;font-size:14px}#spotifyCompanionSetup[open]>summary,#spotifyOfficialSetup[open]>summary{margin-bottom:14px}#spotifyOfficialSetup p{line-height:1.5;color:var(--muted)}#spotifyOfficialSetup h2{margin-top:18px}#spotifyAppSetup{margin:16px 0;padding:12px;border:1px solid var(--edge);border-radius:8px}#spotifyAppSetup label{display:grid;gap:6px;max-width:340px}#spotifyCallbackUri{display:block;overflow-wrap:anywhere;font-size:12px}#spotifyDeviceChoices button[aria-pressed=true]{border-color:var(--player-accent,#1ed760);background:color-mix(in srgb,var(--player-accent,#1ed760) 10%,var(--panel))}#spotifyOfficialLimit{font-size:12px;line-height:1.5;color:var(--muted)}';document.head.append(style);
  return { render };
}
