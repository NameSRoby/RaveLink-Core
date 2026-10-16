const { createSongQueue } = require("./domain");
const {createOverlayProfileStorage}=require('./overlay-profile-storage');
const { createPlaylistService } = require("./playlist-service");

const { composeChatResponse } = require("./chat-responses");

const OPTIONAL = Object.freeze({
  chat: ["twitch.chat.send.v1", "send"],
  widget: ["widget.state.v1", "publish"],
  rewardPause: ["twitch.rewards.manage.v1", "set-paused"],
  diagnostics: ["diagnostics.publish.v1", "record"]
});

let context;
let queue;
let experimentalTidal, spotify, playerRouting, community;
let playlists,profileStorage,flushing,playerPreferences,soundcloud;
let persistTimer;
let dirty = false;
let persistenceBackoffMs = 1000;
let shuttingDown = false;
const pending = new Set();
const MAX_OPTIONAL_IN_FLIGHT = 8;
const OPTIONAL_TIMEOUT_MS = Object.freeze({ chat: 8000, rewardPause: 4000, widget: 750, diagnostics: 750 });
let persistedPlaylistPageCount = 0;
const optionalStatus = Object.fromEntries(Object.keys(OPTIONAL).map(name => [name, { attempted: 0, succeeded: 0, failed: 0, lastError: "" }]));

function track(promise) {
  const operation = Promise.resolve(promise).catch(() => null);
  pending.add(operation);
  operation.finally(() => pending.delete(operation));
  return operation;
}

function optionalCall(name, payload, timeoutMs = OPTIONAL_TIMEOUT_MS[name] || 750) {
  if (shuttingDown || pending.size >= MAX_OPTIONAL_IN_FLIGHT) return null;
  const [capability, method] = OPTIONAL[name];
  const status = optionalStatus[name];
  status.attempted += 1;
  return track(Promise.resolve(context.callCapability(capability, method, payload, { timeoutMs })).then(result => {
    if (result?.ok === false) {
      status.failed += 1;
      status.lastError = String(result.error?.code || result.error || "capability_failed").slice(0, 80);
    } else {
      status.succeeded += 1;
      status.lastError = "";
    }
    if (name === "rewardPause") publishIntegrationStatus();
    return result;
  }, error => {
    status.failed += 1;
    status.lastError = String(error?.code || error?.message || "capability_failed").slice(0, 80);
    if (name === "rewardPause") publishIntegrationStatus();
    return null;
  }));
}

function publishIntegrationStatus() {
  if (shuttingDown || !queue) return;
  const state = queue.status();
  try { context.publishEvent("song.queue.events.v1", "changed", { reason: "reward_sync", counts: state.counts, paused: state.paused }); } catch {}
}

async function flush(){
  while(flushing)await flushing;
  if(!dirty||!context)return;
  flushing=flushSnapshot();try{await flushing}finally{flushing=null}
}
async function flushSnapshot() {
  if (!dirty || !context) return;
  dirty = false;
  try {
    await playlists.persist();
    const snapshot = await profileStorage.prepare(queue.exportSnapshot({ includePlaylist: false }));
    snapshot.playlistPageCount = 0;
    const saved = await context.callCapability("ravelink.storage.v1", "set", {
      key: "queue-state-v1",
      value: snapshot
    }, { timeoutMs: 1000 });
    if (saved?.ok === false) throw new Error(saved.error || "queue_persistence_failed");
    await profileStorage.committed(snapshot);
    for (let index = 0; index < persistedPlaylistPageCount; index += 1) {
      await context.callCapability("ravelink.storage.v1", "remove", {
        key: `playlist-page-${String(index).padStart(6, "0")}`
      }, { timeoutMs: 1000 });
    }
    persistedPlaylistPageCount = 0;
    persistenceBackoffMs = 1000;
  } catch {
    dirty = true;
    if (!shuttingDown) schedulePersistence(Math.min(30000, persistenceBackoffMs *= 2));
  }
}

