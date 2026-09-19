const { createPlaylistLibrary } = require("./playlist-library");

function createPlaylistService(options) {
  const { context, queue, schedulePersistence, publishChange } = options;
  const library = createPlaylistLibrary();
  let activeImport = null;
  let importRows = [];
  const persistedPages = new Map();
  let persistedIndex = "";

  function activateTracks(rows, arm = true) {
    const mode = queue.status().playlistState.mode;
    queue.moderate({ action: "playlist_stop" });
    queue.importPlaylist(rows);
    if (mode === "sequential") queue.moderate({ action: "playlist_play", arm });
    if (mode === "shuffle") queue.moderate({ action: "playlist_shuffle", arm });
  }

  async function activate() {
    try {
      const stored = await context.callCapability("ravelink.storage.v1", "get", { key: "playlist-library-index-v1" }, { timeoutMs: 1000 });
      if (stored?.ok && stored.found && Array.isArray(stored.value?.collections)) {
        const pagesById = {};
        for (const collection of stored.value.collections.slice(0, 20)) {
          const rows = [];
          const pageCount = Math.min(63, Math.max(0, Number(collection.pageCount) || 0));
          for (let index = 0; index < pageCount; index += 1) {
            const key = `library-page-${collection.id}-${String(index).padStart(4, "0")}`;
            const page = await context.callCapability("ravelink.storage.v1", "get", { key }, { timeoutMs: 1000 });
            if (page?.ok && page.found && Array.isArray(page.value)) {
              rows.push(...page.value);
              persistedPages.set(key, JSON.stringify(page.value));
            }
          }
          pagesById[collection.id] = rows;
        }
        library.restore(stored.value, pagesById);
        library.ensureChatCollection();
        persistedIndex = JSON.stringify(stored.value);
        if (library.active()) activateTracks(library.active().tracks, false);
      }
    } catch {}
    if (library.active()) { schedulePersistence(0); return; }
    const created = library.ensureChatCollection();
    library.select(created.collection.id);
    schedulePersistence(0);
  }

  async function persist() {
    const storage = library.exportStorage();
    const nextPageKeys = new Set();
    for (const [suffix, value] of storage.pages) {
      const key = `library-page-${suffix}`;
      nextPageKeys.add(key);
      const serialized = JSON.stringify(value);
      if (persistedPages.get(key) === serialized) continue;
      const saved = await context.callCapability("ravelink.storage.v1", "set", { key, value }, { timeoutMs: 1000 });
      if (saved?.ok === false) throw new Error(saved.error || "playlist_library_page_failed");
      persistedPages.set(key, serialized);
    }
    const serializedIndex = JSON.stringify(storage.index);
    if (serializedIndex !== persistedIndex) {
      const saved = await context.callCapability("ravelink.storage.v1", "set", { key: "playlist-library-index-v1", value: storage.index }, { timeoutMs: 1000 });
      if (saved?.ok === false) throw new Error(saved.error || "playlist_library_index_failed");
      persistedIndex = serializedIndex;
    }
    for (const key of persistedPages.keys()) if (!nextPageKeys.has(key)) {
      await context.callCapability("ravelink.storage.v1", "remove", { key }, { timeoutMs: 1000 });
      persistedPages.delete(key);
    }
  }

  async function advanceImport(request) {
    const target = Math.min(activeImport.count, importRows.length + 300);
    for (let offset = importRows.length; offset < target; offset += 100) {
      const page = await context.callCapability(activeImport.capability, "import-playlist-page", { jobId: activeImport.jobId, offset, limit: Math.min(100, target - offset) }, { timeoutMs: 1500 });
      if (!page?.ok) throw new Error(page?.error || "playlist_import_transfer_failed");
      importRows.push(...page.items);
    }
    activeImport = { ...activeImport, state: importRows.length < activeImport.count ? "transferring" : "complete", transferred: importRows.length };
    if (activeImport.state !== "complete") return;
    const created = library.create({ name: activeImport.name || activeImport.title, provider: activeImport.provider, sourceId: activeImport.playlistId });
    if (!created.ok) throw new Error(created.code);
    library.replace(created.collection.id, importRows, { provider: activeImport.provider, sourceId: activeImport.playlistId });
    library.select(created.collection.id);
    activateTracks(library.active().tracks);
    activeImport = { ...activeImport, state: "complete", collectionId: created.collection.id };
    importRows = [];
    schedulePersistence();
    publishChange({ ok: true, code: "playlist_imported" }, request);
  }

  async function read(payload, request) {
    if (activeImport?.jobId && activeImport.state === "running") {
      try {
        const status = await context.callCapability(activeImport.capability, "import-playlist-status", { jobId: activeImport.jobId }, { timeoutMs: 1500 });
        activeImport = { ...activeImport, ...status };
        if (status?.ok && status.state === "complete") {
          importRows = [];
          activeImport = { ...activeImport, ...status, state: "transferring", transferred: 0 };
        }
      } catch (error) { activeImport = { ...activeImport, state: "failed", error: String(error?.message || error).slice(0, 120) }; }
    }
    if (activeImport?.state === "transferring") {
      try { await advanceImport(request); }
      catch (error) { activeImport = { ...activeImport, state: "failed", error: String(error?.message || error).slice(0, 120) }; importRows = []; }
    }
    return { ...library.status(payload || {}), import: activeImport };
  }

  async function mutate(payload, request) {
    let result;
    if (payload.action === "create") {
      result = library.create({ name: payload.name });
      if (result.ok) { result = library.select(result.collection.id); activateTracks(result.tracks); }
    } else if (payload.action === "rename") result = library.rename(payload.collectionId, payload.name);
    else if (payload.action === "delete") result = library.remove(payload.collectionId);
    else if (payload.action === "select") result = library.select(payload.collectionId);
    else if (payload.action === "play_random") result = library.selectRandom();
    else if (payload.action === "configure_history") result = library.configureHistory(payload);
    else if (payload.action === "import") return startImport(payload);
    else if (payload.action === "cancel_import") return cancelImport();
    else return { ok: false, code: "playlist_action_invalid" };
    if (result.ok && ["select", "delete", "play_random"].includes(payload.action)) activateTracks(result.tracks);
    if (result.ok && payload.action === "play_random") {
      queue.moderate({ action: "playlist_shuffle" });
      result = { ...result, code: "random_playlist_started" };
    }
    const response = result?.tracks ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "tracks")) : result;
    if (response.ok) { schedulePersistence(); publishChange(response, request); }
    return response;
  }

  async function startImport(payload) {
    if (["running", "transferring"].includes(activeImport?.state)) return { ok: false, code: "playlist_import_busy" };
    const capability = "youtube.catalog.host.v1";
    let started;
    try { started = await context.callCapability(capability, "import-playlist-start", { url: payload.url, limit: 2500 }, { timeoutMs: 2000 }); }
    catch { started = { ok: false, error: "playlist_import_unavailable" }; }
    if (!started?.ok) return { ok: false, code: started?.error || "playlist_import_unavailable" };
    activeImport = { ...started, name: String(payload.name || "").slice(0, 80), provider: "youtube", capability };
    importRows = [];
    return { ok: true, code: "playlist_import_started", import: activeImport };
  }

  async function cancelImport() {
    if (!activeImport?.jobId) return { ok: false, code: "playlist_import_not_found" };
    await context.callCapability(activeImport.capability, "import-playlist-cancel", { jobId: activeImport.jobId }, { timeoutMs: 1000 }).catch(() => null);
    activeImport = { ...activeImport, state: "canceled" };
    importRows = [];
    return { ok: true, code: "playlist_import_canceled" };
  }

  function capture(request, result) {
    const changedByAdmin = request.capability === "song.queue.admin.v1" && ["playlist_clear", "playlist_remove", "block_song"].includes(request.payload?.action);
    if (changedByAdmin) library.capture(queue.exportPlaylist());
  }

  function capturePlayback(request, result) {
    if (request.capability !== "song.playback.driver.v1" || request.method !== "acknowledge" || result.code !== "ended" || result.origin !== "queue" || !result.entry) return;
    const captured = library.capturePlayed(result.entry);
    if (captured.code !== "history_disabled") schedulePersistence();
  }

  return Object.freeze({ activate, capture, capturePlayback, mutate, persist, read });
}

module.exports = { createPlaylistService };

