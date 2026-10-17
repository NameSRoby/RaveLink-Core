/**
 * TIDAL renderer runtime and native platform capture.
 * Capture only the reviewed native methods needed by the companion. Connection,
 * queue state, and command results stay bounded at the bridge. External desktop
 * client shapes can change; unsupported shapes must stop the operation explicitly
 * rather than fabricate success or retry a possibly completed native write.
 */
// RaveLink's narrow main-world Redux facade. No plugin loader or cloud API.
(function installHooks() {
  if (globalThis.__ravelinkTidal) return;
  const creators = new Map(),
    listeners = new Map(),
    stores = [];
  const allowed = new Set([
    "content/LOAD_SINGLE_MEDIA_ITEM",
    "content/LOAD_SINGLE_MEDIA_ITEM_SUCCESS",
    "content/LOAD_SINGLE_MEDIA_ITEM_FAIL",
    "playQueue/ADD_MEDIA_ITEMS_TO_QUEUE",
    "playQueue/REMOVE_ELEMENT",
    "playbackControls/SKIP_NEXT",
    "playbackControls/SET_VOLUME",
  ]);
  const currentStore = () =>
    stores.findLast((store) => {
      try {
        const state = store.getState();
        return state?.playQueue && state?.activePlayer;
      } catch {
        return false;
      }
    });
  globalThis.__ravelinkTidal = {
    wrapAction(factory) {
      return function (...args) {
        const creator = factory.apply(this, args),
          type = args[0];
        if (!allowed.has(type)) return creator;
        const wrapped = new Proxy(creator, {
          apply(target, receiver, payload) {
            const result = Reflect.apply(target, receiver, payload);
            for (const listener of listeners.get(type) || []) {
              try {
                listener(result.payload);
              } catch {}
            }
            return result;
          },
        });
        creators.set(type, wrapped);
        return wrapped;
      };
    },
    captureStore(store) {
      if (
        store?.getState &&
        store?.dispatch &&
        store?.subscribe &&
        !stores.includes(store) &&
        stores.length < 16
      )
        stores.push(store);
      return store;
    },
    ready() {
      return Boolean(
        currentStore() &&
        [
          "content/LOAD_SINGLE_MEDIA_ITEM",
          "content/LOAD_SINGLE_MEDIA_ITEM_SUCCESS",
          "content/LOAD_SINGLE_MEDIA_ITEM_FAIL",
          "playQueue/ADD_MEDIA_ITEMS_TO_QUEUE",
        ].every((type) => creators.has(type)),
      );
    },
    redux: {
      store: { getState: () => currentStore()?.getState() },
      actions: new Proxy(
        {},
        {
          get: (_target, type) => {
            if (!allowed.has(type) || !creators.has(type)) return undefined;
            return (payload) => {
              const store = currentStore(),
                creator = creators.get(type);
              if (!store || !creator) throw new Error("tidal_hooks_unavailable");
              return store.dispatch(creator(payload));
            };
          },
        },
      ),
      interceptActionResp(
        trigger,
        unloads,
        success,
        failure,
        { timeoutMs = 3500, predicate } = {},
      ) {
        return new Promise((resolve, reject) => {
          let timer,
            done = false;
          const removals = [];
          const finish = (error, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            for (const remove of removals) remove();
            unloads?.delete(cancel);
            error ? reject(new Error(error)) : resolve(value);
          };
          const cancel = () => finish("tidal_companion_stopped");
          for (const [types, failed] of [
            [success, false],
            [failure || [], true],
          ])
            for (const type of types) {
              const set = listeners.get(type) || new Set();
              listeners.set(type, set);
              const listener = (value) => {
                if (!predicate || predicate(value))
                  finish(failed ? "tidal_metadata_failed" : "", value);
              };
              set.add(listener);
              removals.push(() => set.delete(listener));
            }
          unloads?.add(cancel);
          timer = setTimeout(() => finish("tidal_metadata_timeout"), timeoutMs);
          try {
            trigger();
          } catch {
            finish("tidal_hooks_unavailable");
          }
        });
      },
    },
  };
})();

