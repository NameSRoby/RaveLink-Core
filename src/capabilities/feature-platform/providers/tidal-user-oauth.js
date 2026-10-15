const fs = require('node:fs');
const crypto = require('node:crypto');
const { protectTextMapWithWindowsDpapi, unprotectTextMapWithWindowsDpapi } = require('../../../shared/security/windows-dpapi');
const { readJsonFileWithMetadata, writeJsonFile } = require('../../../shared/fs/json-file-store');

// This is a public application identifier, never a client secret.
const PUBLIC_CLIENT_ID = 'sJO65HgFy1MmZi7i';
const CALLBACK_PATH = '/auth/tidal/callback';
const SCOPES = 'search.read';
const PLAYLIST_SCOPES = ['search.read', 'playlists.read', 'playlists.write'];
const TRANSFER_SCOPES = [...PLAYLIST_SCOPES, 'collection.read', 'collection.write'];
const COUNTRIES = require('./tidal-catalog-countries.json').countries;
const COUNTRY_CODES = new Set(COUNTRIES.map(row => row.code));
module.exports = function createTidalUserOAuth(options = {}) {
  const now = options.now || Date.now, protect = options.protect || protectTextMapWithWindowsDpapi;
  const unprotect = options.unprotect || unprotectTextMapWithWindowsDpapi;
  let clientId = options.clientId || PUBLIC_CLIENT_ID, countryCode = 'US', accessToken = '', refreshToken = '', expiresAt = 0;
  let grantedScopes = [SCOPES];
  let generation = 0, pending = null, refreshWork = null, lastError = '';
  function persist(next) {
    if (!options.vaultPath) return;
    const encrypted = protect({ accessToken: next.accessToken, refreshToken: next.refreshToken });
    if (!encrypted.ok) throw new Error('tidal_catalog_vault_write_failed');
    try { writeJsonFile(options.vaultPath, { version: 2, clientId: next.clientId, countryCode: next.countryCode, expiresAt: next.expiresAt, scopes: next.scopes || grantedScopes, encrypted: encrypted.encrypted }, { mode: 0o600, backup: false }); }
    catch { throw new Error('tidal_catalog_vault_write_failed'); }
  }
  try {
    if (options.vaultPath && fs.existsSync(options.vaultPath)) {
      const stored = readJsonFileWithMetadata(options.vaultPath, {}).value;
      if (stored.version !== 2) {
        // Discard the old developer-secret setup without decrypting it.
        if (COUNTRY_CODES.has(stored.countryCode)) countryCode = stored.countryCode;
        persist({ clientId, countryCode, accessToken: '', refreshToken: '', expiresAt: 0 });
      } else {
        if (!/^[A-Za-z0-9_-]{8,160}$/.test(stored.clientId)) throw new Error('invalid');
        const decoded = unprotect(stored.encrypted || {});
        if (!decoded.ok) throw new Error('invalid');
        clientId = stored.clientId; countryCode = COUNTRY_CODES.has(stored.countryCode) ? stored.countryCode : 'US';
        accessToken = decoded.plain.accessToken || ''; refreshToken = decoded.plain.refreshToken || '';
        if (accessToken.length > 8192 || refreshToken.length > 8192 || !Number.isFinite(stored.expiresAt)) throw new Error('invalid');
        expiresAt = stored.expiresAt;
        grantedScopes = Array.isArray(stored.scopes) ? stored.scopes.filter(value => TRANSFER_SCOPES.includes(value)) : [SCOPES];
      }
    }
  } catch { accessToken = ''; refreshToken = ''; expiresAt = 0; lastError = 'tidal_catalog_vault_invalid'; }
  const status = () => ({ ok: true, configured: Boolean(clientId), clientIdSource: clientId === PUBLIC_CLIENT_ID ? 'bundled' : 'custom', countryCode, authMode: 'user-pkce',
    authenticated: Boolean(accessToken && expiresAt > now()), connected: Boolean(refreshToken || accessToken && expiresAt > now()),
    pending: Boolean(pending && pending.until > now()), lastError, scopes: [...grantedScopes], playlistsEnabled: PLAYLIST_SCOPES.every(value => grantedScopes.includes(value)), collectionsEnabled: ['collection.read', 'collection.write'].every(value => grantedScopes.includes(value)), countries: COUNTRIES.map(row => ({ ...row })) });
  function configure(input = {}) {
    if (input.clientSecret !== undefined) return { ok: false, error: 'tidal_client_secret_not_supported' };
    const id = input.clientId === undefined ? clientId : String(input.clientId).trim();
    const country = input.countryCode === undefined ? countryCode : String(input.countryCode).toUpperCase();
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(id)) return { ok: false, error: 'tidal_catalog_credentials_invalid' };
    if (!COUNTRY_CODES.has(country)) return { ok: false, error: 'tidal_catalog_country_invalid' };
    const changed = id !== clientId;
    const next = { clientId: id, countryCode: country, accessToken: changed ? '' : accessToken, refreshToken: changed ? '' : refreshToken, expiresAt: changed ? 0 : expiresAt };
    try { persist(next); } catch (error) { return { ok: false, error: error.message }; }
    clientId = id; countryCode = country; accessToken = next.accessToken; refreshToken = next.refreshToken; expiresAt = next.expiresAt;
    generation++; pending = null; refreshWork = null; lastError = ''; return status();
  }
  function disconnect() {
    try { persist({ clientId, countryCode, accessToken: '', refreshToken: '', expiresAt: 0 }); }
    catch (error) { return { ok: false, error: error.message }; }
    accessToken = ''; refreshToken = ''; expiresAt = 0; generation++; pending = null; refreshWork = null; lastError = ''; return status();
  }
  function begin(input = {}) {
    let redirect;
    try { redirect = new URL(input.redirectUri); } catch { return { ok: false, error: 'tidal_oauth_redirect_invalid' }; }
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.pathname !== CALLBACK_PATH
      || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) return { ok: false, error: 'tidal_oauth_redirect_invalid' };
    generation++; refreshWork = null;
    const verifier = crypto.randomBytes(32).toString('base64url'), state = crypto.randomBytes(32).toString('base64url');
    pending = { verifier, state, redirectUri: redirect.href, until: now() + 300000, revision: generation, scopes: input.playlists === true ? TRANSFER_SCOPES : [SCOPES] };
    const url = new URL('https://login.tidal.com/authorize');
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirect.href,
      scope: pending.scopes.join(' '), code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), state })) url.searchParams.set(key, value);
    lastError = ''; return { ok: true, authorizationUrl: url.href, redirectUri: redirect.href };
  }
  async function saveToken(reply, revision, fallbackRefresh = '', requestedScopes = grantedScopes) {
    if (revision !== generation) throw new Error('tidal_catalog_configuration_changed');
    if (typeof reply.access_token !== 'string' || !reply.access_token || reply.access_token.length > 8192
      || !Number.isFinite(Number(reply.expires_in)) || Number(reply.expires_in) < 1
      || reply.refresh_token !== undefined && (typeof reply.refresh_token !== 'string' || !reply.refresh_token || reply.refresh_token.length > 8192)
      || reply.token_type && String(reply.token_type).toLowerCase() !== 'bearer') throw new Error('tidal_catalog_response_invalid');
    if (reply.scope !== undefined && (typeof reply.scope !== 'string' || !requestedScopes.every(value => reply.scope.split(/\s+/).includes(value)))) throw new Error('tidal_oauth_scope_missing');
    const next = { clientId, countryCode, accessToken: reply.access_token, refreshToken: reply.refresh_token || fallbackRefresh,
      scopes: typeof reply.scope === 'string' ? reply.scope.split(/\s+/).filter(value => TRANSFER_SCOPES.includes(value)) : requestedScopes,
      expiresAt: now() + Math.min(Number(reply.expires_in), 86400) * 1000 };
    persist(next); accessToken = next.accessToken; refreshToken = next.refreshToken; expiresAt = next.expiresAt; grantedScopes = next.scopes; lastError = '';
    return accessToken;
  }
  async function tokenRequest(fields, signal) {
    return options.json('https://auth.tidal.com/v1/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, scope: grantedScopes.join(' '), ...fields }) }, signal);
  }
  async function callback(input = {}, redirectUri) {
    const session = pending;
    if (!session || session.until <= now()) { pending = null; return { ok: false, error: 'tidal_oauth_session_expired' }; }
    if (typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || !crypto.timingSafeEqual(Buffer.from(input.state), Buffer.from(session.state))
      || redirectUri !== session.redirectUri) return { ok: false, error: 'tidal_oauth_state_invalid' };
    pending = null; // One attempt: no callback replay, including a failed exchange.
    if (input.error !== undefined) { lastError = 'tidal_oauth_denied'; return { ok: false, error: lastError }; }
    if (typeof input.code !== 'string' || !input.code || input.code.length > 4096) return { ok: false, error: 'tidal_oauth_code_invalid' };
    try {
      const operation = async () => saveToken(await tokenRequest({ grant_type: 'authorization_code', code: input.code,
        code_verifier: session.verifier, redirect_uri: session.redirectUri, scope: session.scopes.join(' ') }, AbortSignal.timeout(10000)), session.revision, '', session.scopes);
      if (options.egressGovernor?.run) await options.egressGovernor.run({ owner: 'provider.external', priority: 'optional', queueDeadlineMs: 500 }, operation);
      else await operation();
      return { ok: true };
    } catch (error) { lastError = /^tidal_/.test(error.message) ? error.message : 'tidal_oauth_exchange_failed'; return { ok: false, error: lastError }; }
  }
  async function authorize(signal, force = false) {
    if (!force && accessToken && expiresAt > now() + 30000) return accessToken;
    if (refreshWork) return refreshWork;
    if (!refreshToken) throw new Error('tidal_oauth_sign_in_required');
    const revision = generation, previous = refreshToken;
    const work = (async () => {
      try { return await saveToken(await tokenRequest({ grant_type: 'refresh_token', refresh_token: previous }, signal), revision, previous); }
      catch (error) {
        if (revision === generation && error.message === 'tidal_oauth_refresh_rejected') {
          disconnect(); lastError = 'tidal_oauth_sign_in_required';
        }
        throw error;
      }
    })();
    refreshWork = work; try { return await work; } finally { if (refreshWork === work) refreshWork = null; }
  }
  return { status, configure, resetClient: () => configure({ clientId: PUBLIC_CLIENT_ID }), disconnect, clear: disconnect, begin, callback, authorize,
    shutdown() { generation++; pending = null; refreshWork = null; accessToken = ''; refreshToken = ''; } };
};
