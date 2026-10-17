/**
 * Official adapter.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
// Official Premium playback transport. OAuth tokens stay in the local host.
const { trackUri, searchPath, searchResult } = require("./catalog.cjs");
module.exports = function createSpotifyOfficialAdapter(options = {}) {
  const requestFetch = options.fetch || globalThis.fetch,
    getToken = options.getAccessToken;
  let serial = Promise.resolve(),
    retryAt = 0;
  const now = typeof options.now === "function" ? options.now : Date.now;
  async function request(route, method = "GET") {
    if (now() < retryAt)
      return {
        ok: false,
        error: "spotify_rate_limited",
        retryAfterMs: retryAt - now(),
        retrySafe: method === "GET",
      };
    let token;
    try {
      token = await getToken?.();
    } catch {}
    if (typeof token !== "string" || !token || /[\r\n]/.test(token))
      return { ok: false, error: "spotify_sign_in_required" };
    try {
      const response = await requestFetch("https://api.spotify.com/v1" + route, {
        method,
        headers: {
          authorization: "Bearer " + token,
          accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 429) {
        const raw = response.headers.get("retry-after"),
          seconds = raw?.trim() ? Number(raw) : NaN;
        const delay = Number.isFinite(seconds)
          ? Math.max(1000, seconds * 1000)
          : Math.max(1000, Date.parse(raw || "") - now() || 30000);
        retryAt = now() + Math.min(86400000, delay);
        return {
          ok: false,
          error: "spotify_rate_limited",
          retryAfterMs: Math.min(86400000, delay),
          retrySafe: method === "GET",
        };
      }
      if (response.status === 401) return { ok: false, error: "spotify_sign_in_required" };
      if (response.status === 403)
        return { ok: false, error: "spotify_account_or_app_access_required" };
      if (!response.ok)
        return {
          ok: false,
          error:
            method !== "GET" && response.status >= 500
              ? "spotify_delivery_unconfirmed"
              : "spotify_api_rejected",
          status: response.status,
          retrySafe: method === "GET",
        };
      if (response.status === 204) return { ok: true, accepted: true };
      return {
        ok: true,
        value: await require("./oauth.cjs").boundedJSON(response),
      };
    } catch {
      return {
        ok: false,
        error: method === "GET" ? "spotify_api_unavailable" : "spotify_delivery_unconfirmed",
        retrySafe: method === "GET",
      };
    }
  }
  return {
    capabilities: Object.freeze({
      mode: "official",
      queueAppend: true,
      queueRemoval: false,
      search: true,
      requiresPremium: true,
      liveVerified: false,
    }),
    async search(query) {
      const path = searchPath(query);
      if (!path) return { ok: false, error: "spotify_search_query_invalid" };
      const result = await request(path);
      return result.ok ? searchResult(result.value) : result;
    },
    async queue() {
      return request("/me/player/queue");
    },
    async profile() {
      return request("/me");
    },
    async playback() {
      return request("/me/player");
    },
    async devices() {
      return request("/me/player/devices");
    },
    async lookup(value) {
      const uri = trackUri(value);
      if (!uri) return { ok: false, error: "spotify_track_invalid" };
      const result = await request("/tracks/" + uri.slice(14));
      return result.ok ? searchResult({ tracks: { items: [result.value] } }) : result;
    },
    async control(input, deviceId) {
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(deviceId || ""))
        return { ok: false, error: "spotify_device_selection_required" };
      const actions = {
          pause: ["pause", "PUT"],
          resume: ["play", "PUT"],
          skip: ["next", "POST"],
          volume: ["volume", "PUT"],
        },
        action = actions[input.action];
      if (
        !action ||
        (input.action === "volume" &&
          (!Number.isInteger(input.value) || input.value < 0 || input.value > 100))
      )
        return { ok: false, error: "spotify_command_invalid" };
      return request(
        "/me/player/" +
          action[0] +
          "?" +
          new URLSearchParams({
            device_id: deviceId,
            ...(input.action === "volume" ? { volume_percent: input.value } : {}),
          }),
        action[1],
      );
    },
    append(value, deviceId) {
      const action = async () => {
        const uri = trackUri(value);
        if (!uri) return { ok: false, error: "spotify_track_invalid" };
        if (typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(deviceId))
          return { ok: false, error: "spotify_device_selection_required" };
        const result = await request(
          "/me/player/queue?" + new URLSearchParams({ uri, device_id: deviceId }),
          "POST",
        );
        return result.ok
          ? {
              ok: true,
              delivery: "accepted_unconfirmed",
              uri,
              retrySafe: false,
            }
          : result;
      };
      const result = serial.then(action);
      serial = result.catch(() => {});
      return result;
    },
    async remove() {
      return { ok: false, error: "spotify_queue_removal_unsupported" };
    },
  };
};
