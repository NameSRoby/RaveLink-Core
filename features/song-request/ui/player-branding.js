// Shared provider marks stay local; styling never changes playback controls.
function applyPlayerBranding(provider) {
  document.body.dataset.playerProvider = provider;
  const headings = { tidal: '#tidalPlayer h2,#tidalPlayback h2', spotify: '#spotifySetup h2,#spotifyPlayback h2', soundcloud: '#soundcloudPlayer h2,#soundcloudSetup h2' };
  for (const [name, selector] of Object.entries(headings)) {
    for (const heading of document.querySelectorAll(selector)) {
      if (heading.querySelector('.playerProviderMark')) continue;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');svg.setAttribute('aria-hidden', 'true');
      svg.classList.add('playerProviderMark');svg.dataset.provider = name;
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', window.PlaylistProviders[name]);path.setAttribute('fill', 'currentColor');svg.append(path);heading.prepend(svg);
    }
  }
}

// Visible-choice buttons are created by Core after the player mounts. CSS masks
// keep their existing text, radio semantics, focus behavior and click handlers.
(() => {
  const colors = { youtube: '#ff6978', tidal: '#dce8ed', spotify: '#1ed760', soundcloud: '#ff9655' };
  const style = document.createElement('style');
  style.textContent = Object.entries(colors).map(([name, color]) => {
    const icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="' + window.PlaylistProviders[name] + '"/></svg>');
    const selector = '[data-choice-for="songPlayerProvider"] [data-choice-value="' + name + '"]';
    return selector + '{--brand-color:' + color + '}' + selector + '::before{mask-image:url("' + icon + '")}';
  }).join('');
  document.head.append(style);
})();
