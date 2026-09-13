const crypto = require("node:crypto");

const MAX_USER_COLLECTIONS = 20;
const MAX_COLLECTIONS = MAX_USER_COLLECTIONS + 1;
const MAX_TRACKS = 2500;
const PAGE_SIZE = 40;
const CHAT_HISTORY_PURPOSE = "chat-history";

function text(value, maximum) {
  return String(value || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function normalizeTrack(row, now) {
  const candidate = row?.candidate || row;
  const provider = candidate?.provider === "soundcloud" ? "soundcloud" : "youtube";
  const providerItemId = text(candidate?.providerItemId, 160);
  if (provider === "youtube" ? !/^[A-Za-z0-9_-]{11}$/.test(providerItemId) : !/^soundcloud:tracks:[A-Za-z0-9_-]+$/.test(providerItemId)) return null;
  const sourceUrl = provider === "youtube" ? `https://www.youtube.com/watch?v=${providerItemId}` : text(candidate?.sourceUrl, 500);
  return {
    id: provider === "youtube" ? `pl_${providerItemId}` : `pl_${crypto.createHash("sha256").update(`${provider}:${providerItemId}`).digest("hex").slice(0, 20)}`,
    identity: `${provider}:${providerItemId}`,
    addedAt: Number(row?.addedAt) || now,
    candidate: {
      provider,
      providerItemId,
      title: text(candidate?.title, 300) || providerItemId,
      artists: Array.isArray(candidate?.artists) ? candidate.artists.map(value => text(value, 100)).filter(Boolean).slice(0, 8) : [],
      album: text(candidate?.album, 200),
      durationMs: Math.max(0, Math.min(86400000, Number(candidate?.durationMs) || 0)),
      sourceUrl
    }
  };
}

function createPlaylistLibrary(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const collections = new Map();
  let selectedId = "";
  let historyEnabled = false;
  let historyDestinationId = "";

  function uniqueTracks(rows) {
    const seen = new Set();
    return (Array.isArray(rows) ? rows : []).map(row => normalizeTrack(row, Number(now()))).filter(row => {
      if (!row || seen.has(row.identity)) return false;
      seen.add(row.identity);
      return true;
    }).slice(0, MAX_TRACKS);
  }

  function create(input = {}) {
    const purpose = input.purpose === CHAT_HISTORY_PURPOSE ? CHAT_HISTORY_PURPOSE : "";
    const userCollectionCount = [...collections.values()].filter(row => !row.purpose).length;
    if ((!purpose && userCollectionCount >= MAX_USER_COLLECTIONS) || collections.size >= MAX_COLLECTIONS) return { ok: false, code: "playlist_limit_reached" };
    const name = text(input.name, 80) || `Playlist ${collections.size + 1}`;
    const id = `list_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const timestamp = Number(now());
    const collection = { id, name, purpose, provider: text(input.provider, 20) || "local", sourceId: text(input.sourceId, 100), createdAt: timestamp, updatedAt: timestamp, tracks: [] };
    collections.set(id, collection);
    if (!selectedId) selectedId = id;
    return { ok: true, code: "playlist_created", collection: metadata(collection) };
  }

  function metadata(collection) {
    return { id: collection.id, name: collection.name, purpose: collection.purpose, provider: collection.provider, sourceId: collection.sourceId, createdAt: collection.createdAt, updatedAt: collection.updatedAt, count: collection.tracks.length };
  }

  function active() { return collections.get(selectedId) || null; }

  function status(input = {}) {
    const offset = Math.max(0, Number(input.offset) || 0);
    const limit = Math.max(1, Math.min(25, Number(input.limit) || 10));
    const selected = active();
    return {
      ok: true,
      selectedId,
      collections: [...collections.values()].map(metadata),
      tracks: selected?.tracks.slice(offset, offset + limit) || [],
      page: { offset, limit, total: selected?.tracks.length || 0, hasMore: Boolean(selected && offset + limit < selected.tracks.length) },
      limits: { collections: MAX_USER_COLLECTIONS, tracksPerCollection: MAX_TRACKS },
      history: { enabled: historyEnabled, destinationId: historyDestinationId }
    };
  }

  function select(id) {
    if (!collections.has(id)) return { ok: false, code: "playlist_not_found" };
    selectedId = id;
    return { ok: true, code: "playlist_selected", collection: metadata(active()), tracks: active().tracks };
  }

  function selectRandom(random = Math.random) {
    const userLists = [...collections.values()].filter(row => !row.purpose && row.tracks.length);
    const choices = userLists.length ? userLists : [...collections.values()].filter(row => row.tracks.length);
    if (!choices.length) return { ok: false, code: "playlist_empty" };
    const index = Math.min(choices.length - 1, Math.floor(Math.max(0, Number(random()) || 0) * choices.length));
    return select(choices[index].id);
  }

  function rename(id, name) {
    const collection = collections.get(id);
    const value = text(name, 80);
    if (!collection) return { ok: false, code: "playlist_not_found" };
    if (!value) return { ok: false, code: "playlist_name_required" };
    collection.name = value;
    collection.updatedAt = Number(now());
    return { ok: true, code: "playlist_renamed", collection: metadata(collection) };
  }

  function remove(id) {
    const collection = collections.get(id);
    if (!collection) return { ok: false, code: "playlist_not_found" };
    if (collection.purpose === CHAT_HISTORY_PURPOSE) return { ok: false, code: "chat_playlist_required" };
    if (collections.size === 1) return { ok: false, code: "last_playlist_required" };
    collections.delete(id);
    if (selectedId === id) selectedId = collections.keys().next().value;
    return { ok: true, code: "playlist_deleted", selectedId, tracks: active().tracks };
  }

  function replace(id, rows, source = {}) {
    const collection = collections.get(id);
    if (!collection) return { ok: false, code: "playlist_not_found" };
    collection.tracks = uniqueTracks(rows);
    collection.provider = text(source.provider, 20) || collection.provider;
    collection.sourceId = text(source.sourceId, 100) || collection.sourceId;
    collection.updatedAt = Number(now());
    return { ok: true, code: "playlist_replaced", collection: metadata(collection), tracks: collection.tracks };
  }

  function capture(rows) { return selectedId ? replace(selectedId, rows) : { ok: false, code: "playlist_not_found" }; }

  function ensureChatCollection() {
    const existing = [...collections.values()].find(row => row.purpose === CHAT_HISTORY_PURPOSE);
    if (existing) {
      historyDestinationId = collections.has(historyDestinationId) ? historyDestinationId : existing.id;
      return { ok: true, code: "chat_playlist_ready", collection: metadata(existing) };
    }
    const created = create({ name: "Chat Requests", purpose: CHAT_HISTORY_PURPOSE });
    if (created.ok) historyDestinationId = created.collection.id;
    return created;
  }

  function configureHistory(input = {}) {
    const destinationId = text(input.destinationId, 40) || historyDestinationId;
    if (!collections.has(destinationId)) return { ok: false, code: "playlist_not_found" };
    if (typeof input.enabled === "boolean") historyEnabled = input.enabled;
    historyDestinationId = destinationId;
    return { ok: true, code: "history_configured", history: { enabled: historyEnabled, destinationId: historyDestinationId } };
  }

  function capturePlayed(row) {
    if (!historyEnabled) return { ok: true, code: "history_disabled" };
    const collection = collections.get(historyDestinationId);
    const track = normalizeTrack(row, Number(now()));
    if (!collection || !track) return { ok: false, code: collection ? "track_invalid" : "playlist_not_found" };
    const existingIndex = collection.tracks.findIndex(item => item.identity === track.identity);
    if (existingIndex >= 0) collection.tracks.splice(existingIndex, 1);
    collection.tracks.push(track);
    if (collection.tracks.length > MAX_TRACKS) collection.tracks.shift();
    collection.updatedAt = Number(now());
    return { ok: true, code: existingIndex >= 0 ? "history_refreshed" : "history_saved", collection: metadata(collection) };
  }

  function restore(index, pagesById = {}) {
    collections.clear();
    for (const row of Array.isArray(index?.collections) ? index.collections.slice(0, MAX_COLLECTIONS) : []) {
      const id = text(row?.id, 40);
      if (!/^list_[a-f0-9]{16}$/.test(id)) continue;
      collections.set(id, {
        id,
        name: text(row.name, 80) || "Playlist",
        purpose: row.purpose === CHAT_HISTORY_PURPOSE ? CHAT_HISTORY_PURPOSE : "",
        provider: text(row.provider, 20) || "local",
        sourceId: text(row.sourceId, 100),
        createdAt: Number(row.createdAt) || Number(now()),
        updatedAt: Number(row.updatedAt) || Number(now()),
        tracks: uniqueTracks(pagesById[id])
      });
    }
    selectedId = collections.has(index?.selectedId) ? index.selectedId : (collections.keys().next().value || "");
    historyEnabled = index?.history?.enabled === true;
    historyDestinationId = collections.has(index?.history?.destinationId) ? index.history.destinationId : "";
    return { ok: true, restored: collections.size, selectedId };
  }

  function exportStorage() {
    const pages = [];
    const metadataRows = [];
    for (const collection of collections.values()) {
      let pageCount = 0;
      for (let offset = 0; offset < collection.tracks.length; offset += PAGE_SIZE) {
        pages.push([`${collection.id}-${String(pageCount).padStart(4, "0")}`, collection.tracks.slice(offset, offset + PAGE_SIZE)]);
        pageCount += 1;
      }
      metadataRows.push({ ...metadata(collection), pageCount });
    }
    return { index: { version: 2, selectedId, history: { enabled: historyEnabled, destinationId: historyDestinationId }, collections: metadataRows }, pages };
  }

  return Object.freeze({ active, capture, capturePlayed, configureHistory, create, ensureChatCollection, exportStorage, remove, rename, replace, restore, select, selectRandom, status });
}

module.exports = { CHAT_HISTORY_PURPOSE, MAX_COLLECTIONS, MAX_TRACKS, MAX_USER_COLLECTIONS, PAGE_SIZE, createPlaylistLibrary, normalizeTrack };
