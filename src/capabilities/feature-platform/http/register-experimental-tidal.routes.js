const { isLocalOrSameHostRequest } = require('../../../app/runtime/request-security.middleware');
const path = require('node:path');
module.exports = function registerExperimentalTidal(app, { bridge, registry, rootDir }) {
  const local = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: 'local_request_required' });
    if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) return res.status(403).json({ ok: false, error: 'origin_invalid' });
    next();
  };
  const companion = (req, res, next) => {
    if (req.headers.origin || !bridge.authorized(/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1])) return res.status(403).json({ ok: false, error: 'tidal_pairing_required' });
    next();
  };
  app.get('/experimental/tidal', local, (_req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'");
    res.sendFile(path.join(rootDir, 'experiments/tidal-luna/operator.html'));
  });
  app.get('/experimental/tidal/plugin/:asset', (req, res) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.sendStatus(403);
    if (!['ravelink.tidal-experiment.json', 'ravelink.tidal-experiment.mjs'].includes(req.params.asset)) return res.sendStatus(404);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(rootDir, 'experiments/tidal-luna/dist', req.params.asset));
  });
  app.post('/experimental/tidal/action', local, async (req, res) => {
    if (!['status', 'submit', 'handoff', 'review', 'monitor'].includes(req.body?.method)) return res.status(400).json({ ok: false, error: 'tidal_method_invalid' });
    const payload = req.body.method === 'status' ? null : req.body.payload || {};
    const result = await registry.request('song-request', 'song.tidal.experimental.v1', req.body.method, payload, { timeoutMs: 20000 });
    res.status(result.ok ? 200 : 503).json(result.ok ? result.value : { ok: false, error: result.error?.code || 'song_request_unavailable' });
  });
  app.post('/experimental/tidal/bridge/next', local, companion, (req, res) => res.json(bridge.poll(req.body)));
  app.post('/experimental/tidal/bridge/result', local, companion, (req, res) => res.json(bridge.complete(req.body)));
};
