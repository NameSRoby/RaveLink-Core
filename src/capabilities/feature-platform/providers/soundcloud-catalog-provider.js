const fs = require("node:fs");
const crypto = require("node:crypto");
const { protectTextMapWithWindowsDpapi, unprotectTextMapWithWindowsDpapi } = require("../../../shared/security/windows-dpapi");
const { readJsonFileWithMetadata, writeJsonFile } = require("../../../shared/fs/json-file-store");

const API_ORIGIN = "https://api.soundcloud.com";
const AUTH_URL = "https://secure.soundcloud.com/oauth/token";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const JOB_TTL_MS = 15 * 60 * 1000;
const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"]);

function clean(value, maximum = 300) { return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum); }
function soundCloudUrl(value) {
  try {
    const url = new URL(clean(value, 500));
    return url.protocol === "https:" && SOUNDCLOUD_HOSTS.has(url.hostname.toLowerCase()) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function createSoundCloudCatalogProvider(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const vaultPath = clean(options.vaultPath, 1000);
  const cache = new Map();
  const jobs = new Map();
  let clientId = "", clientSecret = "", accessToken = "", refreshToken = "", expiresAt = 0, tokenPromise = null, lastError = "";

  function persist() {
    if (!vaultPath) return true;
    try {
      const protectedValues = protectTextMapWithWindowsDpapi({ clientId, clientSecret, accessToken, refreshToken });
      if (!protectedValues.ok) throw new Error(protectedValues.error || "soundcloud_vault_write_failed");
      writeJsonFile(vaultPath, { version: 1, provider: "windows_dpapi", expiresAt, encrypted: protectedValues.encrypted }, { mode: 0o600 });
      return true;
    } catch (error) { lastError = clean(error?.message || "soundcloud_vault_write_failed", 120); return false; }
  }
  function load() {
    if (!vaultPath || !fs.existsSync(vaultPath)) return;
    try {
      const row = readJsonFileWithMetadata(vaultPath, {}).value;
      const decoded = unprotectTextMapWithWindowsDpapi(row.encrypted || {});
      if (!decoded.ok) throw new Error(decoded.error || "soundcloud_vault_invalid");
      clientId = clean(decoded.plain.clientId, 200); clientSecret = clean(decoded.plain.clientSecret, 300);
      accessToken = clean(decoded.plain.accessToken, 2000); refreshToken = clean(decoded.plain.refreshToken, 2000);
      expiresAt = Number(row.expiresAt || 0);
    } catch (error) { lastError = clean(error?.message || "soundcloud_vault_invalid", 120); }
  }
  function status() { return { ok: true, configured: Boolean(clientId && clientSecret), available: Boolean(clientId && clientSecret), credentials: { clientIdConfigured: Boolean(clientId), clientSecretConfigured: Boolean(clientSecret) }, tokenCached: Boolean(accessToken && expiresAt > now() + 30_000), vault: process.platform === "win32" ? "windows_dpapi" : "volatile_only", cacheEntries: cache.size, limits: { results: 5, cacheTtlMs: CACHE_TTL_MS }, lastError }; }
  async function configure(input = {}) {
    const nextId = clean(input.clientId, 200), nextSecret = clean(input.clientSecret, 300);
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(nextId) || nextSecret.length < 16) return { ...status(), ok: false, error: "soundcloud_credentials_invalid" };
    const previous = { clientId, clientSecret, accessToken, refreshToken, expiresAt };
    clientId = nextId; clientSecret = nextSecret; accessToken = ""; refreshToken = ""; expiresAt = 0; cache.clear(); lastError = "";
    if (!persist()) { clientId = previous.clientId; clientSecret = previous.clientSecret; accessToken = previous.accessToken; refreshToken = previous.refreshToken; expiresAt = previous.expiresAt; return { ...status(), ok: false, error: lastError }; }
    try { await token(); return status(); }
    catch (error) {
      clientId = previous.clientId; clientSecret = previous.clientSecret; accessToken = previous.accessToken; refreshToken = previous.refreshToken; expiresAt = previous.expiresAt;
      lastError = clean(error?.code || error?.message || "soundcloud_auth_failed", 120); persist();
      return { ...status(), ok: false, error: lastError };
    }
  }
  function clear() { clientId = clientSecret = accessToken = refreshToken = ""; expiresAt = 0; cache.clear(); persist(); return status(); }
  async function exchangeToken() {
    if (!clientId || !clientSecret) throw Object.assign(new Error("soundcloud_catalog_unconfigured"), { code: "soundcloud_catalog_unconfigured" });
    const refreshing = Boolean(refreshToken);
    const body = new URLSearchParams({ grant_type: refreshing ? "refresh_token" : "client_credentials" });
    const headers = { accept: "application/json; charset=utf-8", "content-type": "application/x-www-form-urlencoded" };
    if (refreshing) { body.set("client_id", clientId); body.set("client_secret", clientSecret); body.set("refresh_token", refreshToken); }
    else headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
    const response = await fetchImpl(AUTH_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(7000) });
    if (!response.ok && refreshing && [400, 401].includes(response.status)) { refreshToken = ""; return exchangeToken(); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw Object.assign(new Error(response.status === 429 ? "soundcloud_token_rate_limited" : "soundcloud_auth_failed"), { code: response.status === 429 ? "soundcloud_token_rate_limited" : "soundcloud_auth_failed" });
    accessToken = clean(data.access_token, 2000); refreshToken = clean(data.refresh_token, 2000); expiresAt = now() + Math.max(60, Number(data.expires_in) || 3600) * 1000; persist();
    return accessToken;
  }
  async function token() {
    if (accessToken && expiresAt > now() + 60_000) return accessToken;
    if (!tokenPromise) tokenPromise = exchangeToken().finally(() => { tokenPromise = null; });
    return tokenPromise;
  }
  async function api(pathname, parameters, signal) {
    const url = new URL(pathname, API_ORIGIN); for (const [key, value] of Object.entries(parameters || {})) if (value !== "") url.searchParams.set(key, String(value));
    const response = await fetchImpl(url, { headers: { accept: "application/json; charset=utf-8", authorization: `OAuth ${await token()}` }, signal: signal || AbortSignal.timeout(7000) });
    if (!response.ok) throw Object.assign(new Error(response.status === 429 ? "soundcloud_rate_limited" : "soundcloud_api_unavailable"), { code: response.status === 429 ? "soundcloud_rate_limited" : "soundcloud_api_unavailable" });
    return response.json();
  }
  function candidate(row) {
    const urn = clean(row?.urn, 160), title = clean(row?.title, 200), durationMs = Math.max(0, Math.min(86_400_000, Math.trunc(Number(row?.duration) || 0)));
    if (!/^soundcloud:tracks:[A-Za-z0-9_-]+$/.test(urn) || !title || row?.access !== "playable") return null;
    const artist = clean(row?.metadata_artist || row?.user?.username, 100);
    return { provider: "soundcloud", providerItemId: urn, title, artists: artist ? [artist] : [], album: clean(row?.publisher_metadata?.album_title, 200), durationMs, sourceUrl: soundCloudUrl(row?.permalink_url) };
  }
  async function resolve(input = {}) {
    const query = clean(input.query, 300), directUrl = soundCloudUrl(query), key = `${directUrl ? "url" : "q"}:${query.toLowerCase()}`;
    if (!query) return { ok: false, reason: "soundcloud_query_required" };
    const cached = cache.get(key); if (cached?.expiresAt > now()) return structuredClone(cached.value);
    try {
      const body = directUrl ? await api("/resolve", { url: directUrl }, input.signal) : await api("/tracks", { q: query, access: "playable", limit: 5, linked_partitioning: "true" }, input.signal);
      const rows = directUrl ? [body] : Array.isArray(body?.collection) ? body.collection : Array.isArray(body) ? body : [];
      const playable = rows.map(candidate).filter(Boolean).filter(row => !input.maxDurationMs || row.durationMs <= Number(input.maxDurationMs));
      const value = playable.length ? { ok: true, candidate: playable[0], evidence: { provider: "soundcloud", playableOnly: true, inspected: Math.min(rows.length, 5) } } : { ok: false, reason: "soundcloud_no_playable_track" };
      cache.set(key, { expiresAt: now() + CACHE_TTL_MS, value }); while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      return structuredClone(value);
    } catch (error) { lastError = clean(error?.code || error?.message || "soundcloud_api_unavailable", 120); return { ok: false, reason: lastError }; }
  }
  function trimJobs() {
    const cutoff = now() - JOB_TTL_MS;
    for (const [id, job] of jobs) if (job.updatedAt < cutoff && job.state !== "running") jobs.delete(id);
  }
  async function importPlaylist(url, limit, signal) {
    const playlistUrl = soundCloudUrl(url);
    if (!playlistUrl) throw Object.assign(new Error("soundcloud_playlist_url_invalid"), { code: "soundcloud_playlist_url_invalid" });
    const playlist = await api("/resolve", { url: playlistUrl }, signal);
    const playlistUrn = clean(playlist?.urn, 160);
    if (playlist?.kind !== "playlist" || !/^soundcloud:playlists:[A-Za-z0-9_-]+$/.test(playlistUrn)) throw Object.assign(new Error("soundcloud_playlist_url_invalid"), { code: "soundcloud_playlist_url_invalid" });
    const items = [];
    const seen = new Set();
    let nextPath = `/playlists/${encodeURIComponent(playlistUrn)}/tracks`;
    let parameters = { access: "playable", linked_partitioning: "true", limit: 200 };
    while (nextPath && items.length < limit) {
      const page = await api(nextPath, parameters, signal);
      for (const row of Array.isArray(page?.collection) ? page.collection : Array.isArray(page) ? page : []) {
        const track = candidate(row);
        if (track && !seen.has(track.providerItemId)) { seen.add(track.providerItemId); items.push(track); }
        if (items.length >= limit) break;
      }
      const next = clean(page?.next_href, 1000);
      if (!next) { nextPath = ""; continue; }
      const parsed = new URL(next, API_ORIGIN);
      if (parsed.origin !== API_ORIGIN || decodeURIComponent(parsed.pathname) !== `/playlists/${playlistUrn}/tracks`) throw new Error("soundcloud_playlist_pagination_invalid");
      nextPath = parsed.pathname;
      parameters = Object.fromEntries(parsed.searchParams);
    }
    return { title: clean(playlist?.title, 120) || "SoundCloud playlist", playlistId: playlistUrn, items, truncated: items.length >= limit };
  }
  function importPlaylistStart(input = {}) {
    trimJobs();
    if (!clientId || !clientSecret) return { ok: false, error: "soundcloud_catalog_unconfigured" };
    const url = soundCloudUrl(input.url);
    if (!url) return { ok: false, error: "soundcloud_playlist_url_invalid" };
    if ([...jobs.values()].some(job => job.state === "running")) return { ok: false, error: "playlist_import_busy" };
    const jobId = crypto.randomUUID();
    const controller = new AbortController();
    const job = { id: jobId, state: "running", playlistId: "", title: "", items: [], count: 0, truncated: false, error: "", createdAt: now(), updatedAt: now(), controller };
    jobs.set(jobId, job);
    Promise.resolve(importPlaylist(url, Math.min(2500, Math.max(1, Number(input.limit) || 2500)), controller.signal)).then(result => {
      if (job.state === "canceled") return;
      Object.assign(job, { state: "complete", playlistId: result.playlistId, title: result.title, items: result.items, count: result.items.length, truncated: result.truncated, updatedAt: now() });
    }).catch(error => { if (job.state !== "canceled") Object.assign(job, { state: "failed", error: clean(error?.code || error?.message || "soundcloud_playlist_unavailable", 120), updatedAt: now() }); });
    return { ok: true, jobId, state: job.state };
  }
  function importPlaylistStatus(input = {}) {
    trimJobs();
    const job = jobs.get(clean(input.jobId, 80));
    return job ? { ok: true, jobId: job.id, state: job.state, playlistId: job.playlistId, title: job.title, count: job.count, truncated: job.truncated, error: job.error } : { ok: false, error: "playlist_import_not_found" };
  }
  function importPlaylistPage(input = {}) {
    const job = jobs.get(clean(input.jobId, 80));
    if (!job) return { ok: false, error: "playlist_import_not_found" };
    if (job.state !== "complete") return { ok: false, error: "playlist_import_not_complete" };
    const offset = Math.max(0, Math.min(job.items.length, Number(input.offset) || 0));
    const limit = Math.max(1, Math.min(100, Number(input.limit) || 100));
    return { ok: true, items: job.items.slice(offset, offset + limit), offset, total: job.items.length, hasMore: offset + limit < job.items.length };
  }
  function importPlaylistCancel(input = {}) {
    const job = jobs.get(clean(input.jobId, 80));
    if (!job) return { ok: false, error: "playlist_import_not_found" };
    if (job.state === "running") job.controller.abort();
    Object.assign(job, { state: "canceled", items: [], updatedAt: now() });
    return { ok: true, jobId: job.id, state: job.state };
  }
  load();
  return Object.freeze({ status, configure, clear, resolve, importPlaylistStart, importPlaylistStatus, importPlaylistPage, importPlaylistCancel });
}

module.exports = { API_ORIGIN, AUTH_URL, SOUNDCLOUD_HOSTS, createSoundCloudCatalogProvider, soundCloudUrl };
