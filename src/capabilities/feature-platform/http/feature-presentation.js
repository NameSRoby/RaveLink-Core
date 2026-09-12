function contributionPresentation() {
  const channel = 'ravelink-feature-ui-v1';
  let observer, scheduled = false, lastHeight = 0;
  const report = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!document.body.getBoundingClientRect().width) return;
      const height = Math.ceil(document.body.getBoundingClientRect().height);
      if (height === lastHeight) return;
      lastHeight = height;
      parent.postMessage({ channel, type: 'feature-height', height }, '*');
    });
  };
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel || event.data.type !== 'presentation') return;
    document.documentElement.classList.add('native-feature');
    const theme = event.data.theme || {};
    for (const key of ['bg', 'panel', 'surface', 'accent', 'edge', 'text', 'muted', 'ok', 'warn', 'bad']) {
      if (/^#[0-9a-f]{3,8}$/i.test(theme[key])) document.documentElement.style.setProperty(`--${key}`, theme[key]);
    }
    if (/^#[0-9a-f]{3,8}$/i.test(theme.ok)) document.documentElement.style.setProperty('--good', theme.ok);
    if (/^#[0-9a-f]{3,8}$/i.test(theme.edge)) document.documentElement.style.setProperty('--line', theme.edge);
    if (!observer) { observer = new ResizeObserver(report); observer.observe(document.body); }
    report();
  });
}

const css = `.native-feature,.native-feature body{min-height:0!important;height:auto!important;background:var(--panel,#0b0e18)!important}
.native-feature body{font-family:Rajdhani,"Trebuchet MS",Arial,sans-serif}
.native-feature body>header{background:transparent;border-bottom:1px solid var(--edge);padding:0 0 10px;min-height:40px;height:auto;justify-content:flex-end}
.native-feature body>header h1{display:none}
.native-feature main{min-height:0!important}
.native-feature button{background:var(--surface);border-color:var(--edge);border-radius:7px}
.native-feature button.primary{background:var(--accent);border-color:var(--accent)}
.native-feature .queueSide,.native-feature .appearance,.native-feature .builder{background:transparent}
.native-feature .builder{overflow:visible}
.native-feature .field select,.native-feature .segment-head select{background:var(--bg);border-color:var(--edge)}
.native-feature h1,.native-feature h2,.native-feature button{letter-spacing:0}`;

module.exports = content => String(content).replace('</head>', `<style>${css}</style></head>`)
  .replace('</body>', `<script>(${contributionPresentation.toString()})();</script></body>`);
