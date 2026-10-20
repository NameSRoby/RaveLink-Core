/** Song-aware Rave lifetime. The optional Song Request package supplies clocks,
 * never capture authority. Missing/stale/wrong-app metadata uses a finite timer.
 * A request entering the last minute covers the following song too, once only.
 * Pauses do not masquerade as track changes; seeks update the projected end.
 * Every path retains a hard 30-minute native deadline, including repeated songs.
 */
const MAX_SECONDS = 1800;
const FRESH_MS = 10000;
function song(playback, source, wallNow) {
  const p = playback?.primary;
  const provider = p?.provider || p?.candidate?.provider;
  const label = source?.label || "";
  const matches =
    source?.scope === "process_tree" &&
    ((provider === "tidal" && /tidal/i.test(label)) ||
      (provider === "spotify" && /spotify/i.test(label)) ||
      (provider === "apple-music" && /apple.?music|amplibraryagent/i.test(label)) ||
      (["youtube", "soundcloud"].includes(provider) &&
        /firefox|chrome|msedge|brave|opera|vivaldi/i.test(label)));
  const age = wallNow - p?.observedAt;
  if (
    !matches ||
    !Number.isFinite(age) ||
    age < -2000 ||
    age > FRESH_MS ||
    !["playing", "paused", "stopped", "ended"].includes(p.status) ||
    !Number.isFinite(p.positionMs) ||
    p.positionMs < 0 ||
    !Number.isFinite(p.durationMs) ||
    p.durationMs <= 0 ||
    p.durationMs > 86400000
  )
    return null;
  const title = p.title || p.candidate?.title;
  if (typeof title !== "string" || !title.trim()) return null;
  const artistInput = Array.isArray(p.artists)
    ? p.artists
    : Array.isArray(p.candidate?.artists)
      ? p.candidate.artists
      : [];
  const artists = artistInput
    .slice(0, 8)
    .filter((s) => typeof s === "string")
    .map((s) => s.slice(0, 100).normalize("NFKC").trim().toLowerCase());
  const normalizedTitle = title.slice(0, 200).normalize("NFKC").trim().toLowerCase();
  const id = typeof p.candidate?.id === "string" ? p.candidate.id.slice(0, 200) : "";
  const identity = JSON.stringify(id ? [provider, id] : [provider, normalizedTitle, artists]);
  return {
    identity,
    trackId: id,
    artists,
    normalizedTitle,
    provider,
    title: title.slice(0, 200),
    status: p.status,
    duration: p.durationMs,
    position: Math.min(
      p.durationMs,
      p.positionMs + (p.status === "playing" ? Math.max(0, age) : 0),
    ),
  };
}
function createLifetime({ design, request, source, playback, now, wallNow }) {
  const fallback =
    design.raveDurationMode === "separate"
      ? design.raveSeconds
      : (request.seconds ?? design.raveSeconds);
  let current = design.raveDurationMode === "song" ? song(playback, source, wallNow) : null;
  if (current?.status !== "playing") current = null;
  let mode = current ? "song" : design.raveDurationMode === "separate" ? "separate" : "dynamic";
  let next = !!current && current.duration - current.position <= 60000;
  let phase = next ? "current_then_next" : current ? "current_song" : "timer";
  const capAt = now + (current ? MAX_SECONDS : fallback) * 1000;
  let deadline =
    current && !next ? now + current.duration - current.position : current ? null : capAt;
  let lastGood = now;
  let waitingSince = null;
  const reason = current
    ? "song_linked"
    : design.raveDurationMode === "song"
      ? "song_timing_unavailable"
      : design.raveDurationMode === "separate"
        ? "separate_timer"
        : "dynamic_timer";
  const startProvider = current?.provider;
  function update(playback, at, wall) {
    if (at >= capAt) return "music_duration_limit";
    if (mode !== "song") return at >= deadline ? "music_timer_ended" : null;
    const incoming = song(playback, source, wall);
    if (!incoming) {
      if (at - lastGood >= FRESH_MS) {
        mode = "fallback";
        phase = "metadata_lost";
        deadline = Math.min(capAt, at + fallback * 1000);
      }
      return null;
    }
    if (incoming.provider !== startProvider) return "music_song_source_changed";
    lastGood = at;
    const replay =
      incoming.identity === current.identity &&
      current.position >= current.duration - 2500 &&
      incoming.position < 5000;
    const enrichment =
      !incoming.trackId &&
      !current.trackId &&
      incoming.normalizedTitle === current.normalizedTitle &&
      (!incoming.artists.length || !current.artists.length);
    if ((incoming.identity !== current.identity && !enrichment) || replay) {
      if (!next) return "music_song_ended";
      next = false;
      waitingSince = null;
      phase = "following_song";
      current = incoming;
    } else current = incoming;
    if (["stopped", "ended"].includes(current.status)) return "music_playback_stopped";
    if (current.status === "paused") {
      deadline = null;
      return null;
    }
    if (next && current.position >= current.duration) {
      waitingSince ??= at;
      if (at - waitingSince >= 30000) return "music_following_song_unavailable";
    } else waitingSince = null;
    if (!next) deadline = Math.min(capAt, at + current.duration - current.position);
    // Position clamped at the end cannot repeatedly postpone expiry forever.
    return !next && current.position >= current.duration && at >= deadline
      ? "music_song_ended"
      : null;
  }
  return {
    seconds: current ? MAX_SECONDS : fallback,
    update,
    snapshot(at) {
      return {
        mode,
        reason,
        phase,
        title: current?.title || null,
        includesNext: next,
        remainingSeconds: deadline === null ? null : Math.max(0, Math.ceil((deadline - at) / 1000)),
        safetyRemainingSeconds: Math.max(0, Math.ceil((capAt - at) / 1000)),
        fallbackSeconds: fallback,
      };
    },
  };
}
module.exports = { createLifetime, song, MAX_SECONDS };
