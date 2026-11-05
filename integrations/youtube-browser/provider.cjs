/** Optional Core host for one explicitly paired YouTube Music tab.
 * Persist intent before dispatch. A lost receipt is held for review, never replayed.
 * Browser cookies, stream URLs and account credentials never leave the website. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonFile } = require("../../src/shared/fs/json-file-store");
const createBridge = require("./bridge.cjs");
module.exports = function createYoutubeBrowserProvider(options) {
  const journal = path.join(options.runtimeDir, "youtube-browser", "requests.json");
  const entries = new Map();
  let bridge = null,
    connection = null,
    connecting = null,
    work = Promise.resolve();
  let lastObservation = 0,
    stopping = false,
    loadError = false,
    watchdog = null,
    observedAvailable = false;
  try {
    const saved = JSON.parse(fs.readFileSync(journal, "utf8"));
    if (saved.version !== 1 || !Array.isArray(saved.entries)) throw Error("journal_invalid");
    for (const row of (Array.isArray(saved.entries) ? saved.entries : []).slice(-512))
      if (typeof row.entryId === "string" && /^[A-Za-z0-9_-]{11}$/.test(row.trackId || ""))
        entries.set(row.entryId, {
          ...row,
          phase: ["pending", "appended", "playing"].includes(row.phase) ? "unknown" : row.phase,
        });
  } catch (error) {
    if (error.code !== "ENOENT") loadError = true;
  }
  const save = () => writeJsonFile(journal, { version: 1, entries: [...entries.values()] });
  const active = (row) => ["pending", "unknown", "appended", "playing"].includes(row.phase);
  function observation() {
    const state = bridge?.status();
    const snapshot = state?.snapshot;
    if (!state?.fresh || !snapshot?.current) return null;
    const selected = snapshot.queue.filter((row) => row.selected);
    const uid =
      selected.length === 1 && selected[0].videoId === snapshot.current.videoId
        ? selected[0].occurrenceId
        : "";
    return { snapshot, uid, documentId: snapshot.native?.documentId || "", state };
  }
  function update() {
    const observed = observation();
    if (!observed) return;
    observedAvailable = true;
    let changed = false;
    for (const row of entries.values()) {
      if (!["appended", "playing"].includes(row.phase)) continue;
      if (row.documentId !== observed.documentId) {
        row.phase = "unknown";
        changed = true;
        continue;
      }
      const playing = row.uid === observed.uid && row.trackId === observed.snapshot.current.videoId;
      const position = observed.snapshot.queue.findIndex((item) => item.occurrenceId === row.uid);
      const currentPosition = observed.snapshot.queue.findIndex((item) => item.selected);
      if (
        !row.started &&
        observed.snapshot.queueComplete &&
        (position < 0 || position < currentPosition)
      ) {
        row.phase = "unknown";
        changed = true;
        continue;
      }
      if (playing && !observed.snapshot.paused && !observed.snapshot.ad && !row.started) {
        row.phase = "playing";
        row.started = true;
        changed = true;
      } else if (!playing && row.started) {
        row.phase = "completed";
        changed = true;
      }
    }
    if (changed) save();
    if (Date.now() - lastObservation < 2000) return;
    lastObservation = Date.now();
    const snapshot = observed.snapshot;
    options.onSnapshot?.({
      provider: "youtube",
      sourceId: "ravelink-browser",
      available: true,
      title: snapshot.current.title || "YouTube Music",
      artists: snapshot.current.artist ? [snapshot.current.artist] : [],
      positionMs: Math.round(snapshot.position * 1000),
      durationMs: Math.round(snapshot.duration * 1000),
      status: snapshot.paused || snapshot.ad ? "paused" : "playing",
      observedAt: Date.now(),
    });
    options.onQueueChanged?.();
  }
  function status() {
    const observed = observation(),
      snapshot = observed?.snapshot;
    const row =
      observed &&
      [...entries.values()].find(
        (item) =>
          item.documentId === observed.documentId &&
          item.uid === observed.uid &&
          item.trackId === snapshot.current.videoId,
      );
    const upcoming = [...entries.values()].filter(
      (item) => active(item) && item.uid !== observed?.uid,
    ).length;
    return {
      ok: true,
      ...(loadError ? { ok: false, error: "youtube_browser_journal_unavailable" } : {}),
      enabled: Boolean(bridge),
      paired: bridge?.status().paired || false,
      connected: Boolean(observed),
      ready: Boolean(
        observed?.state.capabilities.append && observed.snapshot.native.requestInsertion,
      ),
      port: connection ? Number(new URL(connection.base).port) : null,
      capacity: { limit: 10, available: Math.max(0, 10 - upcoming) },
      queueOrder: (snapshot?.queue || [])
        .filter(
          (item, index, rows) => !item.selected && index > rows.findIndex((row) => row.selected),
        )
        .map(
          (item) =>
            [...entries.values()].find(
              (entry) =>
                entry.uid === item.occurrenceId &&
                entry.documentId === observed.documentId &&
                ["appended", "playing"].includes(entry.phase),
            )?.entryId,
        )
        .filter(Boolean),
      current: snapshot
        ? {
            uid: observed.uid,
            entryId: row?.entryId || "",
            trackId: snapshot.current.videoId,
            title: snapshot.current.title,
            artists: snapshot.current.artist ? [snapshot.current.artist] : [],
            positionMs: Math.round(snapshot.position * 1000),
            durationMs: Math.round(snapshot.duration * 1000),
            paused: snapshot.paused || snapshot.ad,
            ad: snapshot.ad,
          }
        : null,
      handoffs: [...entries.values()]
        .filter(active)
        .concat([...entries.values()].filter((item) => !active(item)).slice(-14))
        .slice(0, 25)
        .map((item) => ({ ...item })),
      compatibility: observed?.snapshot.native?.compatibility || null,
    };
  }
  async function command(payload) {
    if (!connection || stopping) return { ok: false, error: "youtube_browser_unavailable" };
    const response = await fetch(connection.base + "/api/queue", {
      method: "POST",
      headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    try {
      return await response.json();
    } catch {
      return { ok: false, error: "control_unconfirmed" };
    }
  }
  async function setup(input = {}) {
    if (input.action === "open-folder") {
      if (process.platform !== "win32")
        return { ok: false, error: "Open the extension folder shown under Advanced." };
      const folders = require("../../scripts/build-youtube-browser").build(
        path.join(options.runtimeDir, "youtube-browser", "extensions"),
      );
      const folder = folders[input.browser === "chromium" ? 1 : 0];
      await new Promise((resolve, reject) => {
        const child = require("node:child_process").spawn("explorer.exe", [folder], {
          windowsHide: true,
          shell: false,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
      return { ok: true };
    }
    if (input.action === "stop") {
      clearInterval(watchdog);
      watchdog = null;
      await bridge?.close();
      bridge = null;
      connection = null;
      for (const row of entries.values()) if (active(row)) row.phase = "unknown";
      save();
      options.onSnapshot?.({ provider: "youtube", sourceId: "ravelink-browser", available: false });
      return status();
    }
    if (input.action !== "start") return { ok: false, error: "youtube_browser_action_invalid" };
    if (!connecting && !bridge)
      connecting = (async () => {
        const instance = (options.createBridge || createBridge)({ onSnapshot: update });
        try {
          const value = await instance.listen(input.port ?? 5051);
          bridge = instance;
          connection = value;
          if (stopping) {
            await instance.close();
            bridge = null;
            connection = null;
            return;
          }
          watchdog = setInterval(() => {
            if (!observation() && observedAvailable) {
              observedAvailable = false;
              options.onSnapshot?.({
                provider: "youtube",
                sourceId: "ravelink-browser",
                available: false,
              });
            }
          }, 3000);
          watchdog.unref?.();
        } catch {
          await instance.close();
          throw Error("youtube_browser_port_unavailable");
        }
      })().finally(() => {
        connecting = null;
      });
    try {
      await connecting;
    } catch {
      return { ok: false, error: "youtube_browser_port_unavailable" };
    }
    if (!connection || stopping) return { ok: false, error: "youtube_browser_unavailable" };
    const folders =
      options.buildExtensions === false
        ? []
        : require("../../scripts/build-youtube-browser").build(
            path.join(options.runtimeDir, "youtube-browser", "extensions"),
          );
    return {
      ...status(),
      pairingCode: connection.token,
      pairingUrl: `${connection.base}/connect.html#${connection.token}`,
      extensionFolders: folders,
    };
  }
  async function enqueue(input) {
    const trackId = input?.candidate?.providerItemId;
    if (
      typeof input?.entryId !== "string" ||
      input.entryId.length > 160 ||
      !/^[A-Za-z0-9_-]{11}$/.test(trackId || "")
    )
      return { ok: false, error: "youtube_browser_entry_invalid" };
    const previous = entries.get(input.entryId);
    if (previous)
      return previous.trackId !== trackId
        ? { ok: false, error: "youtube_browser_id_conflict" }
        : {
            ok: !["pending", "unknown"].includes(previous.phase),
            appended: ["appended", "playing", "completed"].includes(previous.phase),
            error: "youtube_browser_delivery_review_required",
          };
    const observed = observation();
    if (!status().ready || !observed || status().capacity.available < 1)
      return { ok: false, error: "youtube_browser_not_ready" };
    if (entries.size >= 512) {
      for (const [id, row] of entries)
        if (!active(row)) {
          entries.delete(id);
          break;
        }
      if (entries.size >= 512) return { ok: false, error: "youtube_browser_journal_full" };
    }
    const row = {
      entryId: input.entryId,
      trackId,
      phase: "pending",
      documentId: observed.documentId,
      uid: "",
      started: false,
      requesterKey: input.requesterKey || "",
      requesterLabel: input.requesterLabel || "",
      requesterRole: input.requesterRole || "viewer",
      title: String(input.candidate.title || "").slice(0, 200),
      artists: (input.candidate.artists || [])
        .slice(0, 3)
        .map((value) => String(value).slice(0, 80)),
    };
    entries.set(row.entryId, row);
    save();
    const ownedUpcoming = observed.snapshot.queue.filter(
      (item) =>
        !item.selected &&
        [...entries.values()].some(
          (entry) =>
            entry.uid === item.occurrenceId &&
            entry.documentId === row.documentId &&
            ["appended", "playing"].includes(entry.phase),
        ),
    );
    const afterOccurrenceId = ownedUpcoming.at(-1)?.occurrenceId || observed.uid;
    if (!afterOccurrenceId) {
      row.phase = "unknown";
      save();
      return { ok: false, error: "youtube_browser_queue_identity_unavailable" };
    }
    let result;
    try {
      result = await command({
        id: crypto.randomUUID(),
        action: "append",
        expectedVideoId: observed.snapshot.current.videoId,
        nativeDocumentId: row.documentId,
        videoId: trackId,
        afterOccurrenceId,
      });
    } catch {
      result = { ok: false };
    }
    const confirmed = observation();
    const index =
      observed.snapshot.queue.findIndex((item) => item.occurrenceId === afterOccurrenceId) + 1;
    const after = confirmed?.snapshot.queue || [];
    const identity = (item) => `${item.occurrenceId}:${item.videoId}`;
    const exactInsertion =
      confirmed?.documentId === row.documentId &&
      after.length === observed.snapshot.queue.length + 1 &&
      after[index]?.occurrenceId === result.occurrenceId &&
      after[index]?.videoId === trackId &&
      JSON.stringify(after.filter((_item, position) => position !== index).map(identity)) ===
        JSON.stringify(observed.snapshot.queue.map(identity));
    if (
      result.ok &&
      result.occurrenceId &&
      result.nativeDocumentId === row.documentId &&
      result.videoId === trackId &&
      exactInsertion
    ) {
      row.phase = "appended";
      row.uid = result.occurrenceId;
      save();
      return { ok: true, appended: true, entryId: row.entryId, uid: row.uid };
    }
    row.phase = "unknown";
    save();
    return { ok: false, error: "youtube_browser_delivery_review_required" };
  }
  async function control(input) {
    const observed = observation();
    if (!observed || !["pause", "resume", "skip", "volume"].includes(input.action))
      return { ok: false, error: "youtube_browser_control_unavailable" };
    if (input.currentUid && input.currentUid !== observed.uid)
      return { ok: false, error: "youtube_browser_current_changed" };
    return command({
      id: crypto.randomUUID(),
      action: input.action,
      value: input.value,
      expectedVideoId: observed.snapshot.current.videoId,
    });
  }
  async function remove(input) {
    const rows = [...entries.values()].filter(
      (row) =>
        active(row) &&
        (input.entryId
          ? row.entryId === input.entryId
          : input.trackId
            ? row.trackId === input.trackId
            : input.requesterKey
              ? row.requesterKey === input.requesterKey
              : input.currentUid
                ? row.uid === input.currentUid
                : false),
    );
    let removed = 0;
    const removedEntryIds = [];
    for (const row of rows) {
      const observed = observation();
      if (
        !observed ||
        row.phase === "unknown" ||
        row.documentId !== observed.documentId ||
        !row.uid
      )
        return { ok: false, removed, error: "youtube_browser_removal_review_required" };
      const current = observed.uid === row.uid;
      const result = await command({
        id: crypto.randomUUID(),
        action: current ? "skip" : "remove",
        expectedVideoId: observed.snapshot.current.videoId,
        nativeDocumentId: row.documentId,
        occurrenceId: row.uid,
      });
      if (!result.ok) return { ok: false, removed, error: "youtube_browser_remove_unconfirmed" };
      row.phase = "removed";
      save();
      removed++;
      removedEntryIds.push(row.entryId);
    }
    return { ok: true, removed, removedEntryIds };
  }
  async function handle(method, input = {}) {
    if (loadError) return { ok: false, error: "youtube_browser_journal_unavailable" };
    if (stopping) return { ok: false, error: "youtube_browser_unavailable" };
    if (method === "status") return status();
    if (method === "setup") return setup(input);
    if (method === "resolve") return options.resolve({ ...input, playbackMode: "browser" });
    if (method === "enqueue") return enqueue(input);
    if (method === "remove") return remove(input);
    if (method === "control") return control(input);
    if (method === "review") {
      const row = entries.get(input.entryId);
      if (!row || row.phase !== "unknown" || input.confirmAbsent !== true)
        return { ok: false, error: "youtube_browser_review_required" };
      entries.delete(row.entryId);
      save();
      return { ok: true };
    }
    return { ok: false, error: "youtube_browser_method_invalid" };
  }
  return {
    handle(method, input) {
      const promise = work.then(() => handle(method, input));
      work = promise.catch(() => {});
      return promise;
    },
    async close() {
      stopping = true;
      clearInterval(watchdog);
      watchdog = null;
      await connecting?.catch(() => {});
      await bridge?.close();
      await work;
      bridge = null;
      connection = null;
    },
  };
};
