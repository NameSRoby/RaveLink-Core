const { createPlaylistLibrary } = require("./playlist-library");

function createPlaylistService(options) {
  const { context, queue, schedulePersistence, publishChange } = options;
  const library = createPlaylistLibrary();
  const transfers = require('./playlist-transfers')({ context, library, saveLibrary: async () => { await persist(); schedulePersistence(); } });
  let playbackCollectionId = '';
  let activeImport = null;
  let importRows = [];
  const persistedPages = new Map();
  let persistedIndex = "";
  let recovering = true, recoveryError = '';

  function activateTracks(rows, arm = true) {
    if (rows.some(row => !['youtube','soundcloud'].includes(row.candidate.provider) || row.candidate.provider !== rows[0]?.candidate.provider)) return false;
    playbackCollectionId = library.status().selectedId;
    const mode = queue.status().playlistState.mode;
    queue.moderate({ action: "playlist_stop" });
    queue.importPlaylist(rows);
    if (mode === "sequential") queue.moderate({ action: "playlist_play", arm });
    if (mode === "shuffle") queue.moderate({ action: "playlist_shuffle", arm });
  }

  async function activate() {
    const loading = restoreLibrary().finally(() => { recovering = false; if (!recoveryError) schedulePersistence(0); });
    let timeout;
    await Promise.race([loading, new Promise(resolve => { timeout = setTimeout(resolve, 1500); })]);
    clearTimeout(timeout);
  }

  async function restoreLibrary() {
    void transfers.load();
    try {
      const stored = await context.callCapability("ravelink.storage.v1", "get", { key: "playlist-library-index-v1" }, { timeoutMs: 5000 });
      if (stored?.ok === false) throw new Error('playlist_restore_failed');
      if (stored?.ok && stored.found && Array.isArray(stored.value?.collections)) {
        const pagesById = {};
        for (const collection of stored.value.collections.slice(0, 21)) {
          const rows = [];
          const pageCount = Math.min(250, Math.max(0, Number(collection.pageCount) || 0));
          for (let index = 0; index < pageCount; index += 1) {
            const key = `library-page-${collection.id}-${String(index).padStart(4, "0")}`;
            const page = await context.callCapability("ravelink.storage.v1", "get", { key }, { timeoutMs: 5000 });
            if (page?.ok === false || !page?.found || !Array.isArray(page.value)) throw new Error('playlist_restore_failed');
            if (page?.ok && page.found && Array.isArray(page.value)) {
              rows.push(...page.value);
              persistedPages.set(key, JSON.stringify(page.value));
              if (index % 60 === 59) await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
          pagesById[collection.id] = rows;
        }
        library.restore(stored.value, pagesById);
        library.ensureChatCollection();
        persistedIndex = JSON.stringify(stored.value);
        if (library.active()) activateTracks(library.active().tracks, false);
      }
    } catch { recoveryError = 'playlist_restore_failed'; return; }
    if (library.active()) { schedulePersistence(0); return; }
    const created = library.ensureChatCollection();
    library.select(created.collection.id);
    schedulePersistence(0);
  }

  async function persist() {
    if (recovering || recoveryError) return;
    const storage = library.exportStorage();
    const nextPageKeys = new Set();
    let savedCount = 0;
    for (const [suffix, value] of storage.pages) {
      const key = `library-page-${suffix}`;
      nextPageKeys.add(key);
      const serialized = JSON.stringify(value);
      if (persistedPages.get(key) === serialized) continue;
      const saved = await context.callCapability("ravelink.storage.v1", "set", { key, value }, { timeoutMs: 5000 });
      if (saved?.ok === false) throw new Error(saved.error || "playlist_library_page_failed");
      persistedPages.set(key, serialized);
      if (++savedCount % 60 === 0) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const serializedIndex = JSON.stringify(storage.index);
    if (serializedIndex !== persistedIndex) {
      const saved = await context.callCapability("ravelink.storage.v1", "set", { key: "playlist-library-index-v1", value: storage.index }, { timeoutMs: 5000 });
      if (saved?.ok === false) throw new Error(saved.error || "playlist_library_index_failed");
      persistedIndex = serializedIndex;
    }
    for (const key of persistedPages.keys()) if (!nextPageKeys.has(key)) {
      await context.callCapability("ravelink.storage.v1", "remove", { key }, { timeoutMs: 5000 });
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
    return { ...library.status(payload || {}), recovering, recoveryError, playbackCollectionId, import: activeImport };
  }

  async function mutate(payload, request) {
    if (recovering || recoveryError) return { ok: false, code: recoveryError || 'playlist_recovering' };
    let result;
    if (payload.action === "create") {
      result = library.create({ name: payload.name });

    } else if (payload.action === "rename") result = library.rename(payload.collectionId, payload.name);
    else if (payload.action === "delete") result = library.remove(payload.collectionId);
    else if (payload.action === "select") result = library.select(payload.collectionId);
    else if (payload.action === "play_random") result = library.selectRandom(Math.random, queue.playbackStatus().playbackSource === 'soundcloud' ? 'soundcloud' : 'youtube');
    else if (['remove_track', 'clear_tracks'].includes(payload.action)) {
      const selected = library.active();
      if (!selected) return { ok: false, code: 'playlist_not_found' };
      if (payload.action === 'remove_track' && !selected.tracks.some(row => row.id === payload.trackId)) return { ok: false, code: 'playlist_entry_not_found' };
      const tracks = payload.action === 'clear_tracks' ? [] : selected.tracks.filter(row => row.id !== payload.trackId);
      result = library.replace(selected.id, tracks);
      if (result.ok && playbackCollectionId === selected.id) queue.moderate({ action: payload.action === 'clear_tracks' ? 'playlist_clear' : 'playlist_remove', playlistId: payload.trackId });
    }
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
    try { started = await context.callCapability(capability, "import-playlist-start", { url: payload.url, limit: library.status().limits.tracksPerCollection }, { timeoutMs: 2000 }); }
    catch { started = { ok: false, error: "playlist_import_unavailable" }; }
    if (!started?.ok) return { ok: false, code: started?.error || "playlist_import_unavailable" };
    activeImport = { ...started, name: String(payload.name || "").slice(0, 80), provider: "youtube", capability };
    importRows = [];
    return { ok: true, code: "playlist_import_started", import: activeImport };
  }

  async function cancelImport() {
    if (!activeImport?.jobId) return { ok: false, code: "playlist_import_not_found" };
    await context.callCapability(activeImport.capability, "import-playlist-cancel", { jobId: activeImport.jobId }, { timeoutMs: 5000 }).catch(() => null);
    activeImport = { ...activeImport, state: "canceled" };
    importRows = [];
    return { ok: true, code: "playlist_import_canceled" };
  }

  function capture(request, result) {
    const changedByAdmin = request.capability === "song.queue.admin.v1" && ["playlist_clear", "playlist_remove", "block_song"].includes(request.payload?.action);
    if (changedByAdmin && playbackCollectionId) library.replace(playbackCollectionId, queue.exportPlaylist());
  }

  function capturePlayback(request, result) {
    if (request.capability !== "song.playback.driver.v1" || request.method !== "acknowledge" || result.code !== "ended" || result.origin !== "queue" || !result.entry) return;
    const captured = library.capturePlayed(result.entry);
    if (captured.code !== "history_disabled") schedulePersistence();
  }

  async function installPublicPlaylist(name, rows) {
    if (recovering || recoveryError) return { ok: false, code: recoveryError || 'playlist_recovering' };
    if (rows.length > library.status().limits.tracksPerCollection) return { ok: false, code: 'playlist_track_limit' };
    const created = library.create({ name, provider: 'soundcloud' }); if (!created.ok) return created;
    const result = library.replace(created.collection.id, rows); schedulePersistence(); publishChange(result, { method: 'soundcloud' });
    return { ok: result.ok, code: result.code, collection: result.collection, collectionId: created.collection.id };
  }
  return Object.freeze({ installPublicPlaylist, trackLimit: () => library.status().limits.tracksPerCollection, transfer: input => recovering || recoveryError ? { ok: false, code: recoveryError || 'playlist_recovering' } : transfers.handle(input), stop: transfers.stop, activate, capture, capturePlayback, mutate, persist, read });
}

module.exports = { createPlaylistService };

