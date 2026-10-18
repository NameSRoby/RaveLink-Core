/**
 * Premium provider.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { trackUri, artworkUrl } = require("./catalog.cjs");
const {
  confidence,
  derivativeAllowed,
  normalizePolicy,
} = require("../../src/capabilities/feature-platform/providers/youtube-catalog-provider");
module.exports = function premiumProvider(options) {
  const api = options.api,
    now = options.now || Date.now;
  let state = null,
    observedAt = 0,
    work = null,
    serial = Promise.resolve(),
    lastError = "",
    owner = "",
    journal = null,
    receipts = new Map(),
    devices = [],
    lastSnapshot = "",
    lastQueue = "";
  const ordered = (action) => {
    const result = serial.then(action);
    serial = result.catch(() => {});
    return result;
  };
  const save = () => {
    if (!journal) return;
    for (const [id, row] of receipts) {
      if (receipts.size < 250) break;
      if (["finished", "failed", "removed"].includes(row.phase)) receipts.delete(id);
    }
    const temporary = journal + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify([...receipts.values()]), {
      mode: 0o600,
    });
    fs.renameSync(temporary, journal);
  };
  async function account() {
    if (owner) return;
    const profile = await api.profile();
    if (!profile.ok) throw Error(profile.error);
    const identity = profile.value?.account_id || profile.value?.id;
    if (typeof identity !== "string" || !identity || identity.length > 200)
      throw Error("spotify_account_unavailable");
    // product is absent in current Development Mode responses. Playback endpoints
    // enforce Premium; do not infer a free account merely from a missing field.
    if (profile.value.product && profile.value.product !== "premium")
      throw Error("spotify_premium_required");
    const hash = crypto.createHash("sha256").update(identity).digest("hex");
    const file = path.join(options.root, "official-requests-" + hash + ".json");
    let rows = [];
    if (fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1048576)
        throw Error("spotify_state_invalid");
      rows = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    if (
      !Array.isArray(rows) ||
      rows.length > 250 ||
      rows.some(
        (row) =>
          !/^[A-Za-z0-9_-]{1,100}$/.test(row.entryId || "") ||
          !trackUri(row.uri) ||
          !["pending", "unknown", "appended", "playing", "finished", "failed", "removed"].includes(
            row.phase,
          ),
      )
    )
      throw Error("spotify_state_invalid");
    receipts = new Map(
      rows.map((row) => [
        row.entryId,
        { ...row, phase: row.phase === "pending" ? "unknown" : row.phase },
      ]),
    );
    owner = hash;
    journal = file;
  }
  async function refresh(force = false) {
    if (work) return work;
    if (!force && state && now() - observedAt < 5000) return;
    work = (async () => {
      try {
        await account();
        const playback = await api.playback();
        if (!playback.ok) throw Error(playback.error);
        const queue = await api.queue();
        if (!queue.ok) throw Error(queue.error);
        const item = playback.value?.item,
          uri = trackUri(item?.uri),
          position = Math.max(0, Number(playback.value?.progress_ms) || 0);
        const sameOccurrence =
          uri &&
          uri === state?.current?.uri &&
          position + 3000 >= (state?.current?.positionMs || 0);
        const current = uri
          ? {
              uri,
              uid: sameOccurrence ? state.current.uid : "official-" + crypto.randomUUID(),
              title: String(item.name || "Spotify").slice(0, 300),
              artists: (item.artists || [])
                .slice(0, 8)
                .map((row) => String(row.name).slice(0, 100)),
              album: String(item.album?.name || "").slice(0, 200),
              artworkUrl: artworkUrl(item.album?.images?.[0]?.url),
              durationMs: Math.max(0, Number(item.duration_ms) || 0),
              positionMs: position,
              paused: playback.value.is_playing !== true,
            }
          : null;
        const rows = queue.value?.queue;
        if (!Array.isArray(rows) || rows.length > 1000)
          throw Error("spotify_queue_shape_unavailable");
        const entries = rows.map((row) => trackUri(row.uri)).filter(Boolean);
        state = {
          current,
          queue: entries,
          volumeAvailable:
            playback.value?.device?.supports_volume === true ||
            typeof playback.value?.device?.volume_percent === "number",
          deviceId: playback.value?.device?.id || "",
          complete: rows.length < 20,
        };
        observedAt = now();
        lastError = "";
        let changed = false;
        for (const row of receipts.values()) {
          // A different Connect device cannot settle ownership on our target.
          if (state.deviceId !== options.getDevice()) continue;
          if (!["appended", "playing"].includes(row.phase)) continue;
          if (
            current?.uri === row.uri &&
            (row.phase === "playing" ||
              (!entries.includes(row.uri) && current.uid !== row.initialUid))
          ) {
            changed ||= row.phase !== "playing" || row.uid !== current.uid;
            row.phase = "playing";
            row.uid = current.uid;
            row.missing = 0;
          } else if (
            row.phase === "playing" ||
            (state.complete &&
              !entries.includes(row.uri) &&
              (row.missing = (row.missing || 0) + 1) >= 2)
          ) {
            row.phase = "finished";
            changed = true;
          }
        }
        if (changed) save();
        const snapshotKey = JSON.stringify([state.deviceId, current]),
          queueKey = JSON.stringify([state.deviceId, entries]);
        if (snapshotKey !== lastSnapshot) {
          lastSnapshot = snapshotKey;
          options.onSnapshot?.({
            ok: true,
            complete: state.complete,
            localDevice: state.deviceId === options.getDevice(),
            queue: [],
            current,
          });
        }
        if (changed || queueKey !== lastQueue) {
          lastQueue = queueKey;
          options.onQueueChanged?.();
        }
      } catch (error) {
        state = null;
        lastError = /^spotify_/.test(error.message) ? error.message : "spotify_api_unavailable";
      }
    })().finally(() => {
      work = null;
    });
    return work;
  }
  function status() {
    const fresh = state && now() - observedAt < 12000,
      selected = fresh && state.deviceId && state.deviceId === options.getDevice();
    const active = [...receipts.values()].filter((row) =>
      ["pending", "unknown", "appended"].includes(row.phase),
    );
    const currentOwner = [...receipts.values()].find(
      (row) => row.phase === "playing" && row.uid === state?.current?.uid,
    );
    const remaining = [...receipts.values()].filter((row) => row.phase === "appended");
    const queueOrder = (fresh ? state.queue : []).flatMap((uri) => {
      const index = remaining.findIndex((row) => row.uri === uri);
      return index < 0 ? [] : [remaining.splice(index, 1)[0].entryId];
    });
    return {
      ok: true,
      enabled: true,
      mode: "official",
      connected: options.auth.status().connected,
      ready: Boolean(selected),
      localDevice: Boolean(selected),
      controlsAvailable: Boolean(selected),
      volumeAvailable: Boolean(selected && state.volumeAvailable),
      queueRemoval: false,
      lastError,
      observedAt,
      devices,
      capacity: {
        limit: 10,
        queued: active.length,
        available: Math.max(0, 10 - active.length),
        reported: Boolean(fresh),
      },
      current:
        fresh && state.current
          ? {
              ...state.current,
              trackId: state.current.uri.slice(14),
              ...(currentOwner || {}),
            }
          : null,
      handoffs: [...receipts.values()].slice(-50).map((row) => ({
        ...row,
        possibleMatches:
          row.phase === "unknown" && state?.queue.filter((uri) => uri === row.uri).length === 1
            ? [{ uid: "official-queue-" + row.entryId }]
            : [],
      })),
      queueOrder,
    };
  }
  async function resolve(payload) {
    const query = String(payload.query || "").trim();
    if (!query || query.length > 300) return { ok: false, error: "spotify_search_query_invalid" };
    const uri = trackUri(query),
      result = await (uri ? api.lookup(uri) : api.search(query));
    if (!result.ok) return result;
    const policy = normalizePolicy(payload.policy || {}),
      candidates = result.candidates
        .filter(
          (row) =>
            (!policy.maxDurationMs || row.durationMs <= policy.maxDurationMs) &&
            derivativeAllowed(query, row.title, policy).ok,
        )
        .map((row) => ({
          ...row,
          confidence: uri ? 1 : confidence(query, [...row.artists, row.title].join(" "), 0),
        }))
        .sort((a, b) => b.confidence - a.confidence);
    return candidates[0] && candidates[0].confidence >= (policy.minimumConfidence || 0.45)
      ? { ok: true, candidate: candidates[0] }
      : { ok: false, error: "spotify_match_not_found" };
  }
  function enqueue(payload) {
    return ordered(async () => {
      await refresh(true);
      if (!status().ready)
        return {
          ok: false,
          error: lastError || "spotify_device_selection_required",
        };
      const old = receipts.get(payload.entryId);
      if (old)
        return ["appended", "playing", "finished"].includes(old.phase)
          ? { ok: true, appended: true, uid: old.uid }
          : { ok: false, error: "spotify_delivery_needs_review" };
      const uri = trackUri(payload.candidate?.providerItemId);
      if (!uri || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.entryId || ""))
        return { ok: false, error: "spotify_track_invalid" };
      if (
        status().capacity.available < 1 ||
        (receipts.size >= 250 &&
          ![...receipts.values()].some((row) =>
            ["finished", "failed", "removed"].includes(row.phase),
          ))
      )
        return { ok: false, error: "spotify_native_queue_full" };
      if (state.queue.includes(uri)) return { ok: false, error: "spotify_item_already_queued" };
      const device = options.getDevice();
      const row = {
        entryId: payload.entryId,
        uri,
        trackId: uri.slice(14),
        uid: "official-queue-" + payload.entryId,
        initialUid: state.current?.uid || "",
        phase: "pending",
        createdAt: now(),
        candidate: payload.candidate,
        requesterKey: String(payload.requesterKey || "").slice(0, 80),
        requesterLabel: String(payload.requesterLabel || "").slice(0, 100),
        requesterRole: payload.requesterRole,
      };
      receipts.set(row.entryId, row);
      save();
      const result = await api.append(uri, device);
      row.phase =
        result.ok || result.error === "spotify_delivery_unconfirmed" ? "unknown" : "failed";
      row.lastError = result.error || "spotify_delivery_unconfirmed";
      if (result.ok) {
        await refresh(true);
        if (
          state?.deviceId === device &&
          state.queue.filter((value) => value === uri).length === 1
        ) {
          row.phase = "appended";
          row.lastError = "";
        }
      }
      save();
      return row.phase === "appended"
        ? { ok: true, appended: true, uid: row.uid }
        : { ok: false, error: row.lastError };
    });
  }
  async function control(payload) {
    await refresh(true);
    if (!status().controlsAvailable)
      return {
        ok: false,
        error: lastError || "spotify_device_selection_required",
      };
    if (
      payload.action === "skip" &&
      (!payload.currentUid || payload.currentUid !== state.current?.uid)
    )
      return { ok: false, error: "spotify_current_changed" };
    const result = await api.control(payload, options.getDevice());
    if (result.ok) observedAt = 0;
    return result;
  }
  async function remove(payload) {
    await refresh(true);
    if (!state)
      return {
        ok: false,
        error: lastError || "spotify_api_unavailable",
        removed: 0,
      };
    const matches = [...receipts.values()].filter(
      (row) =>
        ["appended", "playing", "pending", "unknown"].includes(row.phase) &&
        (payload.entryId
          ? row.entryId === payload.entryId
          : payload.trackId
            ? row.trackId === payload.trackId
            : payload.requesterKey && row.requesterKey === payload.requesterKey),
    );
    const queued = matches.some((row) => row.phase !== "playing");
    const uid = payload.currentUid || matches.find((row) => row.phase === "playing")?.uid;
    if (!uid)
      return queued
        ? { ok: false, error: "spotify_queue_removal_unsupported", removed: 0 }
        : { ok: true, removed: 0 };
    const result = await control({ action: "skip", currentUid: uid });
    if (result.ok) {
      matches
        .filter((row) => row.phase === "playing")
        .forEach((row) => {
          row.phase = "removed";
        });
      save();
    }
    return queued && result.ok
      ? { ok: false, error: "spotify_queue_removal_unsupported", removed: 1 }
      : { ...result, removed: result.ok ? 1 : 0 };
  }
  async function handle(method, payload = {}) {
    if (method === "status") {
      await refresh();
      return status();
    }
    if (method === "resolve") return resolve(payload);
    if (method === "enqueue") return enqueue(payload);
    if (method === "remove") return ordered(() => remove(payload));
    if (method === "control") return ordered(() => control(payload));
    if (method === "devices") {
      const result = await api.devices();
      if (!result.ok) return result;
      devices = (result.value?.devices || [])
        .filter((row) => /^[A-Za-z0-9_-]{1,120}$/.test(row.id || "") && !row.is_restricted)
        .slice(0, 20)
        .map((row) => ({
          id: row.id,
          name: String(row.name || "Spotify device").slice(0, 100),
          active: row.is_active === true,
        }));
      return { ok: true, devices };
    }
    if (method === "review")
      return ordered(async () => {
        await refresh(true);
        const row = receipts.get(payload.entryId);
        if (!row || !state?.complete || !["unknown", "failed"].includes(row.phase))
          return { ok: false, error: "spotify_review_unavailable" };
        if (
          payload.decision === "adopt" &&
          payload.uid === row.uid &&
          state.queue.filter((uri) => uri === row.uri).length === 1
        ) {
          row.phase = "appended";
          row.lastError = "";
        } else if (
          payload.decision === "absent" &&
          !state.queue.includes(row.uri) &&
          state.current?.uri !== row.uri
        )
          receipts.delete(row.entryId);
        else return { ok: false, error: "spotify_review_unavailable" };
        save();
        return { ok: true };
      });
    return { ok: false, error: "spotify_method_invalid" };
  }
  return {
    handle,
    status,
    reset() {
      owner = "";
      journal = null;
      receipts = new Map();
      state = null;
      observedAt = 0;
      lastSnapshot = "";
      lastQueue = "";
    },
    refresh,
  };
};
