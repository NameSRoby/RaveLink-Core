/** Private, bounded song rules and viewer submissions. No provider requests or
 * capture grants are made here; links identify songs without fetching a page. */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const clean = (s, max = 200) => {
  if (typeof s !== "string" || s.length > max || /[\x00-\x1f<>]/.test(s))
    fail("invalid_music_song");
  return s.normalize("NFKC").trim();
};
const normalized = (s) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const id = () => crypto.randomBytes(8).toString("hex");
function linkIdentity(text) {
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port)
    fail("invalid_music_song_link");
  const host = u.hostname.toLowerCase(),
    parts = u.pathname.split("/").filter(Boolean);
  let provider, trackId;
  if (["open.spotify.com", "spotify.com"].includes(host)) {
    provider = "spotify";
    trackId = /(?:^|\/)track\/([A-Za-z0-9]{22})(?:\/|$)/.exec(u.pathname)?.[1];
  } else if (["tidal.com", "www.tidal.com", "listen.tidal.com"].includes(host)) {
    provider = "tidal";
    trackId = /(?:^|\/)track\/(\d+)(?:\/|$)/.exec(u.pathname)?.[1];
  } else if (["youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
    provider = "youtube";
    trackId = host === "youtu.be" ? parts[0] : u.searchParams.get("v");
    if (!/^[A-Za-z0-9_-]{11}$/.test(trackId || "")) trackId = null;
  } else if (["soundcloud.com", "www.soundcloud.com"].includes(host) && parts.length === 2) {
    provider = "soundcloud";
    trackId = parts.join("/");
  }
  if (!provider || !trackId) fail("invalid_music_song_link");
  return {
    provider,
    trackId,
    url:
      u.origin +
      u.pathname +
      (provider === "youtube" && host !== "youtu.be" ? "?v=" + trackId : ""),
  };
}
function songInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_music_song");
  const url = clean(value.url || "", 500);
  const linked = url ? linkIdentity(url) : null;
  if (url && !linked) fail("invalid_music_song_link");
  const title = clean(value.title || linked?.trackId || ""),
    artist = clean(value.artist || "");
  if (!title || (!artist && !linked && !value.trackId)) fail("music_song_artist_required");
  const provider = linked?.provider || value.provider || "any";
  if (!["any", "youtube", "spotify", "tidal", "soundcloud", "apple-music"].includes(provider))
    fail("invalid_music_song");
  const trackId = linked?.trackId || clean(value.trackId || "", 300);
  const effectId = clean(value.effectId || "", 64);
  if (effectId && !/^[a-zA-Z0-9_-]{1,64}$/.test(effectId)) fail("invalid_music_song");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") fail("invalid_music_song");
  const intensity =
    value.intensity == null || value.intensity === "" ? null : Number(value.intensity);
  if (intensity !== null && (!Number.isFinite(intensity) || intensity < 0 || intensity > 1))
    fail("invalid_music_song");
  return {
    title,
    artist,
    provider,
    trackId,
    url: linked?.url || "",
    effectId,
    intensity,
    enabled: value.enabled !== false,
  };
}
function currentSong(playback, now = Date.now()) {
  const p = playback?.primary,
    age = now - p?.observedAt;
  if (
    !p ||
    !Number.isFinite(age) ||
    age < -2000 ||
    age > 10000 ||
    !["playing", "paused", "stopped", "ended"].includes(p.status)
  )
    return null;
  try {
    const title = clean(p.title || p.candidate?.title || "");
    if (!title) return null;
    const artists = p.artists || p.candidate?.artists || [];
    const provider = p.provider || p.candidate?.provider;
    if (!["youtube", "spotify", "tidal", "soundcloud", "apple-music"].includes(provider))
      return null;
    const raw = p.candidate?.providerItemId || p.providerItemId || p.candidate?.id || "";
    const candidateId = clean(raw, 300).replace(new RegExp("^" + provider + "(?::track)?[:/]"), "");
    const patterns = {
      spotify: /^[A-Za-z0-9]{22}$/,
      tidal: /^\d{1,20}$/,
      youtube: /^[A-Za-z0-9_-]{11}$/,
      soundcloud: /^(?:\d{1,20}|[^/\s]+\/[^/\s]+)$/,
      "apple-music": /^\d{1,20}$/,
    };
    const trackId = patterns[provider].test(candidateId) ? candidateId : "";
    return {
      title,
      artist: clean(artists.join(", ")),
      provider,
      trackId,
      status: p.status,
      positionMs: Number.isFinite(p.positionMs) ? p.positionMs : null,
      durationMs: Number.isFinite(p.durationMs) ? p.durationMs : null,
      key: JSON.stringify([
        provider,
        trackId || normalized(title),
        trackId ? "" : normalized(artists.join(", ")),
      ]),
    };
  } catch {
    return null;
  }
}
function matches(rule, song) {
  if (!song || (rule.provider !== "any" && rule.provider !== song.provider)) return false;
  if (
    rule.trackId &&
    song.trackId &&
    !(rule.provider === "soundcloud" && rule.trackId.includes("/") && /^\d+$/.test(song.trackId))
  )
    return rule.trackId === song.trackId;
  return (
    !!rule.artist &&
    normalized(rule.title) === normalized(song.title) &&
    normalized(rule.artist) === normalized(song.artist)
  );
}
module.exports = function createSongLibrary({ storePath, now = Date.now } = {}) {
  let state = {
      version: 1,
      enabled: false,
      viewerSongs: "allow",
      viewerEffects: "allow",
      songs: [],
      pending: [],
    },
    recovered = false;
  function validate(v) {
    if (
      !v ||
      v.version !== 1 ||
      typeof v.enabled !== "boolean" ||
      !["allow", "approval", "disabled"].includes(v.viewerSongs) ||
      !["allow", "approval", "disabled"].includes(v.viewerEffects) ||
      !Array.isArray(v.songs) ||
      v.songs.length > 500 ||
      !Array.isArray(v.pending) ||
      v.pending.length > 32
    )
      fail("invalid_music_song_library");
    const ids = new Set();
    for (const row of [...v.songs, ...v.pending]) {
      if (!/^[a-f0-9]{16}$/.test(row.id) || ids.has(row.id)) fail("invalid_music_song_library");
      ids.add(row.id);
    }
    for (const row of v.songs) songInput(row);
    for (const row of v.pending) {
      if (!["song", "effect"].includes(row.kind) || !row.value) fail("invalid_music_song_library");
      if (row.kind === "song") songInput(row.value);
    }
    return structuredClone(v);
  }
  if (storePath && fs.existsSync(storePath))
    try {
      const stat = fs.lstatSync(storePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576)
        fail("invalid_music_song_library");
      state = validate(JSON.parse(fs.readFileSync(storePath, "utf8")));
    } catch {
      recovered = true;
    }
  function commit(next) {
    next = validate(next);
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > 1048576) fail("music_song_library_full");
    if (storePath) {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath + ".tmp", text + "\n", { mode: 0o600 });
      fs.renameSync(storePath + ".tmp", storePath);
    }
    state = next;
    recovered = false;
    return snapshot();
  }
  const snapshot = () => ({ ...structuredClone(state), recovered });
  function upsert(value) {
    const next = snapshot();
    delete next.recovered;
    const song = songInput(value);
    const duplicate = next.songs.find(
      (r) =>
        r.id !== value.id &&
        matches(r, song) &&
        (r.trackId === song.trackId || (!r.trackId && !song.trackId)),
    );
    if (duplicate) fail("music_song_already_saved");
    if (value.id) {
      const index = next.songs.findIndex((r) => r.id === value.id);
      if (index < 0) fail("music_song_not_found");
      next.songs[index] = { ...song, id: value.id };
    } else next.songs.push({ ...song, id: id() });
    return commit(next);
  }
  let lastSubmission = -Infinity;
  return {
    snapshot,
    upsert,
    configure(value) {
      if (
        !value ||
        Object.keys(value).some((k) => !["enabled", "viewerSongs", "viewerEffects"].includes(k))
      )
        fail("invalid_music_song_policy");
      return commit({ ...state, ...value });
    },
    remove(songId) {
      if (!state.songs.some((s) => s.id === songId)) fail("music_song_not_found");
      return commit({ ...state, songs: state.songs.filter((s) => s.id !== songId) });
    },
    submit(kind, value, apply) {
      const mode = kind === "song" ? state.viewerSongs : state.viewerEffects;
      if (mode === "disabled") fail("music_viewer_saving_disabled");
      if (now() - lastSubmission < 5000) fail("music_save_cooldown");
      if (kind === "song") value = songInput(value);
      if (mode === "approval") {
        commit({ ...state, pending: [...state.pending, { id: id(), kind, value }] });
      } else apply(value);
      lastSubmission = now();
      return { pending: mode === "approval" };
    },
    review({ id: pendingId, accept }, apply) {
      const row = state.pending.find((p) => p.id === pendingId);
      if (!row || typeof accept !== "boolean") fail("invalid_music_submission");
      if (accept) apply(row.kind, row.value);
      return commit({ ...state, pending: state.pending.filter((p) => p.id !== pendingId) });
    },
  };
};
module.exports.currentSong = currentSong;
module.exports.matches = matches;
module.exports.songInput = songInput;