/**
 * Adapter.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
// App-specific hooks. Account credentials and media streams never leave TIDAL.
function createAdapter(redux, unloads, options = {}) {
  const clean = (value, maximum) =>
    String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, maximum);
  async function resolve(id) {
    const result = await redux.interceptActionResp(
      () =>
        redux.actions["content/LOAD_SINGLE_MEDIA_ITEM"]({
          id,
          itemType: "track",
        }),
      unloads,
      ["content/LOAD_SINGLE_MEDIA_ITEM_SUCCESS"],
      ["content/LOAD_SINGLE_MEDIA_ITEM_FAIL"],
      {
        timeoutMs: 3500,
        predicate: (value) =>
          String(
            value?.mediaItem?.item?.id ??
              value?.mediaItem?.id ??
              (typeof value === "string" ? value : value?.id),
          ) === id,
      },
    );
    const item = result?.mediaItem?.item || result?.mediaItem;
    if (
      !item ||
      String(item.id) !== id ||
      item.contentType !== "track" ||
      item.allowStreaming !== true ||
      item.streamReady !== true
    )
      throw new Error("tidal_track_not_playable");
    const durationMs = Math.trunc(Number(item.duration) * 1000);
    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 86400000)
      throw new Error("tidal_duration_invalid");
    const title =
      item.version &&
      !String(item.title || "")
        .toLowerCase()
        .includes(String(item.version).toLowerCase())
        ? `${item.title} (${item.version})`
        : item.title;
    return {
      provider: "tidal",
      providerItemId: id,
      title: clean(title, 200),
      artists: (item.artists || []).slice(0, 8).map((artist) => clean(artist.name, 100)),
      album: clean(item.album?.title, 200),
      durationMs,
    };
  }
  function elements() {
    const state = redux.store.getState();
    const localDevice =
      state.player === "BOOMBOX" ||
      (state.player &&
        typeof state.player === "object" &&
        typeof state.player.activeDeviceId === "string" &&
        state.remotePlayback?.isConnected === false);
    if (
      !Array.isArray(state.playQueue?.elements) ||
      !localDevice ||
      state.playQueue.type === "cloud" ||
      state.remotePlayback?.remotePlaybackReceiverState > 0 ||
      !["PLAYER_SDK", "WEBPLAYER"].includes(state.activePlayer?.activePlayer)
    )
      throw new Error("tidal_local_queue_required");
    return state.playQueue.elements;
  }
  function manualRows(rows, currentIndex) {
    const cloud = redux.store.getState().playQueue.type === "cloudV2";
    return rows
      .slice(currentIndex + 1)
      .filter((item) =>
        cloud ? item.context?.type === "UNKNOWN" : item.priority === "priority_keep",
      );
  }
  function queueSnapshot() {
    try {
      const rows = elements(),
        currentIndex = redux.store.getState().playQueue.currentIndex;
      if (!rows[currentIndex]?.uid) return null;
      const upcoming = manualRows(rows, currentIndex);
      const currentTrackId = String(rows[currentIndex].mediaItemId);
      return {
        count: upcoming.length,
        currentUid: String(rows[currentIndex].uid),
        ...(/^[1-9][0-9]{0,19}$/.test(currentTrackId) ? { currentTrackId } : {}),
        uids: upcoming.slice(0, 50).map((item) => String(item.uid)),
      };
    } catch {
      return null;
    }
  }
  async function append(id, deadline = Infinity) {
    let writeAttempted = false;
    try {
      await resolve(id);
      if (options.isStopped?.() || Date.now() >= deadline) throw new Error("tidal_command_expired");
      const rows = elements();
      const before = rows.map((item) => ({
        uid: item.uid,
        mediaItemId: String(item.mediaItemId),
      }));
      if (!before.length || before.length > 1000)
        throw new Error("tidal_initialized_queue_required");
      const currentIndex = redux.store.getState().playQueue.currentIndex;
      const currentUid = before[currentIndex]?.uid;
      if (!currentUid) throw new Error("tidal_initialized_queue_required");
      if (manualRows(rows, currentIndex).length >= 10) throw new Error("tidal_native_queue_full");
      // Append behind upcoming manual requests, before the playlist resumes.
      // Cloud-v2 marks ALL restored future items priority_keep, so distinguish
      // its manual queue by UNKNOWN source context rather than priority alone.
      const cloud = redux.store.getState().playQueue.type === "cloudV2";
      let insertionIndex = currentIndex + 1;
      while (
        insertionIndex < rows.length &&
        (cloud
          ? rows[insertionIndex].context?.type === "UNKNOWN"
          : rows[insertionIndex].priority === "priority_keep")
      )
        insertionIndex++;
      // Use the same entry point as TIDAL's own single-track queue UI. This
      // hydrates metadata, honors content restrictions and selects the active
      // local/cloud-v2 queue saga. Never clear, play-now or rebuild the queue.
      if (
        redux.store.getState().playQueue.type === "cloudV2" &&
        !redux.store.getState().cloudQueueV2?.queueId
      )
        throw new Error("tidal_cloud_queue_required");
      writeAttempted = true;
      redux.actions["playQueue/ADD_MEDIA_ITEMS_TO_QUEUE"]({
        sourceContext: { type: "UNKNOWN" },
        mediaItemIds: [id],
        position: insertionIndex,
        options: { overwritePlayQueue: false },
      });
      // Queue updates are asynchronous in current TIDAL. Confirm the native UID,
      // exact FIFO position and preservation of every previous item/current track.
      const until = Math.min(deadline, Date.now() + 4500);
      do {
        const after = elements(),
          added = after.filter((item) => !before.some((previous) => previous.uid === item.uid));
        if (
          added.length === 1 &&
          String(added[0].mediaItemId) === id &&
          after.length === before.length + 1 &&
          after[insertionIndex]?.uid === added[0].uid &&
          after[redux.store.getState().playQueue.currentIndex]?.uid === currentUid &&
          after
            .filter((item) => item.uid !== added[0].uid)
            .every(
              (item, index) =>
                item.uid === before[index].uid &&
                String(item.mediaItemId) === before[index].mediaItemId,
            )
        ) {
          return {
            appended: true,
            uid: String(added[0].uid),
            placement: "fifo",
          };
        }
        if (options.isStopped?.() || Date.now() >= until) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < until);
      throw new Error("tidal_append_unconfirmed");
    } catch (error) {
      error.writeAttempted = writeAttempted;
      throw error;
    }
  }
  async function remove(targets, deadline = Infinity) {
    let writeAttempted = false;
    try {
      if (
        !Array.isArray(targets) ||
        !targets.length ||
        targets.length > 25 ||
        targets.some(
          (row) =>
            !/^[A-Za-z0-9_-]{1,160}$/.test(row.uid || "") ||
            !/^[1-9][0-9]{0,19}$/.test(row.trackId || ""),
        ) ||
        new Set(targets.map((row) => row.uid)).size !== targets.length
      )
        throw new Error("tidal_remove_invalid");
      const removed = [];
      // Remove upcoming requests first, then skip a matching current request.
      const ordered = [...targets].sort(
        (a, b) =>
          Number(a.uid === queueSnapshot()?.currentUid) -
          Number(b.uid === queueSnapshot()?.currentUid),
      );
      for (const target of ordered) {
        if (options.isStopped?.() || Date.now() >= deadline)
          throw new Error("tidal_command_expired");
        const before = elements(),
          state = redux.store.getState(),
          index = before.findIndex((row) => String(row.uid) === target.uid);
        if (index < 0 || index < state.playQueue.currentIndex) {
          removed.push(target.uid);
          continue;
        }
        if (String(before[index].mediaItemId) !== target.trackId)
          throw new Error("tidal_remove_invalid");
        const current = index === state.playQueue.currentIndex;
        const action =
          redux.actions[current ? "playbackControls/SKIP_NEXT" : "playQueue/REMOVE_ELEMENT"];
        if (!action || (current && index + 1 >= before.length))
          throw new Error("tidal_remove_unavailable");
        writeAttempted = true;
        action(current ? undefined : { uid: target.uid });
        const until = Math.min(deadline, Date.now() + 2500);
        let confirmed = false;
        do {
          const after = elements(),
            currentUid = after[redux.store.getState().playQueue.currentIndex]?.uid;
          confirmed = current
            ? String(currentUid) !== target.uid && Boolean(currentUid)
            : !after.some((row) => String(row.uid) === target.uid);
          if (confirmed) break;
          if (options.isStopped?.() || Date.now() >= until) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < until);
        if (!confirmed) throw new Error("tidal_remove_unconfirmed");
        removed.push(target.uid);
      }
      return { removed: true, uids: removed, queue: queueSnapshot() };
    } catch (error) {
      error.writeAttempted = writeAttempted;
      throw error;
    }
  }
  function canSetVolume() {
    const state = redux.store.getState();
    return Boolean(
      redux.actions["playbackControls/SET_VOLUME"] &&
      Number.isFinite(state?.playbackControls?.volume) &&
      ["PLAYER_SDK", "WEBPLAYER"].includes(state.activePlayer?.activePlayer) &&
      state.player !== "REMOTE_PLAYBACK" &&
      state.player !== "GOOGLE_CAST" &&
      state.remotePlayback?.isConnected !== true &&
      !(state.remotePlayback?.remotePlaybackReceiverState > 0),
    );
  }
  async function setVolume(percent, deadline = Infinity) {
    if (
      !Number.isInteger(percent) ||
      percent < 0 ||
      percent > 100 ||
      options.isStopped?.() ||
      Date.now() >= deadline
    )
      throw new Error("tidal_volume_invalid");
    if (!canSetVolume()) throw new Error("tidal_volume_unavailable");
    redux.actions["playbackControls/SET_VOLUME"]({ volume: percent });
    const until = Math.min(deadline, Date.now() + 1500);
    do {
      if (Math.abs(redux.store.getState().playbackControls.volume - percent) < 0.5)
        return { percent };
      if (options.isStopped?.()) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < until);
    throw new Error("tidal_volume_unconfirmed");
  }
  return {
    resolve,
    append,
    remove,
    setVolume,
    canSetVolume,
    queueSnapshot,
    canRemove: () =>
      Boolean(
        redux.actions["playQueue/REMOVE_ELEMENT"] && redux.actions["playbackControls/SKIP_NEXT"],
      ),
    ready: () => {
      try {
        const rows = elements(),
          state = redux.store.getState();
        return Boolean(
          rows.length &&
          rows.length <= 1000 &&
          rows[state.playQueue.currentIndex]?.uid &&
          (state.playQueue.type !== "cloudV2" || state.cloudQueueV2?.queueId) &&
          redux.actions["playQueue/ADD_MEDIA_ITEMS_TO_QUEUE"],
        );
      } catch {
        return false;
      }
    },
  };
};

/**
 * TIDAL single-flight polling loop.
 * Schedule the next tick only after the current snapshot/command receipt completes.
 * This prevents overlapping polls during a slow native operation. Core being offline
 * must leave ordinary TIDAL playback alone. Page teardown stops future polling and
 * must not schedule a new timer after an awaited operation settles.
 */
