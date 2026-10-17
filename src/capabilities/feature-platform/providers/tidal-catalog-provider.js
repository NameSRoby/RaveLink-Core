/**
 * Tidal catalog provider.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
const createUserOAuth = require("./tidal-user-oauth");
const { durationMs } = require("./youtube-catalog-provider");
const clean = (value, maximum) =>
  String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maximum);
module.exports = function createTidalCatalog(options = {}) {
  const fetchImpl = options.fetchImpl || fetch,
    now = options.now || Date.now;
  const cache = new Map(),
    pending = new Map(),
    searches = [];
  let generation = 0,
    lastError = "";
  const auth = createUserOAuth({ ...options, json });
  const status = () => ({
    ...auth.status(),
    lastError: lastError || auth.status().lastError,
    cacheEntries: cache.size,
  });
  function reset() {
    generation++;
    cache.clear();
    lastError = "";
  }
  function configure(input = {}) {
    const result = auth.configure(input);
    if (result.ok) reset();
    return result;
  }
  async function json(url, init, signal) {
    const response = await fetchImpl(url, {
      ...init,
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      const tokenCall = new URL(url).hostname === "auth.tidal.com";
      const tokenFailure = tokenCall && [400, 401, 403].includes(response.status);
      throw new Error(
        response.status === 429
          ? "tidal_search_rate_limited"
          : tokenFailure
            ? init.body.get("grant_type") === "refresh_token"
              ? "tidal_oauth_refresh_rejected"
              : "tidal_oauth_exchange_rejected"
            : response.status === 401
              ? "tidal_api_credentials_rejected"
              : response.status === 403
                ? "tidal_catalog_access_denied"
                : "tidal_catalog_unavailable",
      );
    }
    if (response.status === 204) return {};
    let bytes = 0;
    const chunks = [];
    if (typeof response.body === "string" || ArrayBuffer.isView(response.body)) {
      const body =
        typeof response.body === "string"
          ? Buffer.from(response.body)
          : Buffer.from(response.body.buffer, response.body.byteOffset, response.body.byteLength);
      if (body.length > 524288) throw new Error("tidal_catalog_response_invalid");
      chunks.push(body);
    } else {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 524288) throw new Error("tidal_catalog_response_invalid");
        chunks.push(Buffer.from(chunk));
      }
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("tidal_catalog_response_invalid");
    }
  }
  async function api(endpoint, params = {}, signal = AbortSignal.timeout(10000), write = null) {
    const url = new URL("https://openapi.tidal.com/v2/" + endpoint);
    for (const [key, value] of Object.entries({
      ...(!write ? { countryCode: status().countryCode } : {}),
      ...params,
    }))
      url.searchParams.set(key, value);
    for (let attempt = 0; attempt < 2; attempt++) {
      const bearer = await auth.authorize(signal, attempt > 0);
      try {
        return await json(
          url,
          {
            headers: {
              accept: "application/vnd.api+json",
              authorization: "Bearer " + bearer,
              ...(write
                ? {
                    "content-type": "application/vnd.api+json",
                    "Idempotency-Key": write.key,
                  }
                : {}),
            },
            ...(write ? { method: write.method, body: JSON.stringify(write.body) } : {}),
          },
          signal,
        );
      } catch (error) {
        if (attempt || error.message !== "tidal_api_credentials_rejected") throw error;
      }
    }
  }
  async function search(query) {
    if (typeof query !== "string" || query.length < 2 || query.length > 256)
      return { ok: false, error: "tidal_query_invalid" };
    if (!status().connected) return { ok: false, error: "tidal_oauth_sign_in_required" };
    const countryCode = status().countryCode;
    const key = countryCode + ":" + query.toLowerCase(),
      existing = cache.get(key);
    if (existing && existing.until > now())
      return { ok: true, candidates: structuredClone(existing.candidates) };
    if (pending.has(key)) return pending.get(key);
    while (searches.length && searches[0] <= now() - 60000) searches.shift();
    if (searches.length >= 10 || pending.size >= 8)
      return { ok: false, error: "tidal_search_rate_limited" };
    searches.push(now());
    const revision = generation,
      country = countryCode;
    const operation = async () => {
      try {
        const signal = AbortSignal.timeout(10000);
        const results = await api(
          "searchResults",
          { "filter[query]": query, countryCode: country, include: "tracks" },
          signal,
        );
        const root = Array.isArray(results.data) ? results.data[0] : results.data;
        const references = root?.relationships?.tracks?.data;
        if (!Array.isArray(references)) throw new Error("tidal_catalog_response_invalid");
        const ids = references
          .slice(0, 5)
          .filter((row) => row.type === "tracks" && /^[1-9][0-9]{0,19}$/.test(row.id))
          .map((row) => row.id);
        let candidates = [];
        if (ids.length) {
          // Individual track reads support third-party user OAuth; the bulk
          // endpoint currently documents an internal OAuth scope.
          const replies = await Promise.all(
            ids.map((id) =>
              api("tracks/" + id, { countryCode: country, include: "artists,albums" }, signal),
            ),
          );
          if (
            replies.some(
              (reply) =>
                !reply.data ||
                Array.isArray(reply.data) ||
                (reply.included && !Array.isArray(reply.included)),
            )
          )
            throw new Error("tidal_catalog_response_invalid");
          candidates = replies
            .map((reply, index) => {
              const row = reply.data;
              if (row.type !== "tracks" || row.id !== ids[index])
                throw new Error("tidal_catalog_response_invalid");
              const included = new Map(
                (reply.included || []).map((item) => [item.type + ":" + item.id, item]),
              );
              const attrs = row.attributes || {},
                relations = row.relationships || {};
              const artists = (relations.artists?.data || [])
                .slice(0, 8)
                .map((ref) => clean(included.get("artists:" + ref.id)?.attributes?.name, 100))
                .filter(Boolean);
              const album = relations.albums?.data?.[0];
              return {
                provider: "tidal",
                providerItemId: row.id,
                title: clean(
                  attrs.version ? `${attrs.title} (${attrs.version})` : attrs.title,
                  200,
                ),
                artists,
                durationMs: durationMs(attrs.duration),
                album: clean(included.get("albums:" + album?.id)?.attributes?.title, 200),
              };
            })
            .filter(
              (row) =>
                row.title && row.artists.length && row.durationMs > 0 && row.durationMs <= 86400000,
            );
        }
        if (revision !== generation) throw new Error("tidal_catalog_configuration_changed");
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { candidates, until: now() + 600000 });
        lastError = "";
        return { ok: true, candidates: structuredClone(candidates) };
      } catch (error) {
        lastError =
          error.name === "TimeoutError" || error.name === "AbortError"
            ? "tidal_catalog_timeout"
            : /^tidal_/.test(error.message)
              ? error.message
              : "tidal_catalog_unavailable";
        return { ok: false, error: lastError };
      }
    };
    const work = options.egressGovernor?.run
      ? options.egressGovernor
          .run(
            {
              owner: "provider.external",
              priority: "optional",
              queueDeadlineMs: 500,
            },
            operation,
          )
          .catch(() => ({ ok: false, error: "tidal_catalog_busy" }))
      : operation();
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  }
  const disconnect = () => {
    const result = auth.disconnect();
    if (result.ok) reset();
    return result;
  };
  const playlistCalls = [];
  const playlistApi = async (...args) => {
    while (playlistCalls.length && playlistCalls[0] <= now() - 60000) playlistCalls.shift();
    if (playlistCalls.length >= 60) throw new Error("tidal_playlist_rate_limited");
    playlistCalls.push(now());
    const operation = () => api(...args);
    return options.egressGovernor?.run
      ? options.egressGovernor.run(
          {
            owner: "provider.external",
            priority: "optional",
            queueDeadlineMs: 500,
          },
          operation,
        )
      : operation();
  };
  const playlists = require("./tidal-playlist-provider")({
    api: playlistApi,
    status,
    search,
  });
  return {
    status,
    configure,
    search,
    playlists,
    begin: (input) => {
      reset();
      return auth.begin(input);
    },
    "reset-client": () => {
      const result = auth.resetClient();
      if (result.ok) reset();
      return result;
    },
    callback: async (input, redirectUri) => {
      const result = await auth.callback(input, redirectUri);
      if (result.ok) reset();
      return result;
    },
    disconnect,
    clear: disconnect,
    shutdown: () => {
      reset();
      auth.shutdown();
    },
    async test() {
      try {
        const operation = async () => {
          const reply = await api(
            "searchResults",
            {
              "filter[query]": "music",
              countryCode: status().countryCode,
              include: "tracks",
            },
            AbortSignal.timeout(5000),
          );
          if (!Array.isArray(reply.data)) throw new Error("tidal_catalog_response_invalid");
        };
        if (options.egressGovernor?.run)
          await options.egressGovernor.run(
            {
              owner: "provider.external",
              priority: "optional",
              queueDeadlineMs: 500,
            },
            operation,
          );
        else await operation();
        lastError = "";
        return status();
      } catch (error) {
        lastError = /^tidal_/.test(error.message) ? error.message : "tidal_catalog_unavailable";
        return { ok: false, error: lastError };
      }
    },
  };
};
