window.PlaylistProviderUI = (() => {
  const labels = { youtube: 'YouTube', tidal: 'TIDAL', soundcloud: 'SoundCloud (Alpha)', csv: 'CSV file', library: 'RaveLink library', local: 'RaveLink library' };
  const colors = { youtube: '#ff6978', tidal: '#c3d6f2', soundcloud: '#ff9655', csv: '#6ed9aa', library: '#bda5ff', local: '#bda5ff' };
  function mark(provider) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('providerMark');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', window.PlaylistProviders[provider] || (provider === 'csv' ? 'M5 2h10l5 5v15H5V2zm2 2v16h11V8h-5V4H7zm8 1v1h1l-1-1zM9 11h7v2H9zm0 4h7v2H9z' : 'M3 4h18v4H3V4zm0 6h18v4H3v-4zm0 6h18v4H3v-4z'));
    path.setAttribute('fill', 'currentColor'); svg.append(path); return svg;
  }
  function badge(provider) {
    const node = document.createElement('span'); node.className = 'providerBadge'; node.dataset.provider = provider;
    node.style.setProperty('--provider-color', colors[provider] || colors.library);
    node.append(mark(provider), document.createTextNode(labels[provider] || 'Mixed sources')); return node;
  }
  function card(provider, detail, onClick) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'providerChoice'; button.dataset.provider = provider; button.setAttribute('aria-label', labels[provider]);
    button.style.setProperty('--provider-color', colors[provider] || colors.library);
    const description = document.createElement('span'); description.className = 'providerDescription'; description.textContent = detail;
    button.append(badge(provider), description); button.onclick = onClick; return button;
  }
  const style = document.createElement('style');
  style.textContent = '.providerMark{width:22px;height:22px;flex:none}.providerBadge{display:inline-flex;align-items:center;gap:8px;color:var(--provider-color);font-size:13px;font-weight:700;line-height:1.4}.providerChoices{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:14px 0 20px}.providerChoice{height:auto!important;min-height:92px;padding:15px!important;text-align:left!important;white-space:normal;background:var(--surface,#101724);border:1px solid var(--edge);border-top:3px solid var(--provider-color);border-radius:9px}.providerChoice .providerDescription{display:block;color:var(--muted);font-size:12px;font-weight:400;line-height:1.5;margin-top:8px}.providerChoice[aria-pressed=true]{border-color:var(--provider-color);box-shadow:inset 0 0 0 1px var(--provider-color)}.providerChoice[aria-pressed=true] .providerDescription::after{content:" · Selected";font-weight:700;color:var(--provider-color)}.providerChoice:hover:not(:disabled){border-color:var(--provider-color)}.providerChoice:focus-visible{outline:2px solid var(--provider-color);outline-offset:3px}.providerBadge .providerMark{width:19px;height:19px}@media(max-width:520px){.providerChoices{grid-template-columns:repeat(2,minmax(0,1fr))}.providerChoice{padding:11px!important;min-height:90px}.providerBadge{font-size:12px;gap:6px}}';
  document.head.append(style); return { badge, card, labels };
})();
