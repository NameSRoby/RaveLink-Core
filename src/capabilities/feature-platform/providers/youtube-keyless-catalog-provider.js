const { AsyncLocalStorage } = require("node:async_hooks");

const MAX_RESULTS = 5;
const MAX_VALIDATIONS = 3;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PLAYLIST_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_PLAYLIST_ITEMS = 2500;
const ALLOWED_PATHS = new Set(["/youtubei/v1/config", "/youtubei/v1/search", "/youtubei/v1/player", "/youtubei/v1/browse"]);

function plainText(value, maximum = 300) {
  const raw = typeof value === "string" ? value : typeof value?.text === "string" ? value.text : "";
  return raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function metric(value) {
  const raw = plainText(value, 80).toUpperCase().replace(/\b(?:VIEWS?|SUBSCRIBERS?)\b/g, "").replace(/,/g, "").trim();
  const match = /^(\d+(?:\.\d+)?)\s*([KMB])?$/.exec(raw);
  if (!match) return null;
  const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[match[2]] || 1;
  const parsed = Math.round(Number(match[1]) * multiplier);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function durationMs(value) {
  const seconds = Number(value?.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

function playlistItem(item) {
  const id = plainText(item?.id || item?.content_id, 20);
  if (!/^[A-Za-z0-9_-]{11}$/.test(id) || item?.is_playable === false || item?.is_live === true) return null;
  const title = plainText(item?.title || item?.metadata?.title, 300);
  const author = plainText(item?.author?.name || item?.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text, 200);
  return {
    provider: "youtube",
    providerItemId: id,
    title: title || id,
    artists: author ? [author] : [],
    album: "",
    durationMs: durationMs(item?.duration),
    sourceUrl: `https://www.youtube.com/watch?v=${id}`
  };
}

function normalCandidates(result) {
  return Array.from(result?.videos || []).slice(0, MAX_RESULTS).map((item, rank) => ({
    id: plainText(item?.id, 20),
    title: plainText(item?.title, 300),
    channelId: plainText(item?.author?.id, 100),
    channel: plainText(item?.author?.name, 200),
    durationMs: durationMs(item?.duration),
    views: metric(item?.view_count),
    verified: item?.author?.is_verified === true,
    verifiedArtist: item?.author?.is_verified_artist === true,
    isShort: item?.is_short === true,
    rank
  }));
}

function musicVideoIds(result) {
  const shelf = Array.from(result?.contents || []).find(item => item?.type === "MusicShelf");
  return new Set(Array.from(shelf?.contents || []).slice(0, MAX_RESULTS)
    .filter(item => item?.item_type === "video")
    .map(item => plainText(item?.id, 20))
    .filter(Boolean));
}

function createRestrictedFetch(fetchImpl, requestScope) {
  return async function restrictedFetch(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : input?.url || String(input));
    if (url.protocol !== "https:" || url.hostname !== "www.youtube.com" || !ALLOWED_PATHS.has(url.pathname)) {
      throw Object.assign(new Error("youtube_keyless_egress_denied"), { code: "youtube_keyless_egress_denied" });
    }
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.delete("authorization");
    headers.delete("cookie");
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const outerSignal = requestScope.getStore()?.signal;
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
    const response = await fetchImpl(input, { ...init, headers, credentials: "omit", redirect: "error", signal });
    const body = Buffer.from(await response.arrayBuffer());
    const responseLimit = url.pathname === "/youtubei/v1/browse" ? MAX_PLAYLIST_RESPONSE_BYTES : MAX_RESPONSE_BYTES;
    if (body.length > responseLimit) throw Object.assign(new Error("youtube_keyless_response_too_large"), { code: "youtube_keyless_response_too_large" });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    return new Response(body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  };
}

function createYoutubeKeylessCatalogProvider(options = {}) {
  const rules = options.rules || {};
  const requestScope = new AsyncLocalStorage();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const restrictedFetch = createRestrictedFetch(fetchImpl, requestScope);
  let clientPromise;
  let lastError = "";
  let searches = [];

  async function createClient() {
    if (typeof options.createClient === "function") return options.createClient({ fetch: restrictedFetch });
    const { Innertube } = await import("youtubei.js");
    return Innertube.create({ fetch: restrictedFetch, generate_session_locally: true, retrieve_player: false });
  }

  function client() {
    if (!clientPromise) clientPromise = Promise.resolve().then(createClient).catch(error => {
      clientPromise = null;
      throw error;
    });
    return clientPromise;
  }

  function rateLimit(now = Date.now()) {
    searches = searches.filter(timestamp => now - timestamp < 60000);
    if (searches.length >= 10) return false;
    searches.push(now);
    return true;
  }

  function status() {
    let version = "unknown";
    try { version = require("youtubei.js/package.json").version; } catch {}
    return { available: version !== "unknown", loaded: Boolean(clientPromise), version, lastError };
  }

  async function validate(api, candidate, signal) {
    const info = await requestScope.run({ signal }, () => api.getBasicInfo(candidate.id, { client: "ANDROID" }));
    const basic = info?.basic_info || {};
    const playability = info?.playability_status || {};
    if (playability.status !== "OK" || playability.embeddable === false) return { ok: false, reason: "not_embeddable" };
    return {
      ok: true,
      candidate: {
        ...candidate,
        title: plainText(basic.title, 300) || candidate.title,
        channel: plainText(basic.channel?.name, 200) || candidate.channel,
        channelId: plainText(basic.channel_id || basic.channel?.id, 100) || candidate.channelId,
        durationMs: Math.round(Number(basic.duration || 0) * 1000) || candidate.durationMs,
        views: Number.isSafeInteger(basic.view_count) ? basic.view_count : candidate.views
      }
    };
  }

  async function resolve(input = {}) {
    const query = plainText(input.query, 300);
    const explicitId = /^[A-Za-z0-9_-]{11}$/.test(String(input.videoId || "")) ? String(input.videoId) : "";
    const policy = input.policy || {};
    if (!query && !explicitId) return { ok: false, code: "rejected", reason: "invalid_request" };
    if (!explicitId && !rateLimit()) return { ok: false, code: "rejected", reason: "youtube_keyless_rate_limited" };
    try {
      const api = await client();
      let candidates;
      let musicIds = new Set();
      if (explicitId) {
        candidates = [{ id: explicitId, title: query || explicitId, channel: "", channelId: "", durationMs: 0, views: null, verified: false, verifiedArtist: false, isShort: false, rank: 0 }];
      } else {
        const searches = [requestScope.run({ signal: input.signal }, () => api.search(query, { type: "video" }))];
        if (policy.allowNonMusic !== true) searches.push(requestScope.run({ signal: input.signal }, () => api.music.search(query, { type: "video" })));
        const [normal, music] = await Promise.all(searches);
        candidates = normalCandidates(normal);
        musicIds = musicVideoIds(music);
      }

      const rejected = {};
      const eligible = [];
      for (const candidate of candidates.slice(0, MAX_RESULTS)) {
        let reason = "";
        if (!/^[A-Za-z0-9_-]{11}$/.test(candidate.id)) reason = "invalid_video_id";
        else if (candidate.isShort) reason = "short_video";
        else if (candidate.durationMs && candidate.durationMs > Number(policy.maxDurationMs || 600000)) reason = "duration_limit";
        else if (candidate.views !== null && candidate.views < Number(policy.minimumViews || 50000)) reason = "insufficient_views";
        const derivative = rules.derivativeAllowed?.(query, candidate.title, policy) || { ok: true, blocked: [] };
        if (!reason && !derivative.ok) reason = `derivative_${derivative.blocked[0]}`;
        const musicCrossMatch = musicIds.has(candidate.id);
        if (!reason && !explicitId && policy.allowNonMusic !== true && !musicCrossMatch && !candidate.verifiedArtist) reason = "not_music";
        const titleScore = rules.confidence?.(query, candidate.title, candidate.rank) || 0;
        const combinedScore = rules.confidence?.(query, `${candidate.channel} ${candidate.title}`, candidate.rank) || titleScore;
        const trust = candidate.verifiedArtist ? 0.1 : candidate.verified ? 0.07 : /(?:\btopic\b|\bvevo\b|\bofficial\b)/i.test(candidate.channel) ? 0.05 : 0;
        const score = Math.min(1, titleScore * 0.7 + combinedScore * 0.3 + (musicCrossMatch ? 0.1 : 0) + trust);
        if (!reason && !explicitId && score < Number(policy.minimumConfidence || 0.4)) reason = "confidence_too_low";
        if (reason) rejected[reason] = (rejected[reason] || 0) + 1;
        else eligible.push({ ...candidate, score, musicCrossMatch });
      }
      eligible.sort((left, right) => right.score - left.score || left.rank - right.rank);
      if (!eligible.length) return { ok: false, code: "rejected", reason: "catalog_no_eligible_match", rejected };
      for (const candidate of eligible.slice(0, MAX_VALIDATIONS)) {
        const validated = await validate(api, candidate, input.signal);
        if (!validated.ok) { rejected[validated.reason] = (rejected[validated.reason] || 0) + 1; continue; }
        const row = validated.candidate;
        if (row.durationMs > Number(policy.maxDurationMs || 600000)) { rejected.duration_limit = (rejected.duration_limit || 0) + 1; continue; }
        if (row.views !== null && row.views < Number(policy.minimumViews || 50000)) { rejected.insufficient_views = (rejected.insufficient_views || 0) + 1; continue; }
        lastError = "";
        return {
          ok: true,
          code: "resolved",
          candidate: { provider: "youtube", providerItemId: row.id, title: row.title, artists: [row.channel].filter(Boolean), album: "", durationMs: row.durationMs },
          evidence: { confidence: Number(row.score.toFixed(3)), views: row.views, subscriberCount: null, subscriberThreshold: "unknown", verified: row.verified, verifiedArtist: row.verifiedArtist, musicCrossMatch: row.musicCrossMatch, embeddable: true, resolver: "youtubei" },
          considered: candidates.length
        };
      }
      return { ok: false, code: "rejected", reason: "catalog_no_eligible_match", rejected };
    } catch (error) {
      lastError = error?.name === "TimeoutError" || error?.name === "AbortError" ? "youtube_keyless_timeout" : plainText(error?.code || "youtube_keyless_unavailable", 120);
      if (!lastError.startsWith("youtube_keyless_")) lastError = "youtube_keyless_unavailable";
      return { ok: false, code: "rejected", reason: lastError };
    }
  }

  async function importPlaylist(input = {}) {
    const playlistId = plainText(input.playlistId, 80);
    const limit = Math.min(MAX_PLAYLIST_ITEMS, Math.max(1, Number(input.limit) || MAX_PLAYLIST_ITEMS));
    if (!/^(?:PL|UU|OLAK5uy_|RD|FL)[A-Za-z0-9_-]{8,}$/.test(playlistId)) {
      return { ok: false, code: "rejected", reason: "youtube_playlist_id_invalid" };
    }
    try {
      const api = await client();
      let page = await requestScope.run({ signal: input.signal }, () => api.getPlaylist(playlistId));
      const playlistTitle = plainText(page?.info?.title, 120) || playlistId;
      const advertisedCount = Number(plainText(page?.info?.total_items, 40).replace(/[^0-9]/g, "")) || 0;
      const items = [];
      const seen = new Set();
      let pages = 0;
      let truncated = false;
      while (page && pages < 100 && items.length < limit) {
        pages += 1;
        for (const raw of Array.from(page.items || [])) {
          const row = playlistItem(raw);
          if (!row || seen.has(row.providerItemId)) continue;
          seen.add(row.providerItemId);
          items.push(row);
          if (items.length >= limit) { truncated = page.has_continuation === true; break; }
        }
        if (items.length >= limit || page.has_continuation !== true) break;
        page = await requestScope.run({ signal: input.signal }, () => page.getContinuation());
      }
      truncated ||= page?.has_continuation === true || advertisedCount > items.length;
      lastError = "";
      return {
        ok: true,
        code: "playlist_imported",
        playlist: { id: playlistId, title: playlistTitle, provider: "youtube" },
        items,
        count: items.length,
        truncated
      };
    } catch (error) {
      lastError = error?.name === "TimeoutError" || error?.name === "AbortError" ? "youtube_keyless_timeout" : "youtube_playlist_unavailable";
      return { ok: false, code: "rejected", reason: lastError };
    }
  }

  return Object.freeze({ importPlaylist, resolve, status });
}

module.exports = { MAX_PLAYLIST_ITEMS, MAX_RESULTS, createRestrictedFetch, createYoutubeKeylessCatalogProvider, metric, musicVideoIds, normalCandidates, playlistItem };
