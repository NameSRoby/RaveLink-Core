const crypto = require("node:crypto");
const { DEFAULT_OVERLAY, OVERLAY_BLOCK_KINDS, overlayFrom } = require("./overlay-config");
const { RESPONSE_KINDS } = require("./chat-responses");
const { DEFAULT_CATALOG_POLICY, catalogPolicyFrom } = require("./catalog-policy");

const SNAPSHOT_VERSION = 11;
const PLAYBACK_SOURCES = Object.freeze(["youtube", "tidal", "spotify", "apple-music"]);
const DEFAULTS = Object.freeze({ maxQueue: 200, maxRecent: 250, maxPerRequester: 5, maxPerVip: 10, maxDurationMs: 600000 });
const RECENT_REQUESTER_LIMIT = 10;
const MAX_MODERATION_ENTRIES = 250;
const PROVIDER_RE = /^[a-z][a-z0-9-]{1,39}$/;
const DRIVER_LEASE_MS = 15000;

function text(value, maximum) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function integer(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function stableId(value) {
  let hash = 2166136261;
  for (const codePoint of String(value)) {
    hash ^= codePoint.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function requesterKey(value) {
  return `req_${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function requesterRole(value) {
  return ["moderator", "vip"].includes(value) ? value : "viewer";
}

function candidateFrom(input, query) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const title = text(source.title || query, 200);
  const artists = Array.isArray(source.artists) ? source.artists.slice(0, 8).map(value => text(value, 100)).filter(Boolean) : [];
  const durationMs = integer(source.durationMs, 0, 86400000, 0);
  const providerItemId = text(source.providerItemId || stableId(`${title}\0${artists.join("\0")}`), 160);
  if (!title || !providerItemId) return null;
  const requestedProvider = text(source.provider || "manual", 40).toLowerCase();
  const provider = PROVIDER_RE.test(requestedProvider) ? requestedProvider : "manual";
  const album = text(source.album, 200);
  const artworkUrl = provider === "youtube" && /^[A-Za-z0-9_-]{11}$/.test(providerItemId)
    ? `https://i.ytimg.com/vi/${providerItemId}/hqdefault.jpg`
    : "";
  return Object.freeze({ provider, providerItemId, title, artists, album, artworkUrl, durationMs });
}

function createSongQueue(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const requestProviders = Array.isArray(options.requestProviders) ? new Set(options.requestProviders.filter(value => PROVIDER_RE.test(value))) : null;
  let sequence = 0;
  let paused = false;
  let queue = [];
  let recent = [];
  let seenRequests = [];
  let blockedRequesterKeys = [];
  let timedRequesterKeys = {};
  let blockedSongIdentities = [];
  let recentRequesters = [];
  let limits = { ...DEFAULTS };
  let volume = 100;
  let volumeFloorPercent = 0;
  let volumeCeilingPercent = 40;
  let responses = Object.fromEntries(RESPONSE_KINDS.map(kind => [kind, false]));
  let catalogPolicy = catalogPolicyFrom();
  let playbackRevision = 0;
  let overlayRevision = 0;
  let overlay = overlayFrom(DEFAULT_OVERLAY);
  let managedPlayback = null;
  let playbackEnabled = false;
  let playbackSource = "youtube";
  let playlist = [];
  let playlistMode = "off";
  let playlistCursor = 0;
  let lastPlaylistIndex = -1;
  const observations = new Map();

  function clonePlayback(value) {
    if (!value) return null;
    const out = { ...value };
    out.candidate = out.candidate ? { ...out.candidate, artists: [...out.candidate.artists] } : out.candidate;
    delete out.leaseId;
    return out;
  }

  function playbackStatus() {
    const observed = [...observations.values()].sort((a, b) => b.observedAt - a.observedAt).slice(0, 4).map(clonePlayback);
    const managed = clonePlayback(managedPlayback);
    const selected = observed.filter(row => row.provider === playbackSource && row.available);
    const playingObserved = selected.find(row => row.status === "playing");
    const primary = playbackSource === "youtube"
      ? managed?.status === "playing" ? managed : playingObserved || managed || selected[0] || null
      : playingObserved || selected[0] || null;
    return { ok: true, revision: playbackRevision, playbackSource, playbackEnabled, primary, managed, observed };
  }

  function configurePlaybackSource(payload = {}) {
    const source = text(payload.source, 40).toLowerCase();
    if (!PLAYBACK_SOURCES.includes(source)) return { ...playbackStatus(), ok: false, code: "playback_source_invalid" };
    if (source !== playbackSource) {
      playbackSource = source;
      observations.clear();
      playbackRevision += 1;
    }
    return { ...playbackStatus(), code: "playback_source_selected" };
  }

  function overlayStatus() {
    return { ok: true, revision: overlayRevision, config: JSON.parse(JSON.stringify(overlay)) };
  }

  function configureOverlay(payload = {}) {
    overlay = overlayFrom(payload.config, overlay);
    overlayRevision += 1;
    return overlayStatus();
  }

  function expireLease() {
    if (managedPlayback?.status === "loading" && managedPlayback.leaseExpiresAt <= Number(now())) {
      managedPlayback = null;
      playbackRevision += 1;
    }
  }

  function pull(payload = {}) {
    expireLease();
    const driverId = text(payload.driverId, 80);
    const providers = Array.isArray(payload.providers)
      ? payload.providers.slice(0, 8).map(value => text(value, 40).toLowerCase()).filter(value => PROVIDER_RE.test(value))
      : [];
    if (!driverId || !providers.length) return { ok: false, code: "driver_invalid" };
    if (!playbackEnabled) return { ok: true, code: "idle", action: null, revision: playbackRevision };
    if (managedPlayback) {
      if (managedPlayback.driverId !== driverId || managedPlayback.status !== "loading") return { ok: true, code: "idle", action: null, revision: playbackRevision };
      return { ok: true, code: "load", action: { leaseId: managedPlayback.leaseId, entryId: managedPlayback.entryId, origin: managedPlayback.origin || "queue", candidate: clonePlayback(managedPlayback).candidate }, revision: playbackRevision };
    }
    const queuedEntry = queue.find(row => providers.includes(row.candidate.provider));
    let entry = queuedEntry;
    let origin = "queue";
    if (!entry && playlistMode !== "off" && playlist.length && providers.includes("youtube")) {
      let index = playlistCursor % playlist.length;
      if (playlistMode === "shuffle") {
        index = Math.min(playlist.length - 1, Math.floor(random() * playlist.length));
        if (playlist.length > 1 && index === lastPlaylistIndex) index = (index + 1) % playlist.length;
      }
      lastPlaylistIndex = index;
      playlistCursor = (index + 1) % playlist.length;
      entry = playlist[index];
      origin = "playlist";
    }
    if (!entry) return { ok: true, code: "idle", action: null, revision: playbackRevision };
    const leaseId = crypto.randomBytes(18).toString("base64url");
    managedPlayback = {
      source: "managed", driverId, leaseId, leaseExpiresAt: Number(now()) + DRIVER_LEASE_MS,
      origin, entryId: entry.id, requestId: entry.requestId || "", candidate: entry.candidate,
      status: "loading", positionMs: 0, durationMs: entry.candidate.durationMs, observedAt: Number(now())
    };
    playbackRevision += 1;
    return { ok: true, code: "load", action: { leaseId, entryId: entry.id, origin, candidate: clonePlayback(managedPlayback).candidate }, revision: playbackRevision };
  }

  function acknowledge(payload = {}) {
    expireLease();
    const driverId = text(payload.driverId, 80);
    const leaseId = text(payload.leaseId, 80);
    const state = text(payload.state, 20).toLowerCase();
    if (!managedPlayback || managedPlayback.driverId !== driverId || managedPlayback.leaseId !== leaseId) return { ok: false, code: "lease_stale" };
    if (!['started', 'progress', 'ended', 'failed', 'skipped'].includes(state)) return { ok: false, code: "state_invalid" };
    const activeEntry = managedPlayback.origin === "playlist"
      ? playlist.find(row => row.id === managedPlayback.entryId)
      : queue.find(row => row.id === managedPlayback.entryId);
    const positionMs = integer(payload.positionMs, 0, 86400000, managedPlayback.positionMs);
    const durationMs = integer(payload.durationMs, 0, 86400000, managedPlayback.durationMs);
    managedPlayback = { ...managedPlayback, status: state === "started" || state === "progress" ? "playing" : state, positionMs, durationMs, observedAt: Number(now()) };
    playbackRevision += 1;
    if (state === "ended" || state === "failed" || state === "skipped") {
      const entryId = managedPlayback.entryId;
      const origin = managedPlayback.origin;
      const outcome = state === "ended" ? "played" : state === "skipped" ? "skipped" : "playback_failed";
      const index = managedPlayback.origin === "playlist" ? -1 : queue.findIndex(row => row.id === entryId);
      if (index >= 0) {
        const [entry] = queue.splice(index, 1);
        recent.push({ identity: entry.identity, outcome, at: Number(now()) });
        trimState();
      }
      managedPlayback = null;
      return { ok: true, code: state, entryId, origin, outcome, revision: playbackRevision, notifyChat: activeEntry?.chatNotify === true, entry: activeEntry || undefined };
    }
    return { ok: true, code: state, entryId: managedPlayback.entryId, revision: playbackRevision, notifyChat: activeEntry?.chatNotify === true };
  }

  function observe(payload = {}) {
    const provider = text(payload.provider, 40).toLowerCase();
    const sourceId = text(payload.sourceId, 120);
    if (!PROVIDER_RE.test(provider) || !sourceId) return { ok: false, code: "observation_invalid" };
    const key = `${provider}:${sourceId}`;
    if (payload.available === false) observations.delete(key);
    else {
      const title = text(payload.title, 200);
      if (!title) return { ok: false, code: "observation_invalid" };
      observations.set(key, {
        source: "observed", provider, sourceId, available: true, title,
        artists: Array.isArray(payload.artists) ? payload.artists.slice(0, 8).map(value => text(value, 100)).filter(Boolean) : [],
        album: text(payload.album, 200), status: ["playing", "paused", "stopped"].includes(payload.status) ? payload.status : "stopped",
        positionMs: integer(payload.positionMs, 0, 86400000, 0), durationMs: integer(payload.durationMs, 0, 86400000, 0),
        observedAt: integer(payload.observedAt, 0, Number.MAX_SAFE_INTEGER, Number(now()))
      });
      while (observations.size > 4) observations.delete(observations.keys().next().value);
    }
    playbackRevision += 1;
    return { ok: true, code: "observed", revision: playbackRevision };
  }

  function trimState() {
    queue = queue.slice(0, limits.maxQueue);
    recent = recent.slice(-limits.maxRecent);
    seenRequests = seenRequests.slice(-limits.maxRecent);
  }

  function publicState(page = {}) {
    const offset = integer(page.offset, 0, Math.max(0, queue.length), 0);
    const limit = integer(page.limit, 1, 25, 25);
    const playlistOffset = integer(page.playlistOffset, 0, Math.max(0, playlist.length), 0);
    const playlistLimit = integer(page.playlistLimit, 1, 25, 10);
    return {
      ok: true,
      version: SNAPSHOT_VERSION,
      paused,
      limits: { ...limits },
      catalogPolicy: { ...catalogPolicy, derivatives: { ...catalogPolicy.derivatives } },
      responses: { ...responses },
      queue: queue.slice(offset, offset + limit).map(row => ({ ...row, candidate: { ...row.candidate, artists: [...row.candidate.artists] } })),
      playlist: playlist.slice(playlistOffset, playlistOffset + playlistLimit).map(row => ({ ...row, candidate: { ...row.candidate, artists: [...row.candidate.artists] } })),
      playlistState: { mode: playlistMode, cursor: playlistCursor, total: playlist.length },
      playlistPage: { offset: playlistOffset, limit: playlistLimit, hasMore: playlistOffset + playlistLimit < playlist.length },
      recent: recent.slice(-limit).map(row => ({ ...row })),
      page: { offset, limit, hasMore: offset + limit < queue.length },
      moderation: {
        recentRequesters: recentRequesters.slice(-RECENT_REQUESTER_LIMIT).reverse().map(row => ({
          ...row,
          pending: queue.filter(entry => entry.requesterKey === row.requesterKey).length,
          blocked: blockedRequesterKeys.includes(row.requesterKey),
          timedOutUntil: Math.max(0, Number(timedRequesterKeys[row.requesterKey] || 0))
        })),
        blockedSongs: blockedSongIdentities.length
      },
      volume: volumeState(),
      counts: { queued: queue.length, playlist: playlist.length, recent: recent.length, blocked: blockedRequesterKeys.length, timedOut: Object.keys(timedRequesterKeys).length, blockedSongs: blockedSongIdentities.length }
    };
  }

  function rememberRequester(key, label, role) {
    recentRequesters = recentRequesters.filter(row => row.requesterKey !== key);
    recentRequesters.push({ requesterKey: key, displayName: text(label, 80) || "Twitch user", role, lastRequestedAt: Number(now()) });
    recentRequesters = recentRequesters.slice(-RECENT_REQUESTER_LIMIT);
  }

  function cleanExpiredTimeouts() {
    const timestamp = Number(now());
    timedRequesterKeys = Object.fromEntries(Object.entries(timedRequesterKeys).filter(([, expiresAt]) => Number(expiresAt) > timestamp));
  }

  function response(ok, code, details = {}) {
    return { ok, code, ...details };
  }

  function volumeState() {
    return {
      control: volume,
      outputPercent: Math.round(volumeFloorPercent + (volume * (volumeCeilingPercent - volumeFloorPercent) / 100)),
      floorPercent: volumeFloorPercent,
      ceilingPercent: volumeCeilingPercent
    };
  }

  function submit(payload = {}) {
    const requestId = text(payload.requestId, 160);
    const requesterId = text(payload.requesterId, 160);
    const query = text(payload.query, 500);
    if (!requestId || !requesterId || !query) return response(false, "rejected", { reason: "invalid_request" });
    if (seenRequests.includes(requestId)) return response(false, "duplicate", { reason: "request_replay" });
    seenRequests.push(requestId);
    trimState();
    if (paused) return response(false, "rejected", { reason: "intake_paused" });
    if (queue.length >= limits.maxQueue) return response(false, "rejected", { reason: "queue_full" });
    const requester = requesterKey(requesterId);
    const role = requesterRole(payload.requesterRole);
    cleanExpiredTimeouts();
    if (blockedRequesterKeys.includes(requester)) return response(false, "rejected", { reason: "requester_blocked" });
    if (Number(timedRequesterKeys[requester] || 0) > Number(now())) return response(false, "rejected", { reason: "requester_timed_out" });
    const requestLimit = role === "moderator" ? Number.POSITIVE_INFINITY : role === "vip" ? limits.maxPerVip : limits.maxPerRequester;
    if (queue.filter(row => row.requesterKey === requester).length >= requestLimit) {
      return response(false, "rejected", { reason: "requester_limit" });
    }
    const catalogFailure = text(payload.catalogFailure, 80);
    if (catalogFailure) return response(false, "rejected", { reason: catalogFailure });
    const candidate = candidateFrom(payload.candidate, query);
    if (!candidate) return response(false, "rejected", { reason: "candidate_invalid" });
    if (requestProviders && (!requestProviders.has(candidate.provider)
      || candidate.provider === "youtube" && !/^[A-Za-z0-9_-]{11}$/.test(candidate.providerItemId))) {
      return response(false, "rejected", { reason: "youtube_reference_required" });
    }
    if (candidate.durationMs > limits.maxDurationMs) return response(false, "rejected", { reason: "duration_limit" });
    const identity = `${candidate.provider}:${candidate.providerItemId}`;
    if (blockedSongIdentities.includes(identity)) return response(false, "rejected", { reason: "song_blocked" });
    if (queue.some(row => row.identity === identity) || recent.some(row => row.identity === identity && row.outcome === "played")) {
      return response(false, "duplicate", { reason: "item_duplicate" });
    }
    sequence += 1;
    const entry = {
      id: `sr_${Number(now()).toString(36)}_${sequence.toString(36)}`,
      requestId,
      requesterKey: requester,
      requesterLabel: text(payload.requesterName, 80) || "Twitch user",
      requesterRole: role,
      chatNotify: payload.notifyChat === true,
      query,
      identity,
      candidate,
      requestedAt: Number(now())
    };
    queue.push(entry);
    if (!playlist.some(row => row.identity === identity)) {
      playlist.push({ id: `pl_${stableId(identity)}`, identity, candidate, addedAt: Number(now()) });
      trimState();
    }
    const preemptedPlaylist = managedPlayback?.origin === "playlist";
    if (preemptedPlaylist) {
      managedPlayback = null;
      playbackRevision += 1;
    }
    rememberRequester(requester, entry.requesterLabel, role);
    return response(true, "accepted", { entry: publicState().queue.at(-1), position: queue.length, preemptedPlaylist });
  }

  function undo(payload = {}) {
    const requesterId = text(payload.requesterId, 160);
    const requestId = text(payload.requestId, 160);
    const requester = requesterKey(requesterId);
    const index = queue.findLastIndex(row => row.requesterKey === requester && (!requestId || row.requestId === requestId));
    if (index < 0) return response(false, "rejected", { reason: "entry_not_found" });
    const [entry] = queue.splice(index, 1);
    if (managedPlayback?.entryId === entry.id) {
      managedPlayback = null;
      playbackRevision += 1;
    }
    return response(true, "removed", { entryId: entry.id });
  }

  function selfManage(payload = {}) {
    const action = text(payload.action, 20);
    const requesterId = text(payload.requesterId, 160);
    if (!requesterId || !["skip", "remove"].includes(action)) return response(false, "rejected", { reason: "invalid_request" });
    const requester = requesterKey(requesterId);
    const activeId = managedPlayback?.entryId || "";
    const index = action === "skip"
      ? queue.findIndex(row => row.id === activeId && row.requesterKey === requester)
      : queue.findLastIndex(row => row.requesterKey === requester && row.id !== activeId);
    if (index < 0) return response(false, "rejected", { reason: action === "skip" ? "not_current_requester" : "entry_not_found" });
    const [entry] = queue.splice(index, 1);
    const removedActive = entry.id === activeId;
    managedPlayback = removedActive ? null : managedPlayback;
    playbackRevision += Number(removedActive);
    recent.push({ identity: entry.identity, outcome: action === "skip" ? "skipped" : "removed", at: Number(now()) });
    trimState();
    return response(true, action === "skip" ? "skipped" : "removed", { entryId: entry.id, entry });
  }

  function resolveRequesterModerationKey(payload) {
    const direct = text(payload.requesterKey, 80);
    if (/^req_[a-f0-9]{64}$/.test(direct)) return direct;
    const requesterId = text(payload.requesterId, 160);
    const name = text(payload.requesterName, 80).replace(/^@/, "").toLowerCase();
    return requesterId ? requesterKey(requesterId) : recentRequesters.findLast(row => row.displayName.toLowerCase() === name)?.requesterKey || "";
  }

  function moderate(payload = {}) {
    const action = text(payload.action, 20);
    switch (action) {
      case "pause":
      case "resume":
        paused = action === "pause";
        return { ok: true, code: action, paused };
      case "playback_start":
        playbackEnabled = true;
        playbackRevision += 1;
        return { ok: true, code: "playback_started", playbackEnabled, revision: playbackRevision };
      case "clear": {
        const removed = queue.length;
        queue = [];
        managedPlayback = null;
        playbackRevision += 1;
        return response(true, "removed", { removed });
      }
      case "volume":
        volume = integer(payload.value, 0, 100, volume);
        return { ok: true, code: "volume", volume: volumeState() };
      case "playlist_play":
      case "playlist_shuffle":
      case "playlist_stop":
        playlistMode = action === "playlist_play" ? "sequential" : action === "playlist_shuffle" ? "shuffle" : "off";
        if (action !== "playlist_stop" && payload.arm !== false) playbackEnabled = true;
        if (action === "playlist_stop" && managedPlayback?.origin === "playlist") {
          managedPlayback = null;
          playbackRevision += 1;
        }
        return response(true, "playlist_mode", { playlistState: { mode: playlistMode, cursor: playlistCursor, total: playlist.length } });
      case "playlist_clear": {
        const removed = playlist.length;
        playlist = [];
        playlistCursor = 0;
        lastPlaylistIndex = -1;
        if (managedPlayback?.origin === "playlist") { managedPlayback = null; playbackRevision += 1; }
        return response(true, "playlist_cleared", { removed });
      }
      default:
        break;
    }
    if (action === "playlist_remove") {
      const id = text(payload.playlistId, 160);
      const index = playlist.findIndex(row => row.id === id);
      if (index < 0) return response(false, "rejected", { reason: "playlist_entry_not_found" });
      const [entry] = playlist.splice(index, 1);
      if (managedPlayback?.origin === "playlist" && managedPlayback.entryId === entry.id) { managedPlayback = null; playbackRevision += 1; }
      playlistCursor = playlist.length ? playlistCursor % playlist.length : 0;
      lastPlaylistIndex = -1;
      return response(true, "playlist_removed", { playlistId: entry.id, entry });
    }
    if (action === "block" || action === "unblock") {
      const key = resolveRequesterModerationKey(payload);
      if (!key) return response(false, "rejected", { reason: "invalid_requester" });
      if (action === "block") {
        if (!blockedRequesterKeys.includes(key)) blockedRequesterKeys.push(key);
        blockedRequesterKeys = blockedRequesterKeys.slice(-250);
        const before = queue.length;
        if (payload.removePending !== false) queue = queue.filter(row => row.requesterKey !== key);
        if (managedPlayback?.origin !== "playlist" && managedPlayback?.entryId && !queue.some(row => row.id === managedPlayback.entryId)) { managedPlayback = null; playbackRevision += 1; }
        return response(true, "removed", { removed: before - queue.length, blocked: true });
      }
      blockedRequesterKeys = blockedRequesterKeys.filter(value => value !== key);
      return { ok: true, code: "unblocked", blocked: false };
    }
    if (action === "timeout" || action === "untimeout") {
      const key = resolveRequesterModerationKey(payload);
      if (!key) return response(false, "rejected", { reason: "invalid_requester" });
      if (action === "untimeout") { delete timedRequesterKeys[key]; return { ok: true, code: "untimeout", timedOutUntil: 0 }; }
      const minutes = integer(payload.minutes, 1, 1440, 10);
      timedRequesterKeys[key] = Number(now()) + minutes * 60000;
      const before = queue.length;
      if (payload.removePending === true) queue = queue.filter(row => row.requesterKey !== key);
      if (managedPlayback?.entryId && (managedPlayback.origin === "playlist"
        ? !playlist.some(row => row.id === managedPlayback.entryId)
        : !queue.some(row => row.id === managedPlayback.entryId))) { managedPlayback = null; playbackRevision += 1; }
      return response(true, "removed", { removed: before - queue.length, timedOutUntil: timedRequesterKeys[key] });
    }
    if (action === "block_song" || action === "unblock_song") {
      const songPosition = integer(payload.position, 1, Math.max(1, queue.length), 0);
      const entry = queue.find(row => row.id === text(payload.entryId, 160)) || (songPosition ? queue[songPosition - 1] : null);
      const providerItemId = text(payload.providerItemId, 160);
      const identity = entry?.identity || (providerItemId ? `youtube:${providerItemId}` : "");
      if (!identity) return response(false, "rejected", { reason: "entry_not_found" });
      if (action === "unblock_song") {
        blockedSongIdentities = blockedSongIdentities.filter(value => value !== identity);
        return { ok: true, code: "song_unblocked", identity };
      }
      if (!blockedSongIdentities.includes(identity)) blockedSongIdentities.push(identity);
      blockedSongIdentities = blockedSongIdentities.slice(-MAX_MODERATION_ENTRIES);
      const before = queue.length;
      queue = queue.filter(row => row.identity !== identity);
      playlist = playlist.filter(row => row.identity !== identity);
      if (managedPlayback?.entryId && (managedPlayback.origin === "playlist"
        ? !playlist.some(row => row.id === managedPlayback.entryId)
        : !queue.some(row => row.id === managedPlayback.entryId))) { managedPlayback = null; playbackRevision += 1; }
      return response(true, "removed", { removed: before - queue.length, songBlocked: true, entry: entry || undefined });
    }
    const requestedPosition = integer(payload.position, 1, Math.max(1, queue.length), 0);
    const selectedIndex = requestedPosition > 0 ? requestedPosition - 1 : 0;
    const entryId = text(payload.entryId, 160);
    const index = entryId ? queue.findIndex(row => row.id === entryId) : selectedIndex;
    if (index < 0 || !["skip", "remove"].includes(action)) return response(false, "rejected", { reason: "entry_not_found" });
    const [entry] = queue.splice(index, 1);
    if (managedPlayback?.entryId === entry.id) {
      managedPlayback = null;
      playbackRevision += 1;
    }
    recent.push({ identity: entry.identity, outcome: action === "skip" ? "skipped" : "removed", at: Number(now()) });
    trimState();
    return response(true, action === "skip" ? "skipped" : "removed", { entryId: entry.id, entry });
  }

  function settle(payload = {}) {
    const index = queue.findIndex(row => row.id === text(payload.entryId, 160));
    if (index < 0) return response(false, "rejected", { reason: "entry_not_found" });
    const outcome = text(payload.outcome || "played", 40);
    const [entry] = queue.splice(index, 1);
    if (managedPlayback?.entryId === entry.id) {
      managedPlayback = null;
      playbackRevision += 1;
    }
    recent.push({ identity: entry.identity, outcome, at: Number(now()) });
    trimState();
    return response(true, "settled", { entryId: entry.id, outcome });
  }

  function configure(payload = {}) {
    const nextFloor = integer(payload.volumeFloorPercent, 0, 100, volumeFloorPercent);
    const nextCeiling = integer(payload.volumeCeilingPercent, 0, 100, volumeCeilingPercent);
    if (nextFloor > nextCeiling) return { ...publicState(), ok: false, code: "volume_range_invalid", error: "volume_floor_above_ceiling" };
    volumeFloorPercent = nextFloor;
    volumeCeilingPercent = nextCeiling;
    if (payload.limits && typeof payload.limits === "object") {
      limits = {
        maxQueue: integer(payload.limits.maxQueue, 1, 200, limits.maxQueue),
        maxRecent: integer(payload.limits.maxRecent, 1, 500, limits.maxRecent),
        maxPerRequester: integer(payload.limits.maxPerRequester, 1, 20, limits.maxPerRequester),
        maxPerVip: integer(payload.limits.maxPerVip, 1, 40, limits.maxPerVip),
        maxDurationMs: integer(payload.limits.maxDurationMs, 30000, 3600000, limits.maxDurationMs)
      };
    }
    if (payload.responses && typeof payload.responses === "object") {
      for (const kind of RESPONSE_KINDS) if (typeof payload.responses[kind] === "boolean") responses[kind] = payload.responses[kind];
    }
    catalogPolicy = catalogPolicyFrom(payload.catalogPolicy, catalogPolicy);
    trimState();
    return publicState();
  }

  function exportSnapshot(options = {}) {
    const snapshot = {
      version: SNAPSHOT_VERSION,
      paused,
      limits: { ...limits },
      responses: { ...responses },
      catalogPolicy: { ...catalogPolicy, derivatives: { ...catalogPolicy.derivatives } },
      queue: queue.map(row => ({ ...row, candidate: { ...row.candidate, artists: [...row.candidate.artists] } })),
      recent: recent.map(row => ({ ...row })),
      savedAt: Number(now()),
      seenRequests: [...seenRequests],
      blockedRequesterKeys: [...blockedRequesterKeys],
      timedRequesterKeys: { ...timedRequesterKeys },
      blockedSongIdentities: [...blockedSongIdentities],
      recentRequesters: recentRequesters.map(row => ({ ...row })),
      volume,
      volumeFloorPercent,
      volumeCeilingPercent,
      sequence,
      managedPlayback,
      playbackSource,
      playlistMode,
      playlistCursor,
      overlay: overlayStatus().config
    };
    if (options.includePlaylist !== false) snapshot.playlist = exportPlaylist();
    return snapshot;
  }

  function exportPlaylist() {
    return playlist.map(row => ({ ...row, candidate: { ...row.candidate, artists: [...row.candidate.artists] } }));
  }

  function importPlaylist(rows) {
    if (!Array.isArray(rows)) return { ok: false, error: "playlist_invalid" };
    const seen = new Set();
    playlist = rows.map(row => {
      const candidate = candidateFrom(row?.candidate, row?.candidate?.title);
      if (!candidate || candidate.provider !== "youtube" || !/^[A-Za-z0-9_-]{11}$/.test(candidate.providerItemId)) return null;
      const identity = `youtube:${candidate.providerItemId}`;
      if (seen.has(identity)) return null;
      seen.add(identity);
      return { id: `pl_${stableId(identity)}`, identity, candidate, addedAt: Number(row.addedAt) || Number(now()) };
    }).filter(Boolean);
    playlistCursor = playlist.length ? playlistCursor % playlist.length : 0;
    lastPlaylistIndex = -1;
    return { ok: true, restored: playlist.length };
  }

  function importSnapshot(snapshot) {
    if (!snapshot || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, SNAPSHOT_VERSION].includes(snapshot.version) || !Array.isArray(snapshot.queue) || !Array.isArray(snapshot.recent)) {
      return { ok: false, error: "snapshot_invalid" };
    }
    const restored = [];
    for (const row of snapshot.queue.slice(0, DEFAULTS.maxQueue)) {
      const candidate = candidateFrom(row?.candidate, row?.query);
      const requestId = text(row?.requestId, 160);
      const storedRequester = text(row?.requesterKey || row?.requesterId, 160);
      if (!candidate || !requestId || !storedRequester) continue;
      if (requestProviders && (!requestProviders.has(candidate.provider)
      || candidate.provider === "youtube" && !/^[A-Za-z0-9_-]{11}$/.test(candidate.providerItemId))) continue;
      restored.push({
        id: text(row.id, 160) || `restored_${restored.length + 1}`,
        requestId,
        requesterKey: storedRequester.startsWith("req_") ? storedRequester : requesterKey(storedRequester),
        requesterLabel: text(row.requesterLabel, 80) || "Twitch user",
        requesterRole: requesterRole(row.requesterRole),
        chatNotify: row.chatNotify === true,
        query: text(row.query, 500),
        identity: `${candidate.provider}:${candidate.providerItemId}`,
        candidate,
        requestedAt: Number.isFinite(row.requestedAt) ? row.requestedAt : Number(now())
      });
    }
    queue = restored;
    playlist = [];
    if (Array.isArray(snapshot.playlist)) importPlaylist(snapshot.playlist);
    if (!Array.isArray(snapshot.playlist)) {
      for (const row of restored) if (!playlist.some(item => item.identity === row.identity)) {
        playlist.push({ id: `pl_${stableId(row.identity)}`, identity: row.identity, candidate: row.candidate, addedAt: row.requestedAt });
      }
    }
    playlistMode = ["off", "sequential", "shuffle"].includes(snapshot.playlistMode) ? snapshot.playlistMode : "off";
    playlistCursor = playlist.length ? integer(snapshot.playlistCursor, 0, playlist.length - 1, 0) : 0;
    lastPlaylistIndex = -1;
    recent = snapshot.recent.slice(-DEFAULTS.maxRecent).filter(row => row && typeof row.identity === "string").map(row => ({
      identity: text(row.identity, 200), outcome: text(row.outcome, 40), at: Number(row.at) || Number(now())
    }));
    seenRequests = Array.isArray(snapshot.seenRequests) ? snapshot.seenRequests.slice(-DEFAULTS.maxRecent).map(value => text(value, 160)).filter(Boolean) : [];
    blockedRequesterKeys = Array.isArray(snapshot.blockedRequesterKeys)
      ? snapshot.blockedRequesterKeys.slice(-250).map(value => text(value, 80)).filter(value => /^req_[a-f0-9]{64}$/.test(value))
      : [];
    timedRequesterKeys = snapshot.timedRequesterKeys && typeof snapshot.timedRequesterKeys === "object" && !Array.isArray(snapshot.timedRequesterKeys)
      ? Object.fromEntries(Object.entries(snapshot.timedRequesterKeys).filter(([key, value]) => /^req_[a-f0-9]{64}$/.test(key) && Number.isFinite(value)).slice(-MAX_MODERATION_ENTRIES)) : {};
    blockedSongIdentities = Array.isArray(snapshot.blockedSongIdentities) ? snapshot.blockedSongIdentities.slice(-MAX_MODERATION_ENTRIES).map(value => text(value, 220)).filter(Boolean) : [];
    recentRequesters = Array.isArray(snapshot.recentRequesters) ? snapshot.recentRequesters.slice(-RECENT_REQUESTER_LIMIT).filter(row => /^req_[a-f0-9]{64}$/.test(row?.requesterKey)).map(row => ({ requesterKey: row.requesterKey, displayName: text(row.displayName, 80) || "Twitch user", role: requesterRole(row.role), lastRequestedAt: Number(row.lastRequestedAt) || Number(now()) })) : [];
    volume = integer(snapshot.volume, 0, 100, 100);
    volumeFloorPercent = integer(snapshot.volumeFloorPercent, 0, 100, 0);
    volumeCeilingPercent = integer(snapshot.volumeCeilingPercent, 0, 100, 40);
    if (volumeFloorPercent > volumeCeilingPercent) volumeFloorPercent = 0;
    cleanExpiredTimeouts();
    sequence = integer(snapshot.sequence, 0, Number.MAX_SAFE_INTEGER, restored.length);
    paused = snapshot.paused === true;
    managedPlayback = null;
    playbackSource = PLAYBACK_SOURCES.includes(snapshot.playbackSource) ? snapshot.playbackSource : "youtube";
    overlay = overlayFrom(snapshot.overlay, DEFAULT_OVERLAY);
    configure({ limits: snapshot.limits, responses: snapshot.version >= 7 ? snapshot.responses : undefined, catalogPolicy: snapshot.version >= 8 ? snapshot.catalogPolicy : undefined });
    return { ok: true, restored: queue.length };
  }

  return Object.freeze({ acknowledge, configure, configureOverlay, configurePlaybackSource, exportPlaylist, exportSnapshot, importPlaylist, importSnapshot, moderate, observe, overlayStatus, playbackStatus, pull, selfManage, settle, status: publicState, submit, undo });
}

module.exports = { DEFAULTS, DEFAULT_CATALOG_POLICY, DEFAULT_OVERLAY, DRIVER_LEASE_MS, OVERLAY_BLOCK_KINDS, PLAYBACK_SOURCES, RECENT_REQUESTER_LIMIT, RESPONSE_KINDS, SNAPSHOT_VERSION, createSongQueue };
