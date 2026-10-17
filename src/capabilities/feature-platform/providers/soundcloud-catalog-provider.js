/**
 * Soundcloud catalog provider.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
const {
  confidence,
  derivativeAllowed,
  normalizePolicy,
  DERIVATIVES,
} = require("./youtube-catalog-provider");
const text = (value, max = 200) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
function publicTrackLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^\/[\w-]+\/[\w-]+\/?$/.test(url.pathname) &&
      !/\/(sets|likes|tracks|albums)\/?$/.test(url.pathname)
      ? "https://soundcloud.com" + url.pathname.replace(/\/$/, "")
      : "";
  } catch {
    return "";
  }
}
function readPage(html, query, direct) {
  const match = /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("soundcloud_search_page_changed");
  let page;
  try {
    page = JSON.parse(match[1]).props?.pageProps;
  } catch {
    throw new Error("soundcloud_search_page_changed");
  }
  const entities = page?.initialStoreState?.entities;
  if (!entities?.tracks || typeof entities.tracks !== "object")
    throw new Error("soundcloud_search_page_changed");
  if (direct)
    return Object.values(entities.tracks)
      .map((row) => row?.data)
      .filter((track) => publicTrackLink(track?.permalink_url) === direct)
      .slice(0, 1)
      .map((track) => ({ track, users: entities.users || {} }));
  const collection = entities.searchResultsCollections?.["sounds:" + query]?.data?.collection;
  if (!Array.isArray(collection)) throw new Error("soundcloud_search_page_changed");
  return collection
    .slice(0, 10)
    .filter((row) => row?.schema === "track")
    .map((row) => ({
      track: entities.tracks[row.id]?.data,
      users: entities.users || {},
    }))
    .filter((row) => row.track);
}
function select(rows, query, policy, direct, transfer = false) {
  const ranked = rows
    .map(({ track, users }, index) => {
      const id = String(track.id || ""),
        link = publicTrackLink(track.permalink_url);
      const user = users["soundcloud:users:" + track.user_id]?.data || {};
      const artist = text(track.publisher_metadata?.artist || user.username, 100);
      const title = text(track.title),
        durationMs = Math.trunc(Number(track.duration) || 0);
      if (
        !/^[1-9]\d{0,19}$/.test(id) ||
        !title ||
        !link ||
        track.kind !== "track" ||
        track.sharing !== "public" ||
        track.streamable !== true ||
        track.state !== "finished" ||
        !["ALLOW", "MONETIZE"].includes(track.policy) ||
        track.embeddable_by !== "all" ||
        durationMs < 1 ||
        durationMs > 86400000 ||
        Number(track.full_duration) > durationMs + 2000
      )
        return null;
      const score = direct
        ? 1
        : confidence(query, [artist, title].filter(Boolean).join(" "), index);
      const queryWords = query.split(/[^\p{L}\p{N}]+/u).filter(Boolean),
        artistWords = artist.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      let artistPrefix = 0;
      for (let count = 1; count <= Math.min(artistWords.length, queryWords.length - 1); count++) {
        if (
          confidence(
            queryWords.slice(0, count).join(" "),
            artistWords.slice(0, count).join(" "),
            0,
          ) >= 0.7
        )
          artistPrefix = count;
      }
      const variantQuery = queryWords.slice(artistPrefix).join(" ");
      const coreQuery = Object.values(DERIVATIVES)
        .reduce((value, pattern) => value.replace(pattern, " "), variantQuery)
        .trim();
      const coreMatches =
        coreQuery &&
        confidence(coreQuery, title, 0) >=
          Math.max(transfer ? 0.4 : 0.65, policy.minimumConfidence);
      const requestedVersions = Object.values(DERIVATIVES).every(
        (pattern) => !pattern.test(variantQuery) || pattern.test(title),
      );
      const freestyle = /\bfreestyle\b/i;
      const versionAllowed =
        direct ||
        (coreMatches &&
          derivativeAllowed(query, title, policy).ok &&
          requestedVersions &&
          (!policy.derivatives.cover || !freestyle.test(title) || freestyle.test(query)));
      return {
        candidate: {
          provider: "soundcloud",
          providerItemId: id,
          title,
          artists: artist ? [artist] : [],
          durationMs,
          album: text(track.publisher_metadata?.album_title),
          sourceUrl: link,
          artworkUrl: /^https:\/\/i1\.sndcdn\.com\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/.test(
            String(track.artwork_url || ""),
          )
            ? track.artwork_url.slice(0, 500)
            : "",
        },
        score,
        versionAllowed,
        verified: user.verified === true,
        tooLong: durationMs > policy.maxDurationMs,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || Number(b.verified) - Number(a.verified));
  const eligible = ranked.filter(
    (row) => row.score >= policy.minimumConfidence && row.versionAllowed,
  );
  const best = eligible[0];
  if (best?.tooLong) return { ok: false, code: "rejected", reason: "duration_limit" };
  if (!best)
    return {
      ok: false,
      code: "rejected",
      reason: "soundcloud_no_eligible_match",
    };
  return {
    ok: true,
    candidate: best.candidate,
    ...(transfer
      ? {
          candidates: eligible.slice(0, 3).map((row) => ({
            ...row.candidate,
            matchConfidence: Math.round(row.score * 100),
          })),
        }
      : {}),
    evidence: {
      resolver: "public-mobile-page",
      confidence: Number(best.score.toFixed(3)),
      verifiedUploader: best.verified,
    },
  };
}
module.exports = function createSoundCloudCatalog(options = {}) {
  const fetchImpl = options.fetchImpl || fetch,
    now = options.now || Date.now;
  const cache = new Map(),
    pending = new Map(),
    recent = [];
  let upstreamRetryAt = 0;
  async function page(url) {
    const response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(7000),
      headers: { accept: "text/html", "accept-language": "en" },
    });
    if (response.status === 429) {
      const header = response.headers?.get("retry-after"),
        seconds = header?.trim() ? Number(header) : NaN;
      const delay = Number.isFinite(seconds)
        ? seconds >= 0
          ? seconds * 1000
          : NaN
        : Date.parse(header) - now();
      const retryAfterMs = Number.isFinite(delay) ? Math.max(1000, Math.ceil(delay)) : 60000;
      upstreamRetryAt = Math.max(upstreamRetryAt, now() + retryAfterMs);
      throw Object.assign(new Error("soundcloud_search_rate_limited"), {
        retryAfterMs,
        rateLimitSource: "soundcloud",
      });
    }
    if (!response.ok) throw new Error("soundcloud_search_unavailable");
    if (!/text\/html/i.test(response.headers?.get("content-type") || ""))
      throw new Error("soundcloud_search_page_changed");
    const chunks = [];
    let size = 0;
    if (typeof response.body === "string" || ArrayBuffer.isView(response.body)) {
      const buffer =
        typeof response.body === "string"
          ? Buffer.from(response.body)
          : Buffer.from(response.body.buffer, response.body.byteOffset, response.body.byteLength);
      if (buffer.length > 1048576) throw new Error("soundcloud_search_response_too_large");
      chunks.push(buffer);
    } else
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 1048576) throw new Error("soundcloud_search_response_too_large");
        chunks.push(buffer);
      }
    return Buffer.concat(chunks).toString("utf8");
  }
  async function resolve(input = {}) {
    if (
      typeof input.query !== "string" ||
      input.query.length > 256 ||
      input.query.trim().length < 2 ||
      /[\u0000-\u001f\u007f]/.test(input.query)
    )
      return { ok: false, reason: "soundcloud_query_invalid" };
    const query = text(input.query, 256),
      direct = publicTrackLink(query),
      policy = normalizePolicy({
        ...input.policy,
        maxDurationMs: input.maxDurationMs || input.policy?.maxDurationMs,
      });
    if (!direct && /(?:https?:\/\/|www\.|soundcloud\.com\/)/i.test(query))
      return { ok: false, reason: "soundcloud_link_invalid" };
    const comparison =
      input.transfer === true && typeof input.matchQuery === "string"
        ? text(input.matchQuery, 256)
        : query;
    const key = direct || query;
    const cached = cache.get(key);
    if (cached && now() - cached.at < 300000)
      return select(cached.rows, comparison, policy, direct, input.transfer === true);
    let operation = pending.get(key);
    if (!operation) {
      if (upstreamRetryAt > now())
        return {
          ok: false,
          reason: "soundcloud_search_rate_limited",
          rateLimitSource: "soundcloud",
          retryAfterMs: Math.max(1000, upstreamRetryAt - now()),
        };
      while (recent.length && now() - recent[0] >= 60000) recent.shift();
      if (recent.length >= 60)
        return {
          ok: false,
          reason: "soundcloud_search_rate_limited",
          rateLimitSource: "local",
          retryAfterMs: Math.max(1000, 60000 - (now() - recent[0])),
        };
      if (pending.size >= 2)
        return {
          ok: false,
          reason: "soundcloud_search_busy",
          rateLimitSource: "concurrency",
          retryAfterMs: 1000,
        };
      recent.push(now());
      const url = new URL(
        "https://m.soundcloud.com" + (direct ? new URL(direct).pathname : "/search/sounds"),
      );
      if (!direct) url.searchParams.set("q", query);
      const run = async () => {
        const rows = readPage(await page(url), query, direct);
        // Retain only matching metadata in memory: never cache web authentication or stream URLs.
        const compact = rows.map(({ track, users }) => {
          const id = String(track.id || "").slice(0, 20),
            userId = String(track.user_id || "").slice(0, 20),
            user = users["soundcloud:users:" + userId]?.data || {};
          return {
            track: {
              id,
              user_id: userId,
              kind: text(track.kind, 20),
              title: text(track.title),
              permalink_url: text(track.permalink_url, 500),
              publisher_metadata: {
                artist: text(track.publisher_metadata?.artist, 100),
                album_title: text(track.publisher_metadata?.album_title),
              },
              duration: Number(track.duration) || 0,
              full_duration: Number(track.full_duration) || 0,
              sharing: text(track.sharing, 20),
              state: text(track.state, 20),
              streamable: track.streamable === true,
              policy: text(track.policy, 20),
              embeddable_by: text(track.embeddable_by, 20),
              artwork_url: text(track.artwork_url, 500),
            },
            users: {
              ["soundcloud:users:" + userId]: {
                data: {
                  username: text(user.username, 100),
                  verified: user.verified === true,
                },
              },
            },
          };
        });
        cache.set(key, { at: now(), rows: compact });
        while (cache.size > 100) cache.delete(cache.keys().next().value);
        return compact;
      };
      operation = options.egressGovernor
        ? options.egressGovernor.run(
            {
              owner: "provider.external",
              priority: "optional",
              queueDeadlineMs: 1000,
            },
            run,
          )
        : run();
      pending.set(key, operation);
      operation.finally(() => pending.delete(key)).catch(() => {});
    }
    try {
      return select(await operation, comparison, policy, direct, input.transfer === true);
    } catch (error) {
      return {
        ok: false,
        ...(error.rateLimitSource
          ? {
              rateLimitSource: error.rateLimitSource,
              retryAfterMs: error.retryAfterMs,
            }
          : {}),
        reason: /^soundcloud_/.test(error.message)
          ? error.message
          : error.name === "TimeoutError" || error.name === "AbortError"
            ? "soundcloud_search_timeout"
            : "soundcloud_search_unavailable",
      };
    }
  }
  return { resolve };
};
module.exports.readPage = readPage;
module.exports.select = select;
module.exports.publicTrackLink = publicTrackLink;
