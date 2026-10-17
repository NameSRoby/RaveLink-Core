/**
 * Portable track.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
const crypto = require("node:crypto");
const text = (value, max) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
const PROVIDERS = ["youtube", "tidal", "spotify", "soundcloud", "apple-music", "local"];
function normalizeTrack(row, now = Date.now()) {
  const input = row?.candidate || row || {};
  const provider = input.provider || (input.providerItemId ? "youtube" : "local");
  if (!PROVIDERS.includes(provider)) return null;
  const providerItemId = text(input.providerItemId, 160);
  if (
    (provider !== "local" && !providerItemId) ||
    (provider === "youtube" && !/^[A-Za-z0-9_-]{11}$/.test(providerItemId))
  )
    return null;
  if (provider !== "local" && !/^[A-Za-z0-9_:.-]{1,160}$/.test(providerItemId)) return null;
  const title = text(input.title, 300) || providerItemId;
  if (!title) return null;
  let sourceUrl = "";
  if (provider === "youtube") sourceUrl = "https://www.youtube.com/watch?v=" + providerItemId;
  else if (provider === "tidal")
    sourceUrl = "https://tidal.com/track/" + encodeURIComponent(providerItemId);
  else if (input.sourceUrl) {
    try {
      const url = new URL(input.sourceUrl);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        ["open.spotify.com", "soundcloud.com", "music.apple.com"].includes(url.hostname)
      )
        sourceUrl = url.href.slice(0, 500);
    } catch {}
  }
  const candidate = {
    provider,
    providerItemId,
    title,
    artists: Array.isArray(input.artists)
      ? input.artists
          .slice(0, 8)
          .map((value) => text(value, 100))
          .filter(Boolean)
      : [],
    album: text(input.album, 200),
    durationMs: Math.max(0, Math.min(86400000, Number(input.durationMs) || 0)),
    sourceUrl,
    isrc: /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(String(input.isrc || "").toUpperCase())
      ? input.isrc.toUpperCase()
      : "",
    version: text(input.version, 100),
    genres: (Array.isArray(input.genres) ? input.genres : [])
      .slice(0, 8)
      .map((value) => text(value, 60))
      .filter(Boolean),
  };
  const artwork =
    provider === "soundcloud" ? require("./player-artwork").soundcloud(input.artworkUrl) : "";
  if (artwork) candidate.artworkUrl = artwork;
  const identity = providerItemId
    ? provider + ":" + providerItemId
    : "local:" +
      crypto.createHash("sha256").update(JSON.stringify(candidate)).digest("hex").slice(0, 24);
  return {
    id: /^pl_[A-Za-z0-9_-]{1,64}$/.test(row?.id || "")
      ? row.id
      : "pl_" + crypto.randomUUID().replace(/-/g, ""),
    identity,
    addedAt: Number(row?.addedAt) || now,
    candidate,
  };
}
module.exports = { normalizeTrack, text, PROVIDERS };