function schedulePersistence(delayMs = 1000) {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flush();
  }, delayMs);
  persistTimer.unref?.();
}

function publishChange(result, request) {
  const state = queue.status();
  try { context.publishEvent("song.queue.events.v1", "changed", { reason: result.code || "changed", counts: state.counts, paused: state.paused }); } catch {}
  optionalCall("widget", { type: "song-queue", state });
  optionalCall("diagnostics", { owner: "song-request", event: result.code || "changed", ok: result.ok === true });
  const chat = composeChatResponse(request, result, state);
  if (chat) optionalCall("chat", { message: chat.message, ...(chat.replyParentMessageId ? { replyParentMessageId: chat.replyParentMessageId } : {}) });
}

function publishPlayback(result) {
  const state = queue.playbackStatus();
  try { context.publishEvent("song.playback.events.v1", "changed", { reason: result.code || "changed", revision: state.revision, primary: state.primary }); } catch {}
  optionalCall("widget", { type: "song-playback", state });
}

function publishOverlay(result) {
  try { context.publishEvent("song.overlay.events.v1", "changed", { revision: result.revision }); } catch {}
}

async function activate(nextContext) {
  context = nextContext;
  playerPreferences = require('./player-preferences')(context);
  shuttingDown = false;
  persistenceBackoffMs = 1000;
  persistedPlaylistPageCount = 0;
  for (const status of Object.values(optionalStatus)) Object.assign(status, { attempted: 0, succeeded: 0, failed: 0, lastError: "" });
  profileStorage=createOverlayProfileStorage(context);
  queue = createSongQueue({ requestProviders: ["youtube", "tidal", "soundcloud", "spotify"], playlistProviders: ["youtube"] });
  experimentalTidal = require('./experimental-tidal')({ queue, context, isSelected: async () => (await playerPreferences('status', null)).player === 'tidal', changed: result => {
    if (result.code === 'tidal_native_queue_changed') {
      const state = queue.status();
      try { context.publishEvent('song.queue.events.v1', 'changed', { reason: result.code, counts: state.counts, paused: state.paused }); } catch {}
      return;
    }
    schedulePersistence(); publishChange(result, { method: 'experimental' }); publishPlayback(result);
  } });
  spotify = require('./spotify-player')({ queue, context, isSelected: async () => (await playerPreferences('status', null)).player === 'spotify', changed: result => { schedulePersistence();publishChange(result, { method: 'spotify' });publishPlayback(result); } });
  playlists = createPlaylistService({ context, queue, schedulePersistence, publishChange });
  try {
    const stored = await context.callCapability("ravelink.storage.v1", "get", { key: "queue-state-v1" }, { timeoutMs: 1000 });
    if (stored?.ok && stored.found) {
      const restored = queue.importSnapshot(await profileStorage.restore(stored.value));
      if (!restored.ok) optionalCall("diagnostics", { owner: "song-request", event: "snapshot_rejected", ok: false });
      const pageCount = Number.isInteger(stored.value?.playlistPageCount) && stored.value.playlistPageCount >= 0
        ? Math.min(stored.value.playlistPageCount, 100000)
        : 0;
      if (pageCount) {
        const rows = [];
        for (let index = 0; index < pageCount; index += 1) {
          const page = await context.callCapability("ravelink.storage.v1", "get", {
            key: `playlist-page-${String(index).padStart(6, "0")}`
          }, { timeoutMs: 1000 });
          if (!page?.ok || !page.found || !Array.isArray(page.value)) throw new Error("playlist_page_missing");
          rows.push(...page.value);
        }
        queue.importPlaylist(rows);
        persistedPlaylistPageCount = pageCount;
      } else if (Array.isArray(stored.value?.playlist) && stored.value.playlist.length) {
        schedulePersistence(0);
      }
    }
  } catch {}
  await playlists.activate();
  community = playlists.createCommunity({ changed: () => publishChange({ ok: true, code: 'community_updated' }, { method: 'community' }), player: async () => (await playerPreferences('status', null)).player, submit: payload => handleRequest({ capability: 'song.queue.submit.v1', method: 'submit', payload: { ...payload, addToPlaylist: false } }) });community.start();
  soundcloud = require("./soundcloud-player")({ queue, playlists, context, isSelected: async () => (await playerPreferences("status", null)).player === "soundcloud", changed: result => { schedulePersistence(); publishChange(result, { method: "soundcloud" }); publishPlayback(result); } });
  playerRouting = require('./player-routing')({ preferences: playerPreferences, queue, tidal: experimentalTidal, changed: () => { schedulePersistence();publishPlayback({ ok: true }); } });
  const source = queue.playbackStatus().playbackSource;
  if (!["youtube", "soundcloud"].includes(source)) {
    try {
      await context.callCapability("media.windows.now-playing.v1", "control", { action: "select", provider: source }, { timeoutMs: 1000 });
      await context.callCapability("media.windows.now-playing.v1", "control", { action: "start" }, { timeoutMs: 1000 });
    } catch {}
  }
}

