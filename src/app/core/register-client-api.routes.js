const crypto = require('node:crypto');
const { document, revision } = require('../../domains/system/core-client-contracts');
const { validateValue } = require('../../shared/contracts/bounded-json-schema');
const { isLocalOrSameHostRequest } = require('../runtime/request-security.middleware');

function bounded(value, maximumBytes) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > document.limits.jsonNodes || depth > document.limits.jsonDepth) return false;
    if (item && typeof item === 'object') return Object.values(item).every(child => visit(child, depth + 1));
    return typeof item !== 'number' || Number.isFinite(item);
  };
  try { return visit(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= maximumBytes; }
  catch { return false; }
}
module.exports = function registerClientApiRoutes(app, { getHealth }) {
  const instanceId = crypto.randomUUID();
  const negotiation = document.handshake.negotiate.request;
  const manifest = () => ({ ok: true, protocol: document.protocol, apiVersion: document.apiVersion, contractRevision: revision,
    serverInstanceId: instanceId, server: getHealth(), contractsUrl: '/system/client-api/contracts', operations: document.operations.map(({ id }) => id), limits: document.limits });
  const local = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-RaveLink-Client-API', '1.0');
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: 'local_request_required' });
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).origin !== `${req.protocol}://${req.headers.host}`) return res.status(403).json({ ok: false, error: 'client_api_origin_invalid' }); }
      catch { return res.status(403).json({ ok: false, error: 'client_api_origin_invalid' }); }
    }
    next();
  };
  app.get('/system/client-api', local, (_req, res) => res.json(manifest()));
  app.get('/system/client-api/contracts', local, (_req, res) => res.json({ ...document, contractRevision: revision }));
  app.post('/system/client-api/negotiate', local, (req, res) => {
    if (!bounded(req.body, 8192) || !validateValue(negotiation, req.body)) return res.status(400).json({ ok: false, error: 'client_api_request_invalid' });
    const missingOperations = [...new Set(req.body.requiredOperations || [])].filter(id => !document.operations.some(operation => operation.id === id));
    const compatible = req.body.apiMajor === document.apiVersion.major && (req.body.minimumMinor || 0) <= document.apiVersion.minor && !missingOperations.length;
    res.status(compatible ? 200 : 409).json({ ...manifest(), ok: compatible, compatible, missingOperations, ...(!compatible ? { error: 'client_api_incompatible' } : {}) });
  });
  for (const operation of document.operations) {
    app[operation.method.toLowerCase()](operation.path, local, (req, res, next) => {
      const payload = operation.method === 'GET' ? (req.body ?? null) : req.body;
      if (!bounded(payload, document.limits.requestBytes) || !validateValue(operation.request, payload)) return res.status(400).json({ ok: false, error: 'client_api_request_invalid', operation: operation.id });
      req.coreClientApiOperation = operation.id;
      const json = res.json.bind(res);
      res.json = value => {
        res.setHeader('Cache-Control', 'no-store');
        if (operation.id === 'widget.status' && value?.ok === true) value = { ok: true, widgetSecurity: value.widgetSecurity };
        const schema = value?.ok === false ? document.error : operation.response;
        if (!bounded(value, document.limits.responseBytes) || !validateValue(schema, value)) {
          res.status(502);
          return json({ ok: false, error: 'client_api_response_invalid', operation: operation.id, outcome: operation.readOnly ? 'unavailable' : 'unknown' });
        }
        return json(value);
      };
      req.url = operation.legacyPath.replace(':id', encodeURIComponent(payload?.id || ''));
      if (operation.id === 'fixtures.edit') { req.method = 'GET'; req.body = undefined; }
      if (operation.id === 'fixtures.delete') { req.method = 'DELETE'; req.body = undefined; }
      if (operation.id === 'fixtures.test') req.body = {};
      next();
    });
  }
  app.use('/api/core/v1', local, (_req, res) => res.status(404).json({ ok: false, error: 'client_api_operation_unknown' }));
};

module.exports.errorHandler = (error, req, res, next) => {
  if (!req.coreClientApiOperation || res.headersSent) return next(error);
  const known = new Map([
    ['windows_host_required', 409], ['verified_update_required', 409], ['rollback_unavailable', 409],
    ['update_check_in_progress', 409], ['update_download_in_progress', 409], ['update_helper_missing', 503]
  ]);
  const code = known.has(error.message) ? error.message : 'internal_error';
  res.status(known.get(code) || 500).json({ ok: false, error: code, operation: req.coreClientApiOperation });
};
