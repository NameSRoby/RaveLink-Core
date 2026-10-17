/**
 * Community playlists.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#playlist-transfers-and-uncertain-writes
 */
const crypto = require("node:crypto");
module.exports = function communityPlaylists({
  context,
  library,
  saveLibrary,
  submit,
  player,
  ready = () => true,
  changed = () => {},
}) {
  const key = "community-playlists-v1",
    names = {
      youtube: "YouTube",
      soundcloud: "SoundCloud",
      tidal: "TIDAL",
      spotify: "Spotify",
    };
  let state = { version: 1, lists: {}, receipts: [] },
    serial = Promise.resolve(),
    work = null,
    stopped = false,
    timer;
  const storage = (method, value) =>
    context.callCapability(
      "ravelink.storage.v1",
      method,
      { key, ...(value ? { value } : {}) },
      { timeoutMs: 5000 },
    );
  const save = async () => {
    const reply = await storage("set", state);
    if (reply?.ok === false) throw Error("community_storage_failed");
    changed();
  };
  const loaded = storage("get").then((reply) => {
    if (reply?.ok === false) throw Error("community_storage_failed");
    if (reply?.found) {
      if (
        reply.value?.version !== 1 ||
        !reply.value.lists ||
        !Array.isArray(reply.value.receipts) ||
        reply.value.receipts.length > 250
      )
        throw Error("community_storage_invalid");
      state = reply.value;
    }
  });
  const native = (provider, payload) =>
    context.callCapability(
      provider === "tidal" ? "tidal.playlists.host.v1" : "spotify.desktop.host.v1",
      provider === "tidal" ? "action" : "playlist",
      payload,
      { timeoutMs: 15000 },
    );
  const mutationId = () => "community-" + crypto.randomUUID();
  async function readAll(provider, id) {
    let cursor = "",
      rows = [],
      pages = 0;
    do {
      const reply = await native(provider, {
        action: "read",
        id,
        ...(provider === "spotify" ? { offset: Number(cursor || 0) } : { cursor }),
      });
      if (!reply.ok) throw Error(reply.error || "community_read_failed");
      if (
        !Array.isArray(reply.tracks) ||
        reply.tracks.some((row) => !row) ||
        ++pages > 1000 ||
        rows.length + reply.tracks.length > 10000
      )
        throw Error("community_destination_changed");
      rows.push(...reply.tracks.map((row) => row.providerItemId));
      cursor = reply.cursor;
    } while (cursor);
    return rows;
  }
  async function findCreated(provider, list) {
    let cursor = "",
      found = [],
      pages = 0;
    do {
      const reply = await native(provider, {
        action: "list",
        ...(provider === "spotify" ? { offset: Number(cursor || 0) } : { cursor }),
      });
      if (!reply.ok) throw Error(reply.error || "community_read_failed");
      found.push(
        ...reply.playlists.filter((row) =>
          provider === "spotify" ? row.name === list.accountName : row.description === list.marker,
        ),
      );
      cursor = reply.cursor;
      if (++pages > 100) throw Error("community_destination_changed");
    } while (cursor);
    if (found.length > 1) throw Error("community_destination_ambiguous");
    return found[0]?.id || "";
  }
  async function sync(provider, list) {
    const collection = library.get(list.collectionId);
    if (!collection) throw Error("community_local_playlist_missing");
    const expected = collection.tracks.map((row) => row.candidate.providerItemId);
    if (!expected.length) return;
    if (!list.accountId) {
      list.accountId = await findCreated(provider, list);
      if (!list.accountId) {
        if (list.intent) throw Error("community_write_review");
        list.intent = "create";
        list.operationKey = mutationId();
        await save();
        const created = await native(provider, {
          action: "create",
          name: list.accountName,
          description: list.marker,
          key: list.operationKey,
        });
        if (!created.ok || !created.id) throw Error(created.error || "community_write_review");
        list.accountId = created.id;
      }
      list.intent = "";
      await save();
    }
    const actual = await readAll(provider, list.accountId);
    if (actual.length > expected.length || actual.some((id, index) => id !== expected[index]))
      throw Error("community_destination_changed");
    if (list.intent === "append" && actual.length === list.written)
      throw Error("community_write_review");
    list.written = actual.length;
    list.intent = "";
    list.error = "";
    if (actual.length < expected.length) {
      list.intent = "append";
      list.operationKey = mutationId();
      await save();
      const reply = await native(provider, {
        action: "append",
        id: list.accountId,
        ids: expected.slice(actual.length, actual.length + 25),
        key: list.operationKey,
      });
      if (!reply.ok) throw Error(reply.error || "community_write_review");
      // The next pass reads back before acknowledging these writes.
      list.phase = "pending";
    } else list.phase = "synced";
    await save();
  }
  async function run() {
    await loaded;
    if (!ready()) return;
    for (const provider of ["tidal", "spotify"]) {
      const list = state.lists[provider];
      if (!list || list.phase !== "pending" || list.retryAt > Date.now()) continue;
      try {
        await sync(provider, list);
      } catch (error) {
        list.phase = list.intent ? "review" : "pending";
        list.error = String(error.message).slice(0, 160);
        list.retryAt = Date.now() + 30000;
        await save();
      }
    }
  }
  function trigger() {
    if (
      !work &&
      !stopped &&
      Object.values(state.lists).some(
        (list) => list.phase === "pending" && (!list.retryAt || list.retryAt <= Date.now()),
      )
    )
      work = run()
        .catch(() => {})
        .finally(() => {
          work = null;
        });
  }
  async function contribute(payload) {
    await loaded;
    if (!ready()) return { ok: false, code: "rejected", reason: "playlist_recovering" };
    const previous = state.receipts.find((row) => row.requestId === payload.requestId);
    if (previous)
      return {
        ok: true,
        code: "accepted",
        community: {
          saved: true,
          collectionId: previous.collectionId,
          duplicate: true,
        },
      };
    const provider = await player();
    if (!names[provider]) return { ok: false, code: "rejected", reason: "player_inactive" };
    const list = state.lists[provider],
      existing = library.get(list?.collectionId);
    if (list && !existing)
      return {
        ok: false,
        code: "rejected",
        reason: "community_local_playlist_missing",
      };
    if (existing?.tracks.length >= library.status().limits.tracksPerCollection)
      return { ok: false, code: "rejected", reason: "playlist_track_limit" };
    if (
      !existing &&
      library.status().collections.filter((row) => !row.purpose).length >=
        library.status().limits.collections
    )
      return { ok: false, code: "rejected", reason: "playlist_limit_reached" };
    const result = await submit(payload);
    if (!result.ok || !result.entry?.candidate) return result;
    if (result.entry.candidate.provider !== provider)
      return {
        ...result,
        community: { saved: false, error: "player_changed" },
      };
    try {
      let target = existing;
      if (!target) {
        const made = library.create({
          name: "Community - " + names[provider],
          provider,
        });
        if (!made.ok) throw Error(made.code);
        target = library.get(made.collection.id);
        const marker = "RaveLink community " + crypto.randomUUID();
        state.lists[provider] = {
          collectionId: target.id,
          accountId: "",
          accountName:
            provider === "spotify"
              ? "RaveLink Community " + marker.slice(-8)
              : "RaveLink Community",
          marker,
          written: 0,
          phase: ["tidal", "spotify"].includes(provider) ? "pending" : "local",
          intent: "",
          error: "",
        };
      }
      if (!target.tracks.some((row) => row.identity === result.entry.identity)) {
        const saved = library.replace(target.id, [...target.tracks, result.entry]);
        if (!saved.ok) throw Error(saved.code);
      }
      await saveLibrary();
      state.receipts.push({
        requestId: payload.requestId,
        collectionId: target.id,
      });
      state.receipts = state.receipts.slice(-250);
      const current = state.lists[provider];
      if (current.phase === "synced") current.phase = "pending";
      await save();
      trigger();
      return {
        ...result,
        community: {
          saved: true,
          collectionId: target.id,
          native: current.phase,
        },
      };
    } catch (error) {
      return {
        ...result,
        community: { saved: false, error: String(error.message).slice(0, 80) },
      };
    }
  }
  const api = {
    async submit(payload) {
      const operation = serial.then(() => contribute(payload));
      serial = operation.catch(() => {});
      try {
        return await operation;
      } catch (error) {
        return {
          ok: false,
          code: "rejected",
          reason: String(error.message).slice(0, 80),
        };
      }
    },
    status() {
      return Object.entries(state.lists).map(([provider, list]) => ({
        provider,
        collectionId: list.collectionId,
        phase: list.phase,
        written: list.written,
        error: list.error,
        accountUrl: list.accountId
          ? provider === "tidal"
            ? "https://tidal.com/playlist/" + encodeURIComponent(list.accountId)
            : "https://open.spotify.com/playlist/" + list.accountId.replace("spotify:playlist:", "")
          : "",
      }));
    },
    async retry(provider, confirmAbsent) {
      await loaded;
      if (work) await work;
      const list = state.lists[provider];
      if (!list) return { ok: false, code: "playlist_not_found" };
      if (confirmAbsent) list.intent = "";
      list.phase = "pending";
      list.retryAt = 0;
      await save();
      trigger();
      return { ok: true };
    },
    start() {
      timer = setInterval(trigger, 3000);
      timer.unref?.();
      loaded.then(trigger).catch(() => {});
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await work;
      await serial;
    },
  };
  api.route = async (request) => {
    if (
      request.capability === "song.queue.submit.v1" &&
      request.method === "submit" &&
      request.payload?.addToPlaylist
    )
      return { value: await api.submit(request.payload) };
    if (
      request.capability === "song.playlist.admin.v1" &&
      request.payload?.action === "community_retry"
    )
      return {
        value: await api.retry(request.payload.provider, request.payload.confirmAbsent === true),
      };
    return null;
  };
  return api;
};
