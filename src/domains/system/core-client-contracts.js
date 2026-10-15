const crypto = require('node:crypto');

const string = (maxLength = 256) => ({ type: 'string', maxLength });
const bool = { type: 'boolean' };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties, required = [], additionalProperties = false) => ({ type: 'object', properties, required, additionalProperties });
const success = (properties = {}, required = []) => object({ ok: { const: true }, ...properties }, ['ok', ...required], true);
const id = { ...string(256), minLength: 1 };
const empty = object({});
const capabilities = object({ lightingCore: bool, features: bool, mods: bool, widget: bool, songRequest: bool }, ['lightingCore'], true);
const fixture = object({ id, name: string(512), brand: string(32), zone: string(256), enabled: bool,
  engineEnabled: bool, twitchEnabled: bool, customEnabled: bool, lightId: count,
  bridgeIpConfigured: bool, deviceIpConfigured: bool, credentialsConfigured: bool, entertainmentConfigured: bool,
  temperatureRange: object({ minimumKelvin: count, maximumKelvin: count }, ['minimumKelvin', 'maximumKelvin'])
}, ['id', 'name', 'brand', 'enabled', 'credentialsConfigured'], true);
const fixtureInput = object({ id, name: string(512), brand: { enum: ['hue', 'wiz', 'govee'] }, zone: string(256),
  enabled: bool, engineEnabled: bool, twitchEnabled: bool, customEnabled: bool,
  ip: string(256), bridgeIp: string(256), lightId: count, username: string(512), clientKey: string(512),
  bridgeId: string(256), entertainmentAreaId: string(256)
}, ['id', 'brand']);
const version = string(64);
const nullable = properties => ({ ...object(properties, Object.keys(properties)), type: ['object', 'null'] });
const updateStatus = success({ currentVersion: version, checkOnLaunch: bool, checking: bool, downloading: bool,
  latest: nullable({ version, name: string(512), publishedAt: string(64), available: bool }),
  staged: nullable({ version, verified: bool }), rollback: nullable({ version }), hosted: bool, lastError: string(2048)
}, ['currentVersion', 'checkOnLaunch', 'checking', 'downloading', 'latest', 'staged', 'rollback', 'hosted', 'lastError']);
const widgetInput = object({ baseUrl: string(2048), colorRewardId: string(512), teachRewardId: string(512), songRewardId: string(512), widgetIntakeToken: string(512) });
const widgetOutput = success({ script: string(131072), active: widgetInput,
  warnings: { type: 'array', maxItems: 16, items: object({ code: string(128), severity: string(32), message: string(2048) }, ['code', 'message'], true) }, oneTimeReveal: bool
}, ['script', 'active', 'warnings']);
const delivery = object({ sent: count, failed: count }, ['sent', 'failed'], true);
const widgetSecurity = object({ contract: string(80), configured: bool, scopedTokenConfigured: bool, crossOriginEnabled: bool,
  allowedOrigins: { type: 'array', maxItems: 8, items: string(2048) }, source: string(64), error: string(256)
}, ['configured'], true);
function operation(id, method, legacyPath, request, response, readOnly = false, deadlineMs = 5000) {
  return { id, method, path: `/api/core/v1/${id}`, legacyPath, request, response, readOnly, deadlineMs, automaticRetry: readOnly ? 'read-only' : 'never' };
}
const operations = [
  operation('health', 'GET', '/health', { type: 'null' }, success({ version, profile: string(128), capabilities }, ['version', 'profile', 'capabilities']), true, 2000),
  operation('fixtures.list', 'GET', '/fixtures', { type: 'null' }, success({ version: count, fixtures: { type: 'array', maxItems: 256, items: fixture }, connectivity: { type: 'object' } }, ['version', 'fixtures', 'connectivity']), true),
  operation('fixtures.edit', 'POST', '/fixtures/:id/edit', object({ id }, ['id']), success({ fixture: object({ id, name: string(512), brand: string(32), zone: string(256), ip: string(256), bridgeIp: string(256), lightId: count, enabled: bool, engineEnabled: bool, twitchEnabled: bool, customEnabled: bool }, ['id', 'brand'], true), oneTimeReveal: { const: true } }, ['fixture', 'oneTimeReveal']), true),
  operation('fixtures.upsert', 'POST', '/fixtures', fixtureInput, success({ fixture }, ['fixture'])),
  operation('fixtures.delete', 'POST', '/fixtures/:id', object({ id }, ['id']), success({ deleted: id }, ['deleted'])),
  operation('fixtures.test', 'POST', '/fixtures/:id/test', object({ id }, ['id']), success({ reachable: bool, fixture: object({ id, name: string(512), brand: string(32) }, ['id', 'brand'], true) }), true, 15000),
  operation('lights.apply', 'POST', '/color', object({ text: { ...string(1024), minLength: 1 }, target: { enum: ['hue', 'wiz', 'govee', 'both'] }, fixtureId: id,
    fixtureIds: { type: 'array', minItems: 1, maxItems: 64, items: id }, groupId: id, zone: string(256), hueZone: string(256), wizZone: string(256), goveeZone: string(256)
  }, ['text']), success({ sent: count, failed: count, partial: bool, hueDelivery: delivery, wizDelivery: delivery, goveeDelivery: delivery }, ['sent', 'failed', 'partial']), false, 15000),
  operation('widget.status', 'GET', '/system/status', { type: 'null' }, success({ widgetSecurity }, ['widgetSecurity']), true),
  operation('widget.get', 'POST', '/system/widget-template-get', widgetInput, widgetOutput, true),
  operation('widget.rebuild', 'POST', '/system/widget-template-rebuild', widgetInput, widgetOutput),
  operation('widget.clear-token', 'POST', '/system/widget-token/clear', empty, success({ widgetSecurity }, ['widgetSecurity'])),
  operation('updates.status', 'GET', '/system/update/status', { type: 'null' }, updateStatus, true),
  operation('updates.configure', 'POST', '/system/update/configure', object({ checkOnLaunch: bool }, ['checkOnLaunch']), updateStatus),
  operation('updates.check', 'POST', '/system/update/check', empty, updateStatus, false, 15000),
  operation('updates.download', 'POST', '/system/update/download', empty, updateStatus, false, 180000),
  operation('updates.apply', 'POST', '/system/update/apply', empty, success({ action: string(32), stopping: bool }, ['action', 'stopping'])),
  operation('updates.rollback', 'POST', '/system/update/rollback', empty, success({ action: string(32), stopping: bool }, ['action', 'stopping']))
];
const error = object({ ok: { const: false }, error: string(2048), code: string(128) }, ['ok'], true);
const document = { schemaVersion: 1, protocol: 'ravelink.core.client', apiVersion: { major: 1, minor: 0 },
  limits: { requestBytes: 65536, responseBytes: 524288, jsonDepth: 12, jsonNodes: 16384 },
  error, operations };
