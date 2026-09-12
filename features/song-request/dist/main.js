const { createSongQueue } = require("./domain");
const { createPlaylistService } = require("./playlist-service");

const { composeChatResponse } = require("./chat-responses");

const OPTIONAL = Object.freeze({
  chat: ["twitch.chat.send.v1", "send"],
  widget: ["widget.state.v1", "publish"],
  settlement: ["twitch.redemptions.v1", "settle"],
  diagnostics: ["diagnostics.publish.v1", "record"]
});

let context;
let queue;
let playlists;
let persistTimer;
let dirty = false;
let persistenceBackoffMs = 1000;
let shuttingDown = false;
const pending = new Set();
const MAX_OPTIONAL_IN_FLIGHT = 8;
const OPTIONAL_TIMEOUT_MS = Object.freeze({ chat: 8000, settlement: 8000, widget: 750, diagnostics: 750 });
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
    return result;
  }, error => {
    status.failed += 1;
    status.lastError = String(error?.code || error?.message || "capability_failed").slice(0, 80);
    return null;
  }));
}

async function flush() {
  if (!dirty || !context) return;
  dirty = false;
  try {
    await playlists.persist();
    const snapshot = queue.exportSnapshot({ includePlaylist: false });
    snapshot.playlistPageCount = 0;
    const saved = await context.callCapability("ravelink.storage.v1", "set", {
      key: "queue-state-v1",
      value: snapshot
    }, { timeoutMs: 1000 });
    if (saved?.ok === false) throw new Error(saved.error || "queue_persistence_failed");
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
  shuttingDown = false;
  persistenceBackoffMs = 1000;
  persistedPlaylistPageCount = 0;
  for (const status of Object.values(optionalStatus)) Object.assign(status, { attempted: 0, succeeded: 0, failed: 0, lastError: "" });
  queue = createSongQueue({ requestProviders: ["youtube"] });
  playlists = createPlaylistService({ context, queue, schedulePersistence, publishChange });
  try {
    const stored = await context.callCapability("ravelink.storage.v1", "get", { key: "queue-state-v1" }, { timeoutMs: 1000 });
    if (stored?.ok && stored.found) {
      const restored = queue.importSnapshot(stored.value);
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
  const source = queue.playbackStatus().playbackSource;
  if (source !== "youtube") {
    try {
      await context.callCapability("media.windows.now-playing.v1", "control", { action: "select", provider: source }, { timeoutMs: 1000 });
      await context.callCapability("media.windows.now-playing.v1", "control", { action: "start" }, { timeoutMs: 1000 });
    } catch {}
  }
}

async function handleRequest(request) {
  const allowed = {
    "song.queue.read.v1": ["status"],
    "song.queue.submit.v1": ["submit", "undo", "self"],
    "song.queue.admin.v1": ["moderate", "configure", "settle"],
    "song.playback.read.v1": ["status"],
    "song.playback.driver.v1": ["pull", "acknowledge"],
    "song.playback.observe.v1": ["observe"],
    "song.observer.admin.v1": ["status", "control"],
    "song.overlay.read.v1": ["status"],
    "song.overlay.admin.v1": ["configure"],
    "song.catalog.read.v1": ["status"],
    "song.catalog.admin.v1": ["configure", "clear"],
    "song.playlist.read.v1": ["status"],
    "song.playlist.admin.v1": ["mutate"]
  };
  if (!allowed[request.capability]?.includes(request.method)) throw new Error("method_unavailable");
  if (request.capability === "song.queue.read.v1") {
    return { ...queue.status(request.payload || {}), integrations: Object.fromEntries(Object.entries(optionalStatus).map(([name, value]) => [name, { ...value }])) };
  }
  if (request.capability === "song.playlist.read.v1") return playlists.read(request.payload, request);
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
  if (request.capability === "song.overlay.read.v1") return queue.overlayStatus();
  if (request.capability === "song.observer.admin.v1") {
    const action = request.method === "status" ? "status" : String(request.payload?.action || "");
    if (action === "select") {
      const selected = queue.configurePlaybackSource({ source: request.payload?.source });
      if (!selected.ok) return { ok: false, supported: true, lifecycle: "stopped", playbackSource: selected.playbackSource, error: selected.code };
      let observer;
      try {
        observer = selected.playbackSource === "youtube"
          ? await context.callCapability("media.windows.now-playing.v1", "control", { action: "stop" }, { timeoutMs: 2000 })
          : await context.callCapability("media.windows.now-playing.v1", "control", { action: "select", provider: selected.playbackSource }, { timeoutMs: 2000 });
        if (selected.playbackSource !== "youtube") observer = await context.callCapability("media.windows.now-playing.v1", "control", { action: "start" }, { timeoutMs: 1000 });
      } catch {
        observer = { ok: false, supported: false, lifecycle: "unavailable", error: "windows_media_observer_unavailable" };
      }
      schedulePersistence();
      publishPlayback(selected);
      return { ...observer, playbackSource: selected.playbackSource };
    }
    try {
      const observer = await context.callCapability("media.windows.now-playing.v1", "control", { action }, { timeoutMs: action === "stop" ? 2000 : 1000 });
      return { ...observer, playbackSource: queue.playbackStatus().playbackSource };
    } catch {
      return { ok: false, supported: false, lifecycle: "unavailable", playbackSource: queue.playbackStatus().playbackSource, error: "windows_media_observer_unavailable" };
    }
  }
  let effectiveRequest = request;
  if (request.capability === "song.queue.submit.v1" && request.method === "submit"
    && (!request.payload?.candidate || request.payload.candidate.provider === "youtube")) {
    const payload = request.payload || {};
    const videoId = /^[A-Za-z0-9_-]{11}$/.test(String(payload.candidate?.providerItemId || "")) ? payload.candidate.providerItemId : "";
    const queueState = queue.status();
    let resolved;
    try {
      resolved = await context.callCapability("youtube.catalog.host.v1", "resolve", {
        query: payload.query, videoId, policy: { ...queueState.catalogPolicy, maxDurationMs: queueState.limits.maxDurationMs }
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
  const handler = request.capability === "song.overlay.admin.v1"
    ? queue.configureOverlay
    : request.method === "self" ? queue.selfManage : queue[request.method];
  const result = handler(effectiveRequest.payload);
  if (request.capability.startsWith("song.overlay.")) {
    if (result.ok) { schedulePersistence(); publishOverlay(result); }
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
    if (request.method === "settle" && result.ok) optionalCall("settlement", { entryId: result.entryId, outcome: result.outcome });
  }
  return result;
}

async function deactivate() {
  shuttingDown = true;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  await flush();
  await Promise.allSettled([...pending]);
  context = null;
  queue = null;
  playlists = null;
}

module.exports = { activate, deactivate, handleRequest };
