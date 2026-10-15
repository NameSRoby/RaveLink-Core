// OAuth redirects are cross-site top-level GETs. Only this narrow route admits
// them; local socket/Host checks and single-use PKCE state guard the exchange.
module.exports = function registerTidalOAuth(app, getCatalog) {
  const callbackPath = '/auth/tidal/callback';
  const local = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      || req.headers.host !== `127.0.0.1:${req.socket.localPort}`) return res.status(403).send('Local callback required.');
    next();
  };
  app.get(callbackPath, local, async (req, res) => {
    const params = new URL(req.originalUrl, 'http://127.0.0.1').searchParams;
    // Reject repeated fields rather than accepting one ambiguous value.
    if (['state', 'code', 'error'].some(key => params.getAll(key).length > 1)) return res.status(400).send('Invalid TIDAL callback.');
    const input = Object.fromEntries(['state', 'code', 'error'].filter(key => params.has(key)).map(key => [key, params.get(key)]));
    try {
      const result = await getCatalog().callback(input, `http://127.0.0.1:${req.socket.localPort}${callbackPath}`);
      // Remove the authorization code/state from the address before rendering.
      res.redirect(303, '/auth/tidal/result?result=' + (result.ok ? 'connected' : encodeURIComponent(result.error)));
    } catch { res.redirect(303, '/auth/tidal/result?result=tidal_oauth_exchange_failed'); }
  });
  app.get('/auth/tidal/result', local, (req, res) => {
    const messages = {
      connected: 'TIDAL connected. Return to RaveLink and refresh the account status. You can close this window.',
      tidal_oauth_denied: 'Sign-in cancelled. Return to RaveLink to try again.',
      tidal_oauth_state_invalid: 'This callback does not match the active sign-in. Start a new sign-in from RaveLink.',
      tidal_oauth_session_expired: 'Sign-in expired or already used. Start a new sign-in from RaveLink.',
      tidal_oauth_exchange_rejected: 'TIDAL rejected the sign-in exchange. Check the registered redirect URI and OAuth access for this app. No developer secret is sent.',
      tidal_oauth_scope_missing: 'TIDAL did not grant search.read. Enable it for the app and sign in again.',
      tidal_catalog_vault_write_failed: 'Core could not securely save the account tokens. Sign-in was not completed.'
    };
    const message = typeof req.query.result === 'string' && Object.hasOwn(messages, req.query.result)
      ? messages[req.query.result] : 'TIDAL sign-in failed. Return to RaveLink and try again.';
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RaveLink · TIDAL</title><style>body{background:#10131c;color:#f4f5f7;font:18px system-ui;margin:48px;max-width:640px;line-height:1.6}</style></head><body><h1>TIDAL sign-in</h1><p>${message}</p></body></html>`);
  });
};