const manifestProperties = { ok: bool, protocol: { const: document.protocol }, apiVersion: object({ major: count, minor: count }, ['major', 'minor']),
  contractRevision: { ...string(64), minLength: 64 }, serverInstanceId: string(64), server: operations[0].response,
  contractsUrl: string(256), operations: { type: 'array', maxItems: 64, items: string(80) },
  limits: object(Object.fromEntries(Object.keys(document.limits).map(key => [key, count])), Object.keys(document.limits)) };
document.handshake = {
  get: { method: 'GET', path: '/system/client-api', response: object(manifestProperties, Object.keys(manifestProperties), true) },
  negotiate: { method: 'POST', path: '/system/client-api/negotiate', request: object({ apiMajor: { type: 'integer', minimum: 0, maximum: 10000 },
    minimumMinor: { type: 'integer', minimum: 0, maximum: 10000 }, requiredOperations: { type: 'array', maxItems: 64, items: string(80) }
  }, ['apiMajor']), response: object({ ...manifestProperties, compatible: bool, missingOperations: { type: 'array', maxItems: 64, items: string(80) }, error: string(128) }, [...Object.keys(manifestProperties), 'compatible', 'missingOperations'], true) }
};
const revision = crypto.createHash('sha256').update(JSON.stringify(document)).digest('hex');
function freeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);for (const child of Object.values(value)) freeze(child, seen);Object.freeze(value);
}
freeze(document);
module.exports = { document, revision, object, string };