(function startCompanion() {
  if (globalThis.__ravelinkTidalPolling || !globalThis.__ravelinkTidalBridge) return;
  globalThis.__ravelinkTidalPolling = true;
  const unloads = new Set();
  let stopped = false,
    timer;
  const adapter = createAdapter(globalThis.__ravelinkTidal.redux, unloads, {
    isStopped: () => stopped,
  });
  const companionId = crypto.randomUUID();
  addEventListener("pagehide", () => {
    stopped = true;
    clearTimeout(timer);
    for (const unload of unloads) unload();
    unloads.clear();
  });
  async function tick() {
    try {
      const reply = await globalThis.__ravelinkTidalBridge.call("next", {
        companionId,
        ready: globalThis.__ravelinkTidal.ready(),
        queueReady: adapter.ready(),
        moderationReady: adapter.canRemove(),
        volumeReady: adapter.canSetVolume(),
        queue: adapter.queueSnapshot(),
      });
      const command = reply.command;
      if (command && !stopped) {
        let result = { id: command.id, companionId, ok: false };
        try {
          if (Date.now() >= command.expiresAt) throw new Error("tidal_command_invalid");
          if (command.kind === "volume")
            result = {
              ...result,
              ok: true,
              ...(await adapter.setVolume(command.percent, command.expiresAt)),
            };
          else if (!/^[1-9][0-9]{0,19}$/.test(command.trackId))
            throw new Error("tidal_command_invalid");
          else if (command.kind === "resolve")
            result = {
              ...result,
              ok: true,
              candidate: await adapter.resolve(command.trackId),
            };
          else if (command.kind === "append")
            result = {
              ...result,
              ok: true,
              ...(await adapter.append(command.trackId, command.expiresAt)),
            };
          else if (command.kind === "remove")
            result = {
              ...result,
              ok: true,
              ...(await adapter.remove(command.targets, command.expiresAt)),
            };
        } catch (error) {
          result.error = String(error?.message || "").slice(0, 80);
          if (typeof error.writeAttempted === "boolean")
            result.writeAttempted = error.writeAttempted;
        }
        if (!stopped) await globalThis.__ravelinkTidalBridge.call("result", result);
      }
    } catch {
      /* Core offline or unpaired: stay isolated from TIDAL playback. */
    }
    if (!stopped) timer = setTimeout(tick, 2000);
  }
  void tick();
})();
