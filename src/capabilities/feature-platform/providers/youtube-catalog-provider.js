const crypto = require("node:crypto");
const fs = require("node:fs");
const { protectTextMapWithWindowsDpapi, unprotectTextMapWithWindowsDpapi } = require("../../../shared/security/windows-dpapi");
const { readJsonFileWithMetadata, writeJsonFile } = require("../../../shared/fs/json-file-store");
const { levenshteinDistance } = require("../../../shared/fuzzy/fuzzy-text");
const { resolveSpotifySongInput } = require("./spotify-link-resolver");
const { createYoutubeKeylessCatalogProvider } = require("./youtube-keyless-catalog-provider");
const { createYoutubePlaylistImportProvider } = require("./youtube-playlist-import-provider");

const API_HOST = "https://www.googleapis.com/youtube/v3";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const MAX_SEARCHES_PER_MINUTE = 10;
const DEFAULT_DAILY_QUOTA = 9000;
const DERIVATIVES = Object.freeze({
  cover: /\b(?:cover|covered by)\b/i,
  instrumental: /\b(?:instrumental|no vocals?)\b/i,
  karaoke: /\bkaraoke\b/i,
  remix: /\b(?:remix|rework|bootleg)\b/i,
  remaster: /\b(?:remaster(?:ed)?|anniversary edition)\b/i,
  live: /\b(?:live|concert|festival|session)\b/i,
  acoustic: /\bacoustic\b/i,
  slowed: /\b(?:slowed|slow version)\b/i,
  sped_up: /\b(?:sped[ -]?up|speed up)\b/i,
  nightcore: /\bnightcore\b/i,
  lyrics: /\b(?:lyrics?|lyric video)\b/i,
  extended: /\b(?:extended|loop(?:ed)?|1 hour|10 hours?)\b/i,
  edit: /\b(?:radio edit|fan edit|edit version)\b/i,
  reaction: /\b(?:reaction|reacts? to)\b/i,
  mashup: /\b(?:mashup|mash-up|medley)\b/i,
  fanmade: /\b(?:fan[ -]?made|tribute)\b/i,
  tutorial: /\b(?:tutorial|how to play|lesson)\b/i,
  enhanced: /\b(?:8d audio|bass boosted|clean version|censored)\b/i
});

