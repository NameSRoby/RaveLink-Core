// Shared metadata normalization for desktop-assisted and official Spotify lookup.
const TRACK = /^spotify:track:([A-Za-z0-9]{22})$/;
function trackUri(value) {
  const input = String(value || '').trim();
  if (TRACK.test(input)) return input;
  if (/^[A-Za-z0-9]{22}$/.test(input)) return 'spotify:track:' + input;
  try {
    const url = new URL(input), match = /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/([A-Za-z0-9]{22})\/?$/i.exec(url.pathname);
    if (url.protocol === 'https:' && url.hostname === 'open.spotify.com' && !url.username && !url.password && !url.port && match) return 'spotify:track:' + match[1];
  } catch {}
  return '';
}
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
function artworkUrl(value) {
  if (typeof value !== 'string' || value.length > 300) return '';
  if (/^spotify:image:[a-f0-9]{40}$/i.test(value)) return 'https://i.scdn.co/image/' + value.slice(14);
  return /^https:\/\/i\.scdn\.co\/image\/[a-f0-9]{40}$/i.test(value) ? value : '';
}
function candidate(raw) {
  const uri = trackUri(raw?.uri || raw?.id);
  if (!uri || typeof raw?.name !== 'string' || !clean(raw.name, 300) || raw.is_playable === false || raw.is_local === true) return null;
  const id = uri.slice('spotify:track:'.length);
  return {
    provider: 'spotify', providerItemId: id, uri, title: clean(raw.name, 300),
    artists: (Array.isArray(raw.artists) ? raw.artists : []).slice(0, 8).map(row => clean(row?.name, 100)).filter(Boolean),
    album: clean(raw.album?.name, 200), artworkUrl: artworkUrl(raw.album?.images?.[0]?.url), durationMs: Math.max(0, Math.min(86400000, Number(raw.duration_ms) || 0)),
    explicit: raw.explicit === true, isrc: /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(raw.external_ids?.isrc || '') ? raw.external_ids.isrc : '',
    sourceUrl: 'https://open.spotify.com/track/' + id
  };
}
function searchPath(query) {
  const text = clean(query, 300);
  if (!text || /https?:\/\/|spotify:/i.test(text)) return '';
  return '/search?' + new URLSearchParams({ q: text, type: 'track', limit: '10' });
}
function searchResult(body) {
  if (!Array.isArray(body?.tracks?.items)) return { ok: false, error: 'spotify_search_shape_unavailable' };
  const candidates = body.tracks.items.slice(0, 10).map(candidate).filter(Boolean);
  return { ok: true, candidates };
}
module.exports = { trackUri, candidate, searchPath, searchResult, artworkUrl };
