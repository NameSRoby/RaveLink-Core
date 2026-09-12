const SPOTIFY_TRACK_ID_RE = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_HOSTS = new Set(["open.spotify.com", "spotify.link"]);

function clean(value, maximum = 500) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function classifySongInput(value) {
  const input = clean(value, 500);
  const containsUrl = /(?:https?:\/\/|\bwww\.)/i.test(input);
  if (!containsUrl) return { ok: true, kind: "text", query: input };

  let url;
  try { url = new URL(input); } catch { return { ok: false, reason: "catalog_untrusted_link" }; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !SPOTIFY_HOSTS.has(host) || url.username || url.password) {
    return { ok: false, reason: "catalog_untrusted_link" };
  }

  if (host === "spotify.link") {
    return /^\/[A-Za-z0-9_-]{3,100}\/?$/.test(url.pathname)
      ? { ok: true, kind: "spotify_short", url: url.href }
      : { ok: false, reason: "spotify_track_required" };
  }

  const match = /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/([A-Za-z0-9]{22})\/?$/i.exec(url.pathname);
  if (!match || !SPOTIFY_TRACK_ID_RE.test(match[1])) return { ok: false, reason: "spotify_track_required" };
  return { ok: true, kind: "spotify_track", url: `https://open.spotify.com/track/${match[1]}`, trackId: match[1] };
}

async function resolveSpotifySongInput(value, fetchImpl, signal) {
  const classified = classifySongInput(value);
  if (!classified.ok || classified.kind === "text") return classified;
  const endpoint = new URL("https://open.spotify.com/oembed");
  endpoint.searchParams.set("url", classified.url);
  try {
    const response = await fetchImpl(endpoint, { headers: { accept: "application/json" }, redirect: "error", signal });
    if (!response.ok) return { ok: false, reason: response.status === 404 ? "spotify_track_not_found" : "spotify_metadata_unavailable" };
    const body = await response.json().catch(() => ({}));
    const title = clean(body.title, 300);
    const embedTrack = /https:\/\/open\.spotify\.com\/embed\/track\/([A-Za-z0-9]{22})/i.exec(String(body.html || ""));
    const trackId = classified.trackId || embedTrack?.[1] || "";
    if (body.provider_name !== "Spotify" || !title || !SPOTIFY_TRACK_ID_RE.test(trackId)) {
      return { ok: false, reason: "spotify_track_required" };
    }
    return { ok: true, kind: "spotify_track", query: title, trackId };
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "youtube_api_timeout" : "spotify_metadata_unavailable" };
  }
}

module.exports = { SPOTIFY_HOSTS, SPOTIFY_TRACK_ID_RE, classifySongInput, resolveSpotifySongInput };
