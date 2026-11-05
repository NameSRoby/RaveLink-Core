/**
 * First-party adapter for YouTube Music's private application services.
 * This entire function is serialized by scripting.executeScript into MAIN.
 * Keep it self-contained: no extension APIs, imported helpers, pairing token,
 * cookies, arbitrary endpoints, executable strings or raw application state.
 * DOM queries locate the service roots only; operations do not click the UI.
 * The page can inspect/interfere with MAIN code, so its output stays untrusted.
 */
globalThis.RaveLinkYouTubeNative = async function nativeService(command = { action: "inspect" }) {
  const clean = (value, length = 180) =>
    typeof value === "string"
      ? value
          .replace(/[<>\u0000-\u001f\u007f]/g, " ")
          .trim()
          .slice(0, length)
      : "";
  const idText = (value) =>
    ["string", "number"].includes(typeof value) ? String(value).slice(0, 128) : "";
  const videoId = (value) =>
    typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : "";
  const error = (code) => ({ ok: false, error: code });
  if (location.origin !== "https://music.youtube.com") return error("native_unavailable");
  const key = Symbol.for("ravelink.youtube.native.v1");
  if (!document[key])
    document[key] = { id: crypto.randomUUID(), jobs: new Map(), owned: new Map() };
  const memory = document[key];
  if (!memory.rows) memory.rows = new WeakMap();
  if (!Number.isInteger(memory.epoch)) memory.epoch = 0;
  if (command.action === "retire") {
    memory.epoch++;
    return { ok: true };
  }
  const queueNode = document.querySelector("#queue");
  const queue = queueNode?.queue;
  const store = queue?.store?.store;
  const app = document.querySelector("ytmusic-app");
  const player =
    document.querySelector("ytmusic-player")?.playerApi || document.querySelector("#movie_player");
  const media = document.querySelector("ytmusic-player video, #movie_player video");
  function rawItems() {
    try {
      const items = queue?.getItems?.();
      return Array.isArray(items) ? items : [];
    } catch {
      return [];
    }
  }
  function renderer(row) {
    return (
      row?.playlistPanelVideoRenderer ||
      row?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer ||
      {}
    );
  }
  function plain(value) {
    return clean(value?.simpleText || value?.runs?.map((x) => x.text || "").join("") || value);
  }
  function rows() {
    return rawItems()
      .slice(0, 100)
      .map((row) => {
        if (!row || typeof row !== "object") return { videoId: "", occurrenceId: "" };
        const data = renderer(row);
        const nativeId = idText(
          row.queueItemId ??
            data.queueItemId ??
            data.playlistSetVideoId ??
            row.playlistSetVideoId ??
            data.setVideoId,
        );
        // Preserve real object identity; never derive an occurrence from its
        // index, title or video ID. Replaced objects get new page-local handles.
        if (!memory.rows.has(row)) memory.rows.set(row, `row_${crypto.randomUUID()}`);
        const occurrenceId = nativeId ? `native_${nativeId}` : memory.rows.get(row);
        return {
          videoId: videoId(data.videoId),
          occurrenceId,
          selected: data.selected === true,
          title: plain(data.title),
          artist: plain(data.longBylineText || data.shortBylineText)
            .split(/[\u2022\u00b7]/)[0]
            .trim(),
          identityKind: nativeId ? "native" : "object",
          identityAvailable: Boolean(occurrenceId),
        };
      });
  }
  function data() {
    try {
      return player?.getVideoData?.() || {};
    } catch {
      return {};
    }
  }
  function currentId() {
    return videoId(data().video_id);
  }
  function ad() {
    return Boolean(document.querySelector("#movie_player.ad-showing, ytmusic-player.ad-showing"));
  }
  /** Structural contract, not a website build-number lock. Extra fields are
   * harmless. Required methods/state must agree before we dispatch any action.
   * Readiness failures recover on later inspections; uncertain writes latch for
   * this document so a caller cannot compound a possibly applied mutation.
   */
  function compatibility() {
    let items, state;
    const reasons = [];
    try {
      items = queue?.getItems?.();
      state = store?.getState?.()?.queue;
    } catch {
      reasons.push("queue_read_failed");
    }
    if (!Array.isArray(items)) reasons.push("queue_items_unavailable");
    if (!state || !Array.isArray(state.items)) reasons.push("queue_state_unavailable");
    if (typeof queueNode?.dispatch !== "function") reasons.push("queue_dispatch_unavailable");
    if (Array.isArray(items) && Array.isArray(state?.items)) {
      if (
        items.length !== state.items.length ||
        items.some(
          (item, index) =>
            !videoId(renderer(item).videoId) ||
            renderer(item).videoId !== renderer(state.items[index]).videoId,
        )
      )
        reasons.push("queue_state_mismatch");
      const selected = items.filter((item) => renderer(item).selected === true);
      if (selected.length !== 1 || renderer(selected[0]).videoId !== currentId())
        reasons.push("queue_selection_unavailable");
    }
    if (state?.shuffleEnabled !== false) reasons.push("shuffle_not_supported");
    const nextId = state?.nextQueueItemId;
    if (
      !(Number.isSafeInteger(nextId) && nextId >= 0) &&
      !(typeof nextId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(nextId))
    )
      reasons.push("queue_counter_unavailable");
    if (memory.queueFault) reasons.push(memory.queueFault);
    return {
      contract: "ytmusic-services-v1",
      queueReady: reasons.length === 0,
      blocked: Boolean(memory.queueFault),
      reasons,
    };
  }
  function capabilities() {
    const items = rows(),
      allIdentified =
        items.length > 0 &&
        items.every((x) => x.videoId && x.occurrenceId) &&
        new Set(items.map((x) => x.occurrenceId)).size === items.length;
    return {
      available: Boolean(queue || player?.getVideoData),
      documentId: memory.id,
      queueRead: typeof queue?.getItems === "function",
      queueWrite: compatibility().queueReady,
      requestInsertion: true,
      network: typeof app?.networkManager?.fetch === "function",
      player: typeof player?.getVideoData === "function",
      allIdentified,
      queueSize: rawItems().length,
      ownedCount: memory.owned.size,
      compatibility: compatibility(),
    };
  }
  function inspect() {
    const caps = capabilities(),
      track = data(),
      id = currentId(),
      items = rawItems();
    return {
      ok: true,
      native: caps,
      snapshot: {
        ...(id
          ? { current: { videoId: id, title: clean(track.title), artist: clean(track.author) } }
          : {}),
        queue: rows(),
        queueComplete: caps.queueRead && items.length <= 100 && !queue?.continuation,
        ...(media
          ? {
              paused: media.paused,
              position: media.currentTime || 0,
              duration: Number.isFinite(media.duration) ? media.duration : 0,
              volume: Math.round(media.volume * 100),
              mediaReady: media.readyState >= 1,
            }
          : {}),
        ad: ad(),
      },
    };
  }
  if (command.action === "inspect") {
    try {
      return inspect();
    } catch {
      return error("native_unavailable");
    }
  }
  if (!["append", "remove", "pause", "resume", "volume", "skip"].includes(command.action))
    return error("unsupported_control");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(command.id || "") || !command.sessionId)
    return error("unsupported_control");
  const cacheKey = `${command.sessionId}:${command.id}`;
  const signature = JSON.stringify([
    command.action,
    command.expectedVideoId,
    command.nativeDocumentId,
    command.videoId,
    command.occurrenceId,
    command.afterOccurrenceId,
    command.value,
  ]);
  const prior = memory.jobs.get(cacheKey);
  if (prior) return prior.signature === signature ? prior.promise : error("native_id_conflict");
  if (memory.jobs.size >= 512) return error("native_session_full");
  async function run() {
    const epoch = memory.epoch;
    if (command.nativeDocumentId && command.nativeDocumentId !== memory.id)
      return error("player_changed");
    if (!videoId(command.expectedVideoId) || currentId() !== command.expectedVideoId)
      return error("player_changed");
    if (!Number.isFinite(command.deadlineAt) || Date.now() >= command.deadlineAt)
      return error("control_unconfirmed");
    if (ad()) return error("unsupported_control");
    const before = rows(),
      caps = capabilities();
    const sequence = (items) => items.map((row) => row.occurrenceId).join("|");
    const beforeSequence = sequence(before);
    if (
      ["append", "remove", "skip"].includes(command.action) &&
      (!caps.queueRead || !caps.queueWrite || !caps.allIdentified || caps.queueSize > 100)
    )
      return error("native_queue_unavailable");
    if (command.action === "append") {
      const anchor =
        command.afterOccurrenceId &&
        before.find((row) => row.occurrenceId === command.afterOccurrenceId);
      if (
        command.afterOccurrenceId &&
        (!anchor || (!anchor.selected && !memory.owned.has(anchor.occurrenceId)))
      )
        return error("native_entry_not_owned");
      if (caps.queueSize >= 100) return error("native_queue_unavailable");
      if (!caps.network || !videoId(command.videoId)) return error("native_queue_unavailable");
      const state = store.getState().queue;
      if (state.shuffleEnabled === true) return error("native_queue_unavailable");
      const fetched = await app.networkManager.fetch("/music/get_queue", {
        queueContextParams: state.queueContextParams,
        queueInsertPosition: "INSERT_AT_END",
        videoIds: [command.videoId],
      });
      const additions = Array.isArray(fetched?.queueDatas)
        ? fetched.queueDatas.map((x) => x?.content).filter(Boolean)
        : [];
      if (additions.length !== 1 || videoId(renderer(additions[0]).videoId) !== command.videoId) {
        memory.queueFault = "queue_response_changed";
        return error("native_schema_changed");
      }
      // A network read may outlive the command or overlap a manual queue change.
      // Revalidate immediately before the only local queue mutation.
      if (
        Date.now() >= command.deadlineAt ||
        memory.epoch !== epoch ||
        currentId() !== command.expectedVideoId ||
        sequence(rows()) !== beforeSequence ||
        !compatibility().queueReady ||
        ad()
      )
        return error("control_unconfirmed");
      dispatch({
        type: "ADD_ITEMS",
        payload: {
          nextQueueItemId: store.getState().queue.nextQueueItemId,
          index: command.afterOccurrenceId
            ? before.findIndex((row) => row.occurrenceId === command.afterOccurrenceId) + 1
            : before.length,
          items: additions,
          shuffleEnabled: false,
          shouldAssignIds: true,
        },
      });
    } else if (command.action === "remove") {
      const owned = memory.owned.get(command.occurrenceId);
      const index = before.findIndex((row) => row.occurrenceId === command.occurrenceId);
      if (!owned || index < 0 || before[index].selected || before[index].videoId !== owned.videoId)
        return error("native_entry_not_owned");
      dispatch({ type: "REMOVE_ITEM", payload: index });
    } else if (command.action === "skip") {
      const index = before.findIndex((row) => row.selected);
      if (index < 0 || index + 1 >= before.length) return error("unsupported_control");
      dispatch({ type: "SET_INDEX", payload: index + 1 });
    } else if (command.action === "pause" && typeof player?.pauseVideo === "function")
      player.pauseVideo();
    else if (command.action === "resume" && typeof player?.playVideo === "function") {
      try {
        await player.playVideo();
      } catch {
        return error("autoplay_blocked");
      }
    } else if (
      command.action === "volume" &&
      Number.isInteger(command.value) &&
      command.value >= 0 &&
      command.value <= 100 &&
      typeof player?.setVolume === "function"
    )
      player.setVolume(command.value);
    else return error("native_unavailable");
    for (let attempt = 0; attempt < 20 && Date.now() < command.deadlineAt; attempt++) {
      if (memory.epoch !== epoch) return error("control_unconfirmed");
      const after = rows(),
        sameSong = currentId() === command.expectedVideoId;
      if (
        command.action === "append" &&
        sameSong &&
        after.length === before.length + 1 &&
        sequence(
          after.filter(
            (_row, index) =>
              index !==
              (command.afterOccurrenceId
                ? before.findIndex((row) => row.occurrenceId === command.afterOccurrenceId) + 1
                : before.length),
          ),
        ) === beforeSequence
      ) {
        const added =
          after[
            command.afterOccurrenceId
              ? before.findIndex((row) => row.occurrenceId === command.afterOccurrenceId) + 1
              : before.length
          ];
        if (
          added.videoId === command.videoId &&
          added.occurrenceId &&
          !before.some((x) => x.occurrenceId === added.occurrenceId)
        ) {
          const receipt = {
            occurrenceId: added.occurrenceId,
            videoId: added.videoId,
            nativeDocumentId: memory.id,
          };
          memory.owned.set(added.occurrenceId, receipt);
          return { ok: true, ...receipt };
        }
      }
      if (
        command.action === "remove" &&
        sameSong &&
        sequence(after) === sequence(before.filter((x) => x.occurrenceId !== command.occurrenceId))
      ) {
        memory.owned.delete(command.occurrenceId);
        return { ok: true, occurrenceId: command.occurrenceId, nativeDocumentId: memory.id };
      }
      if (
        command.action === "skip" &&
        after.find((x) => x.selected)?.occurrenceId &&
        after.find((x) => x.selected)?.occurrenceId !== before.find((x) => x.selected)?.occurrenceId
      )
        return { ok: true };
      if (
        sameSong &&
        media &&
        ((command.action === "pause" && media.paused) ||
          (command.action === "resume" && !media.paused) ||
          (command.action === "volume" && Math.round(media.volume * 100) === command.value))
      )
        return { ok: true };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (["append", "remove", "skip"].includes(command.action))
      memory.queueFault = "queue_write_unconfirmed";
    return error(
      command.action === "resume" && media?.paused ? "autoplay_blocked" : "control_unconfirmed",
    );
  }
  function dispatch(action) {
    try {
      queueNode.dispatch(action);
    } catch {
      // Dispatch can throw after changing state. Never assume it had no effect.
      memory.queueFault = "queue_write_unconfirmed";
      throw Error("queue_write_unconfirmed");
    }
  }
  const promise = run().catch(() => error("control_unconfirmed"));
  memory.jobs.set(cacheKey, { signature, promise });
  return promise;
};