function text(value, maximum = 500) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function decodeHtml(value) {
  const entities = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", "#39": "'" };
  return text(value, 300).replace(/&([a-z]+|#39);/gi, (match, key) => entities[key.toLowerCase()] || match);
}

function count(value) {
  const parsed = Number.parseInt(String(value || "0"), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function boundedNumber(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function durationMs(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(String(value || ""));
  if (!match) return 0;
  return ((Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0)) * 1000;
}

function tokens(value) {
  return text(value, 300).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(word => word.length > 1);
}

function confidence(query, title, rank) {
  const queryTokens = tokens(query);
  const titleTokens = tokens(title);
  if (!queryTokens.length || !titleTokens.length) return 0;
  const similarity = (left, right) => {
    if (left === right) return 1;
    if (Math.min(left.length, right.length) < 4) return 0;
    if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length);
    let distance = levenshteinDistance(left, right);
    if (distance === 2 && left.length === right.length) {
      const mismatch = [...left].map((character, index) => character === right[index] ? -1 : index).filter(index => index >= 0);
      if (mismatch.length === 2 && mismatch[1] === mismatch[0] + 1
        && left[mismatch[0]] === right[mismatch[1]] && left[mismatch[1]] === right[mismatch[0]]) distance = 1;
    }
    const ratio = 1 - distance / Math.max(left.length, right.length, 1);
    return ratio >= 0.68 ? ratio : 0;
  };
  const queryMatches = queryTokens.map(word => Math.max(...titleTokens.map(candidate => similarity(word, candidate))));
  const titleMatches = titleTokens.map(word => Math.max(...queryTokens.map(candidate => similarity(word, candidate))));
  const coverage = queryMatches.reduce((sum, value) => sum + value, 0) / queryMatches.length;
  const precision = titleMatches.filter(value => value >= 0.68).length / titleMatches.length;
  const normalizedQuery = queryTokens.join(" ");
  const normalizedTitle = titleTokens.join(" ");
  const phrase = normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle) ? 0.15 : 0;
  return Math.max(0, Math.min(1, coverage * 0.72 + precision * 0.13 + phrase - rank * 0.01));
}

function normalizePolicy(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const configured = source.derivatives && typeof source.derivatives === "object" ? source.derivatives : {};
  return {
    allowNonMusic: source.allowNonMusic === true,
    minimumSubscribers: boundedNumber(source.minimumSubscribers, 0, 1000000000, 100000),
    minimumViews: boundedNumber(source.minimumViews, 0, 1000000000, 50000),
    minimumConfidence: boundedNumber(source.minimumConfidence, 0.1, 0.95, 0.4),
    maxDurationMs: boundedNumber(source.maxDurationMs, 30000, 3600000, 600000),
    derivatives: Object.fromEntries(Object.keys(DERIVATIVES).map(kind => [kind, configured[kind] !== false]))
  };
}

function derivativeAllowed(query, title, policy) {
  const blocked = [];
  for (const [kind, pattern] of Object.entries(DERIVATIVES)) {
    if (policy.derivatives[kind] && pattern.test(title) && !pattern.test(query)) blocked.push(kind);
  }
  return { ok: blocked.length === 0, blocked };
}

function createYoutubeCatalogProvider(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const vaultPath = options.vaultPath || "";
  const egressGovernor = options.egressGovernor;
  const dailyQuota = Math.max(102, Number(options.dailyQuota) || DEFAULT_DAILY_QUOTA);
  const cache = new Map();
  const inFlight = new Map();
  let apiKey = "";
  let mode = options.defaultMode === "keyless" ? "keyless" : "official";
  let quotaDay = "";
  let quotaUsed = 0;
  let searchTimes = [];
  let lastError = "";
  const keyless = createYoutubeKeylessCatalogProvider({
    fetchImpl,
    createClient: options.createKeylessClient,
    rules: { confidence, derivativeAllowed }
  });
  const playlistImports = createYoutubePlaylistImportProvider({ keyless, now });

  function load() {
    if (!vaultPath || !fs.existsSync(vaultPath)) return;
    try {
      const raw = readJsonFileWithMetadata(vaultPath, {}).value;
      const decoded = unprotectTextMapWithWindowsDpapi(raw.encrypted || {});
      if (!decoded.ok) throw new Error(decoded.error || "youtube_catalog_vault_invalid");
      apiKey = text(decoded.plain.apiKey, 200);
      if (["official", "keyless"].includes(raw.mode)) mode = raw.mode;
      else if (apiKey) mode = "official";
    } catch (error) { lastError = text(error?.message || "youtube_catalog_vault_invalid", 120); }
  }

  function persist() {
    if (!vaultPath) return true;
    try {
      const encoded = protectTextMapWithWindowsDpapi({ apiKey });
      if (!encoded.ok) throw new Error(encoded.error || "youtube_catalog_vault_write_failed");
      writeJsonFile(vaultPath, { version: 2, provider: "windows_dpapi", mode, encrypted: encoded.encrypted }, { mode: 0o600 });
      return true;
    } catch (error) {
      lastError = text(error?.message || "youtube_catalog_vault_write_failed", 120);
      return false;
    }
  }

  function resetQuotaDay() {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (day !== quotaDay) { quotaDay = day; quotaUsed = 0; searchTimes = []; }
  }

  function status() {
    resetQuotaDay();
    const keylessStatus = keyless.status();
    return {
      ok: true,
      mode,
      configured: mode === "keyless" ? keylessStatus.available : Boolean(apiKey),
      officialConfigured: Boolean(apiKey),
      keylessAvailable: keylessStatus.available,
      keyless: keylessStatus,
      availableModes: ["keyless", "official"],
      vault: process.platform === "win32" ? "windows_dpapi" : "volatile_only",
      cacheEntries: cache.size, inFlight: inFlight.size, quota: { used: quotaUsed, budget: dailyQuota, remaining: Math.max(0, dailyQuota - quotaUsed) },
      limits: { results: 5, searchesPerMinute: MAX_SEARCHES_PER_MINUTE, cacheTtlMs: CACHE_TTL_MS }, lastError
    };
  }

  function configure(input = {}) {
    const requestedMode = input.mode === undefined ? "" : text(input.mode, 20).toLowerCase();
    if (requestedMode && !["official", "keyless"].includes(requestedMode)) return { ...status(), ok: false, error: "youtube_catalog_mode_invalid" };
    const value = input.apiKey === undefined ? "" : text(input.apiKey, 200);
    if (input.apiKey !== undefined && !/^[A-Za-z0-9_-]{20,200}$/.test(value)) return { ...status(), ok: false, error: "youtube_api_key_invalid" };
    const previous = apiKey;
    const previousMode = mode;
    if (value) apiKey = value;
    if (requestedMode) mode = requestedMode;
    else if (value) mode = "official";
    cache.clear();
    lastError = "";
    if (!persist()) { apiKey = previous; mode = previousMode; return { ...status(), ok: false, error: lastError }; }
    return status();
  }

  function clear() {
    const previous = apiKey;
    apiKey = "";
    cache.clear();
    if (!persist()) { apiKey = previous; return { ...status(), ok: false, error: lastError }; }
    return status();
  }

  async function request(resource, parameters, signal) {
    const url = new URL(`${API_HOST}/${resource}`);
    for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    url.searchParams.set("key", apiKey);
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 403 ? "youtube_quota_or_key_rejected" : "youtube_api_unavailable");
      error.code = error.message;
      throw error;
    }
    return body;
  }

  function consume(units, isSearch) {
    resetQuotaDay();
    const timestamp = Number(now());
    searchTimes = searchTimes.filter(value => timestamp - value < 60000);
    if (quotaUsed + units > dailyQuota) return "youtube_daily_budget_exhausted";
    if (isSearch && searchTimes.length >= MAX_SEARCHES_PER_MINUTE) return "youtube_search_rate_limited";
    quotaUsed += units;
    if (isSearch) searchTimes.push(timestamp);
    return "";
  }

  function trimCache() {
    const timestamp = Number(now());
    for (const [key, row] of cache) if (row.expiresAt <= timestamp) cache.delete(key);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }

  async function resolveFresh(input, policy, signal) {
    let query = text(input.query, 300);
    const explicitId = /^[A-Za-z0-9_-]{11}$/.test(text(input.videoId, 20)) ? text(input.videoId, 20) : "";
    let inputSource = explicitId ? "youtube" : "text";
    if (!explicitId) {
      const normalized = await resolveSpotifySongInput(query, fetchImpl, signal);
      if (!normalized.ok) return { ok: false, code: "rejected", reason: normalized.reason };
      query = normalized.query;
      inputSource = normalized.kind === "spotify_track" ? "spotify" : "text";
    }
    if (mode === "keyless") {
      const result = await keyless.resolve({ query, videoId: explicitId, policy, signal });
      return result.ok ? { ...result, evidence: { ...result.evidence, inputSource } } : result;
    }
    const cost = explicitId ? 2 : 102;
    const limitError = consume(cost, !explicitId);
    if (limitError) return { ok: false, code: "rejected", reason: limitError };
    let searchItems = [];
    if (explicitId) searchItems = [{ id: { videoId: explicitId }, snippet: {} }];
    else {
      const search = await request("search", {
        part: "snippet", type: "video", q: query, maxResults: 5, order: "relevance", safeSearch: "strict",
        videoEmbeddable: "true", videoSyndicated: "true", ...(policy.allowNonMusic ? {} : { videoCategoryId: "10" })
      }, signal);
      searchItems = Array.isArray(search.items) ? search.items.slice(0, 5) : [];
    }
    const ids = searchItems.map(row => text(row?.id?.videoId, 20)).filter(value => /^[A-Za-z0-9_-]{11}$/.test(value));
    if (!ids.length) return { ok: false, code: "rejected", reason: "catalog_no_results" };
    const videos = await request("videos", { part: "snippet,contentDetails,statistics,status", id: ids.join(",") }, signal);
    const videoRows = new Map((videos.items || []).map(row => [row.id, row]));
    const channelIds = [...new Set((videos.items || []).map(row => text(row?.snippet?.channelId, 80)).filter(Boolean))];
    if (!channelIds.length) return { ok: false, code: "rejected", reason: "catalog_no_eligible_match", rejected: { missing_channel: ids.length } };
    const channels = await request("channels", { part: "snippet,statistics,status", id: channelIds.join(",") }, signal);
    const channelRows = new Map((channels.items || []).map(row => [row.id, row]));
    const rejected = {};
    const eligible = [];
    ids.forEach((id, rank) => {
      const video = videoRows.get(id);
      const channel = channelRows.get(video?.snippet?.channelId);
      const title = decodeHtml(video?.snippet?.title);
      const views = count(video?.statistics?.viewCount);
      const subscribers = count(channel?.statistics?.subscriberCount);
      let reason = "";
      if (!video || !channel || video.status?.embeddable === false) reason = "not_embeddable";
      else if (!policy.allowNonMusic && String(video.snippet?.categoryId) !== "10") reason = "not_music";
      else if (views < policy.minimumViews) reason = "insufficient_views";
      else if (channel.statistics?.hiddenSubscriberCount === true || subscribers < policy.minimumSubscribers) reason = "insufficient_subscribers";
      const derivative = derivativeAllowed(query, title, policy);
      if (!reason && !derivative.ok) reason = `derivative_${derivative.blocked[0]}`;
      const length = durationMs(video.contentDetails?.duration);
      if (!reason && (!length || length > policy.maxDurationMs)) reason = "duration_limit";
      const score = confidence(query, title, rank);
      if (!reason && score < policy.minimumConfidence) reason = "confidence_too_low";
      if (reason) rejected[reason] = (rejected[reason] || 0) + 1;
      else eligible.push({
        score, rank,
        candidate: {
          provider: "youtube", providerItemId: id, title,
          artists: [decodeHtml(channel.snippet?.title)].filter(Boolean), album: "", durationMs: length
        },
        evidence: { confidence: Number(score.toFixed(3)), views, subscribers, musicCategory: String(video.snippet?.categoryId) === "10" }
      });
    });
    eligible.sort((left, right) => right.score - left.score || left.rank - right.rank);
    if (!eligible.length) return { ok: false, code: "rejected", reason: "catalog_no_eligible_match", rejected };
    return { ok: true, code: "resolved", candidate: eligible[0].candidate, evidence: { ...eligible[0].evidence, inputSource }, considered: ids.length };
  }

  async function resolve(input = {}) {
    if (mode === "official" && !apiKey) return { ok: false, code: "rejected", reason: "youtube_catalog_unconfigured" };
    if (mode === "keyless" && !keyless.status().available) return { ok: false, code: "rejected", reason: "youtube_keyless_unavailable" };
    const query = text(input.query, 300);
    if (!query) return { ok: false, code: "rejected", reason: "invalid_request" };
    const policy = normalizePolicy(input.policy);
    const key = crypto.createHash("sha256").update(JSON.stringify({ mode, query: query.toLowerCase(), videoId: text(input.videoId, 20), policy })).digest("hex");
    trimCache();
    const cached = cache.get(key);
    if (cached?.expiresAt > Number(now())) return { ...cached.value, cached: true };
    if (inFlight.has(key)) return inFlight.get(key);
    const operation = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      timer.unref?.();
      try {
        const result = await resolveFresh(input, policy, controller.signal);
        if (result.ok || ["catalog_no_results", "catalog_no_eligible_match", "catalog_untrusted_link", "spotify_track_required", "spotify_track_not_found"].includes(result.reason)) {
          cache.set(key, { value: result, expiresAt: Number(now()) + CACHE_TTL_MS });
          trimCache();
        }
        lastError = result.ok ? "" : text(result.reason, 120);
        return result;
      } catch (error) {
        lastError = error?.name === "AbortError" ? "youtube_api_timeout" : text(error?.code || error?.message || "youtube_api_unavailable", 120);
        return { ok: false, code: "rejected", reason: lastError };
      } finally { clearTimeout(timer); }
    };
    const promise = egressGovernor?.run
      ? egressGovernor.run({ owner: "provider.external", priority: "optional", queueDeadlineMs: 7000 }, operation).catch(error => ({ ok: false, code: "rejected", reason: text(error?.code || "youtube_api_busy", 120) }))
      : operation();
    inFlight.set(key, promise);
    try { return await promise; } finally { inFlight.delete(key); }
  }

  load();
  return Object.freeze({
    clear,
    configure,
    importPlaylistCancel: playlistImports.cancel,
    importPlaylistPage: playlistImports.page,
    importPlaylistStart: playlistImports.start,
    importPlaylistStatus: playlistImports.status,
    resolve,
    status
  });
}

module.exports = { DERIVATIVES, confidence, createYoutubeCatalogProvider, derivativeAllowed, durationMs, normalizePolicy };