async function handleRequest(request) {
  const routing = await community.route(request) || await playerRouting(request);if (routing) return routing.value;
  const intakePlayer = request.capability === 'song.queue.submit.v1' && request.method === 'submit' ? request.activePlayer : null;
  const spotifyRequest = await spotify.route(request, playerPreferences);
  if (spotifyRequest) return spotifyRequest.value;
  if (request.capability === "song.soundcloud.player.v1") return soundcloud(request.method, request.payload || {});
  if (request.capability === 'song.player.preferences.v1') return playerPreferences(request.method, request.payload);
  if (request.capability === 'song.playlist.transfer.v1') return playlists.transfer(request.payload || {});
  if (request.capability === 'song.tidal.experimental.v1') return experimentalTidal(request.method, request.payload || {});
  const allowed = {
    "song.queue.read.v1": ["status"],
    "song.queue.submit.v1": ["submit", "undo", "self"],
    "song.queue.admin.v1": ["moderate", "configure", "settle"],
    "song.playback.read.v1": ["status"],
    "song.playback.driver.v1": ["pull", "acknowledge"],
    "song.playback.observe.v1": ["observe"],
    "song.observer.admin.v1": ["status", "control"],
    "song.overlay.read.v1": ["status", "preset"],
    "song.overlay.admin.v1": ["configure", "profile"],
    "song.catalog.read.v1": ["status"],
    "song.catalog.admin.v1": ["configure", "clear"],
    "song.playlist.read.v1": ["status"],
    "song.playlist.admin.v1": ["mutate"]
  };
  if (!allowed[request.capability]?.includes(request.method)) throw new Error("method_unavailable");
  if (request.capability === 'song.queue.admin.v1' && request.method === 'moderate'
    && (['block', 'timeout'].includes(request.payload?.action) || request.payload?.provider === 'tidal'
      && ['remove', 'skip', 'block_song', 'timeout_song', 'untimeout_song', 'unblock_song', 'unblock', 'untimeout'].includes(request.payload?.action))) {
    const result = await experimentalTidal('moderate', request.payload);
    if (result.ok) {
      playlists.capture(request, result);
      const chat = composeChatResponse(request, result, queue.status());
      if (chat) optionalCall('chat', { message: chat.message, ...(chat.replyParentMessageId ? { replyParentMessageId: chat.replyParentMessageId } : {}) });
    }
    return result;
  }
  if (request.capability === "song.queue.read.v1") {
    return { ...queue.status(request.payload || {}), integrations: Object.fromEntries(Object.entries(optionalStatus).map(([name, value]) => [name, { ...value }])) };
  }
  if (request.capability === "song.playlist.read.v1") return { ...await playlists.read(request.payload, request), community: community.status() };
  if (request.capability === "song.playlist.admin.v1") return playlists.mutate(request.payload || {}, request);
  if (request.capability === "song.catalog.read.v1") {
    try {
      const provider = await context.callCapability("youtube.catalog.host.v1", "status", null, { timeoutMs: 1500 });
      return { ...provider, policy: queue.status().catalogPolicy };
    } catch { return { ok: true, configured: false, unavailable: true, policy: queue.status().catalogPolicy }; }
  }
  if (request.capability === "song.catalog.admin.v1") {
    if (request.method === "clear") {
      try { return await context.callCapability("youtube.catalog.host.v1", "clear", null, { timeoutMs: 2000 }); }
      catch { return { ok: false, error: "youtube_catalog_unavailable" }; }
    }
    const payload = request.payload || {};
    let provider = { ok: true };
    if (payload.apiKey || payload.mode) {
      try { provider = await context.callCapability("youtube.catalog.host.v1", "configure", { ...(payload.apiKey ? { apiKey: payload.apiKey } : {}), ...(payload.mode ? { mode: payload.mode } : {}) }, { timeoutMs: 10000 }); }
      catch { provider = { ok: false, error: "youtube_catalog_unavailable" }; }
      if (!provider.ok) return provider;
    }
    if (payload.policy) { queue.configure({ catalogPolicy: payload.policy }); schedulePersistence(); }
    return { ...provider, policy: queue.status().catalogPolicy };
  }
  if (request.capability === "song.playback.read.v1") return queue.playbackStatus();
  if (request.capability === "song.overlay.read.v1") {
    if(request.method==='preset'){const config=require('./overlay-presets').get(request.payload?.id);return config?{ok:true,config}:{ok:false,code:'overlay_preset_not_found'};}
    return queue.overlayStatus();
  }
  if (request.capability === "song.observer.admin.v1") {
    const action = request.method === "status" ? "status" : String(request.payload?.action || "");
    const localSource = source => ['youtube', 'soundcloud'].includes(source);
    const localStatus = source => ({ ok: true, supported: true, lifecycle: 'local', playbackSource: source, selectedProvider: source });
    if (action === "select") {
      const selected = queue.configurePlaybackSource({ source: request.payload?.source });
      if (!selected.ok) return { ok: false, supported: true, lifecycle: "stopped", playbackSource: selected.playbackSource, error: selected.code };
      let observer;
      try {
        observer = localSource(selected.playbackSource)
          ? await context.callCapability("media.windows.now-playing.v1", "control", { action: "stop" }, { timeoutMs: 2000 })
          : await context.callCapability("media.windows.now-playing.v1", "control", { action: "select", provider: selected.playbackSource }, { timeoutMs: 2000 });
        if (!localSource(selected.playbackSource)) observer = await context.callCapability("media.windows.now-playing.v1", "control", { action: "start" }, { timeoutMs: 1000 });
      } catch {
        observer = { ok: false, supported: false, lifecycle: "unavailable", error: "windows_media_observer_unavailable" };
      }
      schedulePersistence();
      publishPlayback(selected);
      return localSource(selected.playbackSource) ? localStatus(selected.playbackSource) : { ...observer, playbackSource: selected.playbackSource };
    }
    if (localSource(queue.playbackStatus().playbackSource) && ['status', 'start', 'stop'].includes(action)) return localStatus(queue.playbackStatus().playbackSource);
    try {
      const observer = await context.callCapability("media.windows.now-playing.v1", "control", { action }, { timeoutMs: action === "stop" ? 2000 : 1000 });
      return { ...observer, playbackSource: queue.playbackStatus().playbackSource };
    } catch {
      return { ok: false, supported: false, lifecycle: "unavailable", playbackSource: queue.playbackStatus().playbackSource, error: "windows_media_observer_unavailable" };
    }
  }
  let effectiveRequest = request;
  const soundcloudInput = request.capability === "song.queue.submit.v1" && request.method === "submit" && intakePlayer === "soundcloud";
  if (soundcloudInput) { const found = await soundcloud.resolveQuery(request.payload?.query); effectiveRequest = { ...request, payload: { ...request.payload, candidate: found.ok ? found.candidate : undefined, catalogFailure: found.ok ? undefined : found.reason || "soundcloud_search_unavailable" } }; }
  if (!soundcloudInput && request.capability === 'song.queue.submit.v1' && request.method === 'submit' && request.payload?.candidate && request.payload.candidate.provider !== 'youtube') {
    return { ok: false, code: 'rejected', reason: 'youtube_reference_required' };
  }
  if (!soundcloudInput && request.capability === "song.queue.submit.v1" && request.method === "submit"
    && (!request.payload?.candidate || request.payload.candidate.provider === "youtube")) {
    const payload = request.payload || {};
    const videoId = /^[A-Za-z0-9_-]{11}$/.test(String(payload.candidate?.providerItemId || "")) ? payload.candidate.providerItemId : "";
    const queueState = queue.status();
    let resolved;
    try {
      resolved = await context.callCapability("youtube.catalog.host.v1", "resolve", {
        query: payload.query,
        videoId,
        policy: { ...queueState.catalogPolicy, maxDurationMs: queueState.limits.maxDurationMs },
        maxDurationMs: queueState.limits.maxDurationMs
      }, { timeoutMs: videoId ? 4000 : 9000 });
    } catch {
      resolved = { ok: false, reason: "youtube_catalog_unavailable" };
    }
    if (resolved?.ok) effectiveRequest = { ...request, payload: { ...payload, candidate: resolved.candidate } };
    else {
      const reason = resolved?.reason || "youtube_catalog_unavailable";
      const directFallback = videoId && [
        "youtube_catalog_unconfigured", "youtube_catalog_unavailable", "youtube_keyless_unavailable",
        "youtube_keyless_timeout", "youtube_keyless_rate_limited", "youtube_api_timeout",
        "youtube_search_rate_limited", "youtube_daily_budget_exhausted", "youtube_quota_or_key_rejected"
      ].includes(reason);
      if (!directFallback) effectiveRequest = { ...request, payload: { ...payload, candidate: undefined, catalogFailure: reason } };
    }
  }
  if(request.capability==='song.queue.admin.v1'&&request.method==='moderate'&&request.payload?.action==='playback_start'&&request.payload.source==='youtube')queue.configurePlaybackSource({source:'youtube'});
  const handler = request.capability === "song.overlay.admin.v1"
    ? request.method === 'profile' ? queue.overlayProfile : queue.configureOverlay
    : request.method === "self" ? queue.selfManage : queue[request.method];
  const result = intakePlayer && (await playerPreferences('status', null)).player !== intakePlayer ? { ok: false, code: 'rejected', reason: 'player_inactive' } : handler(effectiveRequest.payload);
  if (request.capability === "song.queue.admin.v1" && request.method === "moderate" && result.ok && ["pause", "resume"].includes(request.payload?.action)) {
    optionalCall("rewardPause", { purpose: "song_request", paused: result.paused === true });
  }
  if (request.capability.startsWith("song.overlay.")) {
    if (result.ok && request.payload?.action !== 'load') { schedulePersistence(); publishOverlay(result); }
    return result;
  }
  if (request.capability.startsWith("song.playback.")) {
    if (result.ok && result.code !== "idle") {
      playlists.capturePlayback(request, result);
      schedulePersistence();
      publishPlayback(result);
      const chat = composeChatResponse(request, result, queue.status());
      if (chat) optionalCall("chat", { message: chat.message, ...(chat.replyParentMessageId ? { replyParentMessageId: chat.replyParentMessageId } : {}) });
    }
    return result;
  }
  if (result.ok || result.code === "duplicate" || result.code === "rejected") {
    playlists.capture(request, result);
    schedulePersistence();
    publishChange(result, effectiveRequest);
    if (request.method === "settle" || request.method === "self" || request.method === "moderate") publishPlayback(result);
  }
  return result;
}

async function deactivate() {
  shuttingDown = true;
  await community?.stop();
  spotify?.stop();
  experimentalTidal?.stop();
  playlists?.stop();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  await flush();
  await Promise.allSettled([...pending]);
  context = null;
  queue = null;
  playlists = null;
}

module.exports = { activate, deactivate, handleRequest };
