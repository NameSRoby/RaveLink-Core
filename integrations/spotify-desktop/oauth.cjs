const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { protectTextMapWithWindowsDpapi, unprotectTextMapWithWindowsDpapi } = require('../../src/shared/security/windows-dpapi');
const { writeJsonFile, readJsonFileWithMetadata } = require('../../src/shared/fs/json-file-store');
const SCOPES = ['user-read-private', 'user-read-playback-state', 'user-modify-playback-state'];
module.exports = function spotifyOAuth(options = {}) {
  const protect = options.protect || protectTextMapWithWindowsDpapi, unprotect = options.unprotect || unprotectTextMapWithWindowsDpapi;
  const requestFetch = options.fetch || fetch, now = options.now || Date.now;
  let saved = {}, pending = null, revision = 0, refreshing = null, lastError = '';
  function persist(next) {
    if (options.vaultPath) {
      const encrypted = protect({ account: JSON.stringify(next) });if (!encrypted.ok) throw Error('spotify_vault_failed');
      fs.mkdirSync(path.dirname(options.vaultPath), { recursive: true });
      writeJsonFile(options.vaultPath, { version: 1, encrypted: encrypted.encrypted }, { mode: 0o600, backup: false });
    }
    saved = next;
  }
  try {
    if (options.vaultPath && fs.existsSync(options.vaultPath)) {
      if (fs.lstatSync(options.vaultPath).isSymbolicLink() || fs.statSync(options.vaultPath).size > 131072) throw Error();
      const stored = readJsonFileWithMetadata(options.vaultPath, {}).value;
      const decoded = unprotect(stored.encrypted || {});if (stored.version !== 1 || !decoded.ok) throw Error();
      saved = JSON.parse(decoded.plain.account);
      if (!/^[a-f0-9]{32}$/i.test(saved.clientId || '') || saved.accessToken && (typeof saved.accessToken !== 'string' || saved.accessToken.length > 8192 || /[\r\n]/.test(saved.accessToken)) || saved.refreshToken && (typeof saved.refreshToken !== 'string' || saved.refreshToken.length > 8192)) throw Error();
    }
  } catch { saved = {};lastError = 'spotify_vault_failed'; }
  const status = () => ({ configured: Boolean(saved.clientId), connected: Boolean(saved.refreshToken || saved.accessToken && saved.expiresAt > now()), pending: Boolean(pending && pending.until > now()), lastError });
  function configure(input) {
    if (!/^[a-f0-9]{32}$/i.test(input.clientId || '')) return { ok: false, error: 'spotify_client_id_invalid' };
    try { persist({ clientId: input.clientId });revision++;pending = null;lastError = '';return { ok: true, ...status() }; }
    catch { return { ok: false, error: 'spotify_vault_failed' }; }
  }
  function begin(input) {
    if (!saved.clientId) return { ok: false, error: 'spotify_oauth_setup_required' };
    let redirect;try { redirect = new URL(input.redirectUri); } catch {}
    if (!redirect || redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.pathname !== '/auth/spotify/callback' || redirect.username || redirect.password || redirect.search || redirect.hash) return { ok: false, error: 'spotify_oauth_redirect_invalid' };
    const verifier = crypto.randomBytes(32).toString('base64url'), state = crypto.randomBytes(32).toString('base64url');
    pending = { verifier, state, redirectUri: redirect.href, until: now() + 300000, revision: ++revision };
    const url = new URL('https://accounts.spotify.com/authorize');
    for (const [key, value] of Object.entries({ client_id: saved.clientId, response_type: 'code', redirect_uri: redirect.href, scope: SCOPES.join(' '), state, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') })) url.searchParams.set(key, value);
    return { ok: true, authorizationUrl: url.href };
  }
  async function token(fields, generation) {
    const before = saved;
    const response = await requestFetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: before.clientId, ...fields }), redirect: 'error', signal: AbortSignal.timeout(10000) });
    const value = await boundedJSON(response);
    if (!response.ok) throw Error('spotify_sign_in_required');
    if (generation !== revision) throw Error('spotify_account_changed');
    if (typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 8192 || /[\r\n]/.test(value.access_token) || !Number.isFinite(Number(value.expires_in)) || Number(value.expires_in) <= 0 || value.token_type && value.token_type.toLowerCase() !== 'bearer' || value.scope && !SCOPES.every(scope => value.scope.split(/\s+/).includes(scope))) throw Error('spotify_oauth_scope_missing');
    if (value.refresh_token !== undefined && (typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > 8192 || /[\r\n]/.test(value.refresh_token))) throw Error('spotify_oauth_token_invalid');
    persist({ ...before, accessToken: value.access_token, refreshToken: value.refresh_token || before.refreshToken || '', expiresAt: now() + Math.min(86400, Number(value.expires_in)) * 1000 });lastError = '';return saved.accessToken;
  }
  async function callback(input, redirectUri) {
    const session = pending;
    if (!session || session.until < now()) return { ok: false, error: 'spotify_oauth_session_expired' };
    if (typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || !crypto.timingSafeEqual(Buffer.from(input.state), Buffer.from(session.state)) || redirectUri !== session.redirectUri) return { ok: false, error: 'spotify_oauth_state_invalid' };
    pending = null;
    if (input.error || typeof input.code !== 'string' || !input.code || input.code.length > 4096) return { ok: false, error: 'spotify_oauth_denied' };
    try { await token({ grant_type: 'authorization_code', code: input.code, redirect_uri: session.redirectUri, code_verifier: session.verifier }, session.revision);return { ok: true }; }
    catch (error) { lastError = /^spotify_/.test(error.message) ? error.message : 'spotify_oauth_exchange_failed';return { ok: false, error: lastError }; }
  }
  async function authorize() {
    if (saved.accessToken && saved.expiresAt > now() + 30000) return saved.accessToken;
    if (!saved.refreshToken) throw Error('spotify_sign_in_required');
    if (!refreshing) { const work = token({ grant_type: 'refresh_token', refresh_token: saved.refreshToken }, revision);refreshing = work;work.finally(() => { if (refreshing === work) refreshing = null; }).catch(() => {}); }
    return refreshing;
  }
  function disconnect() { try { persist({ clientId: saved.clientId });revision++;pending = null;return { ok: true, ...status() }; } catch { return { ok: false, error: 'spotify_vault_failed' }; } }
  return { status, configure, begin, callback, authorize, disconnect, close() { revision++;pending = null;saved = {}; } };
};
async function boundedJSON(response) {
  if (!response.body?.getReader) { const value = await response.json();if (Buffer.byteLength(JSON.stringify(value)) > 524288) throw Error('spotify_response_too_large');return value; }
  const reader = response.body.getReader(), chunks = [];let bytes = 0;
  try { for (;;) { const next = await reader.read();if (next.done) break;bytes += next.value.length;if (bytes > 524288) throw Error('spotify_response_too_large');chunks.push(Buffer.from(next.value)); }return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  finally { await reader.cancel().catch(() => {}); }
}
module.exports.boundedJSON = boundedJSON;
