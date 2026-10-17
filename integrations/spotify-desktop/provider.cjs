/**
 * Provider.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { trackUri } = require("./catalog.cjs");
const {
  confidence,
  derivativeAllowed,
  normalizePolicy,
} = require("../../src/capabilities/feature-platform/providers/youtube-catalog-provider");
module.exports = function createSpotifyProvider(options) {
  const root = path.join(options.runtimeDir, "spotify-desktop");
  fs.mkdirSync(root, { recursive: true });
  const read = (name, fallback) => {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) return fallback;
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1048576)
      throw Error("spotify_state_invalid");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  };
  const write = (name, data) => {
    const file = path.join(root, name),
      temporary = file + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  const pairing = read("pairing.json", {
    token: crypto.randomBytes(32).toString("hex"),
  });
  if (!/^[a-f0-9]{64}$/.test(pairing.token || "")) throw Error("spotify_pairing_invalid");
  write("pairing.json", pairing);
  const saved = read("requests.json", []);
  if (
    !Array.isArray(saved) ||
    saved.length > 250 ||
    saved.some(
      (row) =>
        !/^[A-Za-z0-9_-]{1,100}$/.test(row.entryId || "") ||
        !trackUri(row.uri) ||
        !["pending", "unknown", "appended", "playing", "finished", "failed", "removed"].includes(
          row.phase,
        ),
    )
  )
    throw Error("spotify_state_invalid");
  const receipts = new Map(
    saved.map((row) => [
      row.entryId,
      { ...row, phase: row.phase === "pending" ? "unknown" : row.phase },
    ]),
  );
  const persist = () => {
    for (const [id, row] of receipts) {
      if (receipts.size <= 250) break;
      if (["finished", "failed", "removed"].includes(row.phase)) receipts.delete(id);
    }
    write("requests.json", [...receipts.values()]);
  };
  let snapshot = null,
    observedAt = 0,
    serial = Promise.resolve(),
    installation = read("installation.json", null),
    launchWork = null,
    launchError = "";
  const ordered = (action) => {
    const operation = serial.then(action);
    serial = operation.catch(() => {});
    return operation;
  };
  const bridge = require("./host-bridge.cjs")({
    token: pairing.token,
    onSnapshot: observe,
  });
  function observe(next) {
    snapshot = next;
    observedAt = Date.now();
    let changed = false;
    for (const row of receipts.values()) {
      if (
        !row.uid ||
        !["appended", "playing", "pending", "unknown"].includes(row.phase) ||
        observedAt <= (row.confirmedAt || 0)
      )
        continue;
      const phase =
        next.current?.uid === row.uid
          ? "playing"
          : next.queue.some((item) => item.uid === row.uid)
            ? "appended"
            : next.complete && ["appended", "playing"].includes(row.phase)
              ? "finished"
              : row.phase;
      if (phase !== row.phase) {
        row.phase = phase;
        changed = true;
      }
    }
    if (changed) persist();
    options.onSnapshot?.(next);
    options.onQueueChanged?.();
  }
  function status() {
    const connection = bridge.status(),
      fresh = connection.connected && Date.now() - observedAt < 6000;
    const currentOwner = [...receipts.values()].find(
      (row) => row.uid && row.uid === snapshot?.current?.uid,
    );
    const active = [...receipts.values()].filter((row) =>
      ["pending", "unknown", "appended"].includes(row.phase),
    );
    return {
      ok: true,
      enabled: true,
      launching: Boolean(launchWork) && !connection.connected,
      launchError: connection.connected ? "" : launchError,
      lastError: connection.lastError,
      lastSeenAt: connection.lastSeenAt,
      connected: connection.connected,
      ready: Boolean(fresh && snapshot?.localDevice && snapshot.complete),
      deviceId: fresh ? snapshot?.deviceId || "" : "",
      localDevice: fresh && snapshot?.localDevice === true,
      controlsAvailable: Boolean(fresh && snapshot?.localDevice),
      capacity: {
        limit: 10,
        queued: active.length,
        available: Math.max(0, 10 - active.length),
        reported: Boolean(fresh && snapshot?.complete),
      },
      current:
        fresh && snapshot.current
          ? {
              ...snapshot.current,
              trackId: snapshot.current.uri.slice(14),
              ...(currentOwner || {}),
            }
          : null,
      handoffs: [...receipts.values()].slice(-50).map((row) => ({
        ...row,
        possibleMatches:
          row.phase === "unknown"
            ? (snapshot?.queue || [])
                .filter((item) => item.uri === row.uri)
                .map((item) => ({ uid: item.uid }))
            : [],
      })),
      installation: installation ? { prepared: true, id: installation.id } : { prepared: false },
    };
  }
  async function setup(payload) {
    if (payload.action === "status")
      return {
        ok: true,
        ...status().installation,
        available: (options.discover || require("./discovery.cjs"))().length > 0,
      };
    if (payload.action === "prepare") {
      const location = (options.discover || require("./discovery.cjs"))()[0];
      if (!location) return { ok: false, error: "spotify_not_installed" };
      const connection = { coreUrl: payload.coreUrl, token: pairing.token };
      const plan = await require("./installer.cjs").plan(location.appsPath, {
        allowProtectedRead: true,
        connection,
      });
      installation = await require("./sidecar.cjs").stage(location.appsPath, root, {
        allowUnverifiedBuild: true,
        connection,
        expectedArchiveHash: plan.archiveHash,
        expectedSnapshotHash: plan.snapshotHash,
      });
      write("installation.json", { id: installation.id });
      return { ok: true, prepared: true };
    }
    if (payload.action === "launch") {
      if (!installation?.id) return { ok: false, error: "spotify_setup_required" };
      if (bridge.status().connected) return { ok: true, connected: true };
      if (!launchWork) {
        launchError = "";
        // Starting a desktop process is independent of the feature RPC lifetime.
        // Report acceptance now; the paired bridge confirms the connection.
        launchWork = Promise.resolve()
          .then(() => (options.launch || require("./launcher.cjs"))(root, installation.id))
          .then((result) => {
            if (!result.ok) launchError = result.error || "spotify_launch_failed";
          })
          .catch((error) => {
            launchError = /^spotify_[a-z_]+$/.test(error.message)
              ? error.message
              : "spotify_launch_failed";
          })
          .finally(() => {
            launchWork = null;
          });
      }
      return { ok: true, launching: true };
    }
    return { ok: false, error: "spotify_setup_action_invalid" };
  }
  async function resolve(payload) {
    const query = String(payload.query || "").trim();
    if (!query || query.length > 300) return { ok: false, error: "spotify_search_query_invalid" };
    const uri = trackUri(query);
    const result = await bridge.invoke(
      uri ? "lookup" : "search",
      uri ? { uri } : { query },
      crypto.randomUUID(),
    );
    if (!result.ok) return result;
    const policy = normalizePolicy(payload.policy || {});
    const candidates = result.candidates
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
    const candidate = candidates[0];
    return candidate && candidate.confidence >= (policy.minimumConfidence || 0.45)
      ? { ok: true, candidate }
      : { ok: false, error: "spotify_match_not_found" };
  }
  function enqueue(payload) {
    return ordered(async () => {
      const old = receipts.get(payload.entryId);
      if (old)
        return old.phase === "appended" || old.phase === "playing" || old.phase === "finished"
          ? { ok: true, appended: true, uid: old.uid }
          : { ok: false, error: "spotify_delivery_needs_review" };
      const uri = trackUri(payload.candidate?.providerItemId);
      if (!uri || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.entryId || ""))
        return { ok: false, error: "spotify_track_invalid" };
      if (!status().ready) return { ok: false, error: "spotify_local_device_unverified" };
      if (status().capacity.available < 1) return { ok: false, error: "spotify_native_queue_full" };
      if (
        receipts.size >= 250 &&
        ![...receipts.values()].some((row) => ["finished", "failed", "removed"].includes(row.phase))
      )
        return { ok: false, error: "spotify_history_full" };
      const row = {
        entryId: payload.entryId,
        createdAt: Date.now(),
        uri,
        uid: crypto.randomBytes(16).toString("hex"),
        commandId: crypto.randomUUID(),
        trackId: uri.slice(14),
        candidate: payload.candidate,
        requesterKey: String(payload.requesterKey || "").slice(0, 80),
        requesterLabel: String(payload.requesterLabel || "").slice(0, 100),
        requesterRole: payload.requesterRole,
        phase: "pending",
      };
      receipts.set(row.entryId, row);
      persist();
      const result = await bridge.invoke("append", { uri, uid: row.uid }, row.commandId);
      if (["appended", "playing"].includes(row.phase) && !result.ok)
        return { ok: true, appended: true, uid: row.uid };
      row.phase = result.ok
        ? "appended"
        : result.error === "spotify_delivery_unconfirmed"
          ? "unknown"
          : "failed";
      row.lastError = result.error || "";
      if (result.ok) {
        row.uid = result.uid;
        row.confirmedAt = Date.now();
      }
      persist();
      return result.ok ? { ...result, appended: true } : result;
    });
  }
  function remove(payload) {
    return ordered(async () => {
      const matches = [...receipts.values()].filter(
        (row) =>
          ["appended", "playing"].includes(row.phase) &&
          (payload.entryId
            ? row.entryId === payload.entryId
            : payload.trackId
              ? row.trackId === payload.trackId
              : payload.requesterKey && row.requesterKey === payload.requesterKey),
      );
      let removed = 0;
      for (const row of matches) {
        const current = status().current;
        const result =
          current?.uid === row.uid
            ? await bridge.invoke(
                "control",
                { action: "skip", currentUid: row.uid },
                crypto.randomUUID(),
              )
            : await bridge.invoke("remove", { uri: row.uri, uid: row.uid }, crypto.randomUUID());
        if (!result.ok) return { ...result, removed };
        row.phase = "removed";
        removed++;
        persist();
      }
      if (payload.currentUid && !matches.some((row) => row.uid === payload.currentUid)) {
        if (status().current?.uid !== payload.currentUid)
          return { ok: false, error: "spotify_current_changed" };
        const result = await bridge.invoke(
          "control",
          { action: "skip", currentUid: payload.currentUid },
          crypto.randomUUID(),
        );
        if (!result.ok) return result;
        removed++;
      }
      return { ok: true, removed };
    });
  }
  function review(payload) {
    const row = receipts.get(payload.entryId);
    if (
      !row ||
      !["unknown", "failed"].includes(row.phase) ||
      !status().ready ||
      Date.now() - (row.createdAt || 0) < 10000
    )
      return { ok: false, error: "spotify_review_unavailable" };
    const matches = [...snapshot.queue, ...(snapshot.current ? [snapshot.current] : [])].filter(
      (item) => item.uri === row.uri,
    );
    if (payload.decision === "adopt") {
      const selected = matches.find((item) => item.uid === payload.uid);
      if (!selected) return { ok: false, error: "spotify_current_changed" };
      row.uid = selected.uid;
      row.phase = snapshot.current?.uid === selected.uid ? "playing" : "appended";
      row.lastError = "";
      row.confirmedAt = Date.now();
    } else if (payload.decision === "absent" && !matches.length) receipts.delete(row.entryId);
    else return { ok: false, error: "spotify_review_unavailable" };
    persist();
    return { ok: true };
  }
  async function handle(method, payload = {}) {
    try {
      if (method === "status") return status();
      if (method === "setup") return await setup(payload);
      if (method === "playlist")
        return bridge.invoke(
          "playlist",
          payload,
          ["create", "append"].includes(payload.action) ? payload.key : crypto.randomUUID(),
        );
      if (method === "resolve") return await resolve(payload);
      if (method === "enqueue") return await enqueue(payload);
      if (method === "remove") return await remove(payload);
      if (method === "control") return bridge.invoke("control", payload, crypto.randomUUID());
      if (method === "review") return review(payload);
      return { ok: false, error: "spotify_method_invalid" };
    } catch (error) {
      return {
        ok: false,
        error: /^spotify_[a-z_]+$/.test(error.message) ? error.message : "spotify_operation_failed",
      };
    }
  }
  return { handle, status, router: bridge.router, close: bridge.close };
};
