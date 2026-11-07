/**
 * Experimental YouTube Music browser bridge, deliberately separate from Core.
 * The extension owns one explicitly selected tab. The host leases each command
 * once: losing its acknowledgement means an unknown outcome, never a safe replay.
 * Browser/bridge restarts require pairing again; a page refresh keeps ownership.
 * No credentials or journal are written to disk by this host. This prototype
 * does not admit or deliver Song Requests.
 */
const crypto = require("node:crypto");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const path = require("node:path");
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const text = (value, limit = 180) =>
  typeof value === "string"
    ? value
        .normalize("NFKC")
        .replace(/[<>\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, limit)
    : "";
function track(value) {
  if (!value || typeof value.videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(value.videoId))
    return null;
  return { videoId: value.videoId, title: text(value.title), artist: text(value.artist) };
}
function snapshot(value) {
  const current = track(value?.current);
  return {
    current,
    paused: value?.paused !== false,
    position: Number.isFinite(value?.position) ? Math.max(0, Math.min(86400, value.position)) : 0,
    duration: Number.isFinite(value?.duration) ? Math.max(0, Math.min(86400, value.duration)) : 0,
    volume: Number.isInteger(value?.volume) ? Math.max(0, Math.min(100, value.volume)) : 0,
    ad: value?.ad === true,
    controls: Boolean(current && value?.mediaReady === true),
    nextAvailable: value?.nextAvailable === true,
    // Rendered rows can be virtualized or omit occurrence IDs. Never advertise
    // this as the entire queue or use these indices for automated removal.
    queue: Array.isArray(value?.queue)
      ? value.queue
          .slice(0, 100)
          .map((row) => {
            const identified = track(row);
            if (identified)
              return {
                ...identified,
                identityAvailable: true,
                occurrenceId: text(row.occurrenceId, 128),
                identityKind:
                  row.identityKind === "native"
                    ? "native"
                    : row.identityKind === "object"
                      ? "object"
                      : "unknown",
                selected: row.selected === true,
              };
            const title = text(row?.title);
            return title
              ? { videoId: null, title, artist: text(row.artist), identityAvailable: false }
              : null;
          })
          .filter(Boolean)
      : [],
    queueComplete: value?.native?.queueRead === true && value?.queueComplete === true,
    native:
      value?.native?.available === true
        ? {
            available: true,
            documentId: text(value.native.documentId, 80),
            queueRead: value.native.queueRead === true,
            queueWrite: value.native.queueWrite === true,
            requestInsertion: value.native.requestInsertion === true,
            network: value.native.network === true,
            player: value.native.player === true,
            allIdentified: value.native.allIdentified === true,
            queueSize: Number.isInteger(value.native.queueSize)
              ? Math.min(10000, Math.max(0, value.native.queueSize))
              : 0,
            ownedCount: Number.isInteger(value.native.ownedCount)
              ? Math.min(512, Math.max(0, value.native.ownedCount))
              : 0,
            compatibility: {
              contract:
                value.native.compatibility?.contract === "ytmusic-services-v1"
                  ? "ytmusic-services-v1"
                  : "unknown",
              queueReady: value.native.compatibility?.queueReady === true,
              blocked: value.native.compatibility?.blocked === true,
              reasons: Array.isArray(value.native.compatibility?.reasons)
                ? [...new Set(value.native.compatibility.reasons)]
                    .filter((reason) =>
                      [
                        "queue_read_failed",
                        "queue_items_unavailable",
                        "queue_state_unavailable",
                        "queue_dispatch_unavailable",
                        "queue_state_mismatch",
                        "queue_selection_unavailable",
                        "shuffle_not_supported",
                        "queue_counter_unavailable",
                        "queue_response_changed",
                        "queue_write_unconfirmed",
                      ].includes(reason),
                    )
                    .slice(0, 10)
                : [],
            },
          }
        : null,
  };
}
module.exports = function createBrowserBridge(options = {}) {
  const token = options.token || crypto.randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("invalid_pairing_code");
  const app = express(),
    jobs = new Map(),
    owned = new Map();
  const now = options.now || Date.now;
  let owner = "",
    sessionId = crypto.randomUUID(),
    seen = 0,
    observed = null,
    listener,
    base;
  const settle = (job, result) => {
    if (job.result) return;
    clearTimeout(job.timer);
    job.result = result;
    job.resolve(result);
  };
  function status() {
    const age = owner && observed ? Math.max(0, now() - seen) : null;
    return {
      prototype: true,
      protocolVersion: 1,
      paired: Boolean(owner),
      connected: age !== null && age < 45000,
      fresh: age !== null && age < 15000,
      ageMs: age,
      snapshot: observed,
      lastCommand: [...jobs.values()].at(-1)?.result || null,
      capabilities: {
        automaticRequests: false,
        append: Boolean(
          age !== null &&
          age < 15000 &&
          observed?.controls &&
          !observed.ad &&
          observed?.native?.allIdentified &&
          observed.native.queueWrite &&
          observed.native.network &&
          observed.native.queueSize < 100,
        ),
        remove: Boolean(
          age !== null &&
          age < 15000 &&
          observed?.controls &&
          !observed.ad &&
          observed?.native?.allIdentified &&
          observed.native.queueWrite &&
          observed.native.queueSize <= 100,
        ),
        playlists: false,
      },
    };
  }
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(base).host) return res.sendStatus(403);
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    const origin = req.headers.origin;
    if (origin && origin !== base && !/^(?:chrome|moz)-extension:\/\/[a-zA-Z0-9-]+$/.test(origin))
      return res.sendStatus(403);
    if (origin) res.set({ "Access-Control-Allow-Origin": origin, Vary: "Origin" });
    if (req.method === "OPTIONS") {
      res.set({
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST",
      });
      return res.sendStatus(204);
    }
    next();
  });
  app.use(
    "/api",
    rateLimit({ windowMs: 60000, limit: 240, standardHeaders: true, legacyHeaders: false }),
  );
  app.use(
    "/api",
    (req, res, next) => {
      const supplied = Buffer.from(String(req.headers.authorization || ""));
      const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected))
        return res.sendStatus(401);
      next();
    },
    // A bounded 100-row queue with 180-character non-ASCII titles/artists can
    // exceed 32 KiB in UTF-8. Allow its worst-case envelope, still bounded.
    express.json({ limit: "128kb", strict: true }),
  );
  app.get("/api/status", (_req, res) => res.json(status()));
  // Only the popup's explicit handshake can acquire ownership. In particular,
  // a delayed poll from a disconnected tab must never pair itself again.
  app.post("/api/pair", (req, res) => {
    const clientId = req.body?.clientId;
    if (typeof clientId !== "string" || !ID.test(clientId)) return res.sendStatus(400);
    if (owner) return res.status(409).json({ error: "another_tab_owns_connection" });
    owner = clientId;
    sessionId = crypto.randomUUID();
    observed = null;
    seen = 0;
    res.json({ ok: true, sessionId });
  });
  app.post("/api/disconnect", (req, res) => {
    if (!owner || req.body?.clientId !== owner) return res.sendStatus(409);
    for (const job of jobs.values())
      settle(job, {
        ok: false,
        error: job.issued ? "control_unconfirmed" : "command_expired",
      });
    owner = "";
    observed = null;
    seen = 0;
    res.json({ ok: true });
  });
  app.post("/api/exchange", (req, res) => {
    const body = req.body;
    if (!ID.test(body?.clientId || "") || !body.snapshot || typeof body.snapshot !== "object")
      return res.sendStatus(400);
    if (!owner || owner !== body.clientId)
      return res.status(409).json({ error: "another_tab_owns_connection" });
    seen = now();
    observed = snapshot(body.snapshot);
    const result = body.result;
    let ack = null;
    if (result) {
      const job = jobs.get(result.id);
      if (job?.issued && result.sessionId === job.sessionId && job.owner === body.clientId) {
        const errors = [
          "player_changed",
          "player_unavailable",
          "autoplay_blocked",
          "control_unconfirmed",
          "unsupported_control",
          "native_unavailable",
          "native_queue_unavailable",
          "native_entry_not_owned",
          "native_session_full",
          "native_id_conflict",
          "native_schema_changed",
        ];
        let accepted =
          result.ok === true
            ? { ok: true }
            : {
                ok: false,
                error: errors.includes(result.error) ? result.error : "control_unconfirmed",
              };
        if (accepted.ok && job.payload.action === "append") {
          const occurrenceId =
            typeof result.occurrenceId === "string" &&
            /^[A-Za-z0-9_:.-]{1,128}$/.test(result.occurrenceId)
              ? result.occurrenceId
              : "";
          if (
            !occurrenceId ||
            result.videoId !== job.payload.videoId ||
            result.nativeDocumentId !== job.payload.nativeDocumentId
          )
            accepted = { ok: false, error: "control_unconfirmed" };
          else {
            accepted = {
              ok: true,
              occurrenceId,
              videoId: result.videoId,
              nativeDocumentId: result.nativeDocumentId,
            };
            // A late acknowledgement may release the peer, but cannot turn a
            // previously uncertain host result into confirmed queue ownership.
            if (!job.result)
              owned.set(`${result.nativeDocumentId}:${occurrenceId}`, result.videoId);
          }
        }
        if (accepted.ok && job.payload.action === "remove")
          owned.delete(`${job.payload.nativeDocumentId}:${job.payload.occurrenceId}`);
        settle(job, accepted);
        ack = job.id;
      }
    }
    const pending = [...jobs.values()].find((job) => !job.result);
    let command = null;
    if (pending && !pending.issued) {
      pending.issued = true;
      command = {
        id: pending.id,
        sessionId: pending.sessionId,
        deadlineAt: pending.deadlineAt,
        ...pending.payload,
      };
    }
    try {
      options.onSnapshot?.(observed);
    } catch {}
    res.json({ sessionId, ack, command });
  });
  app.post(["/api/control", "/api/queue"], async (req, res) => {
    const {
      id,
      action,
      value,
      expectedVideoId,
      nativeDocumentId,
      videoId,
      occurrenceId,
      afterOccurrenceId,
    } = req.body || {};
    const queueWrite = ["append", "remove"].includes(action);
    if (
      !ID.test(id || "") ||
      !["pause", "resume", "skip", "volume", "append", "remove"].includes(action) ||
      (queueWrite &&
        (typeof nativeDocumentId !== "string" || !/^[a-f0-9-]{36}$/.test(nativeDocumentId))) ||
      (action === "append" &&
        (typeof videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(videoId))) ||
      (action === "remove" &&
        (typeof occurrenceId !== "string" || !/^[A-Za-z0-9_:.-]{1,128}$/.test(occurrenceId))) ||
      (afterOccurrenceId !== undefined &&
        (action !== "append" ||
          typeof afterOccurrenceId !== "string" ||
          !/^[A-Za-z0-9_:.-]{1,128}$/.test(afterOccurrenceId))) ||
      (action === "volume" && (!Number.isInteger(value) || value < 0 || value > 100))
    )
      return res.sendStatus(400);
    const payload = {
      action,
      ...(action === "volume" ? { value } : {}),
      expectedVideoId,
      ...(queueWrite ? { nativeDocumentId } : {}),
      ...(action === "append" ? { videoId } : {}),
      ...(afterOccurrenceId ? { afterOccurrenceId } : {}),
      ...(action === "remove" ? { occurrenceId } : {}),
    };
    const signature = JSON.stringify(payload),
      previous = jobs.get(id);
    if (previous) {
      if (previous.signature !== signature) return res.sendStatus(409);
      return res.json(await previous.promise);
    }
    if (!status().fresh || !observed?.controls)
      return res.status(409).json({ ok: false, error: "player_unavailable" });
    if (!expectedVideoId || expectedVideoId !== observed.current.videoId)
      return res.status(409).json({ ok: false, error: "player_changed" });
    if (observed.ad || (action === "skip" && !observed.nextAvailable))
      return res.status(409).json({ ok: false, error: "unsupported_control" });
    if (
      queueWrite &&
      (!observed.native?.allIdentified ||
        !observed.native.queueWrite ||
        nativeDocumentId !== observed.native.documentId ||
        (action === "append" && !observed.native.network))
    )
      return res.status(409).json({ ok: false, error: "native_queue_unavailable" });
    if (action === "remove" && !owned.has(`${nativeDocumentId}:${occurrenceId}`))
      return res.status(409).json({ ok: false, error: "native_entry_not_owned" });
    if (
      afterOccurrenceId &&
      !observed.queue.some(
        (row) =>
          row.occurrenceId === afterOccurrenceId &&
          (row.selected || owned.has(`${nativeDocumentId}:${afterOccurrenceId}`)),
      )
    )
      return res.status(409).json({ ok: false, error: "native_entry_not_owned" });
    if ([...jobs.values()].some((job) => !job.result)) return res.sendStatus(409);
    // Bound the ledger without evicting completed IDs: an old retry must not
    // become a new playback action. Restart/re-pair when this proof ledger fills.
    if (jobs.size >= 512)
      return res.status(409).json({ ok: false, error: "prototype_session_full" });
    const job = {
      id,
      payload,
      signature,
      issued: false,
      owner,
      sessionId,
      deadlineAt: Date.now() + (options.timeoutMs || 8000),
    };
    job.promise = new Promise((resolve) => {
      job.resolve = resolve;
    });
    job.timer = setTimeout(
      () =>
        settle(job, {
          ok: false,
          error: job.issued ? "control_unconfirmed" : "command_expired",
        }),
      options.timeoutMs || 8000,
    );
    jobs.set(id, job);
    res.json(await job.promise);
  });
  // Keep public console reads separate from authenticated observation/control
  // traffic. One loopback-only console needs no unbounded per-client key map.
  const assets = rateLimit({
    windowMs: 60000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: () => "browser-console-assets",
  });
  app.get("/browser-random-id.js", assets, (_req, res) =>
    res
      .set("Cache-Control", "public, max-age=300")
      .sendFile(path.resolve(__dirname, "../../public/core/browser-random-id.js")),
  );
  app.use(
    assets,
    express.static(path.join(__dirname, "dashboard"), {
      setHeaders: (res, file) => {
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
        if (/\.(?:js|css)$/i.test(file)) res.setHeader("Cache-Control", "public, max-age=300");
      },
    }),
  );
  app.use((_error, _req, res, _next) => res.status(400).json({ error: "invalid_request" }));
  return {
    status,
    async listen(port = 5051) {
      listener = await new Promise((resolve, reject) => {
        const server = app.listen(port, "127.0.0.1", () => resolve(server));
        server.once("error", reject);
      });
      base = `http://127.0.0.1:${listener.address().port}`;
      return { base, token };
    },
    async close() {
      for (const job of jobs.values()) settle(job, { ok: false, error: "bridge_closed" });
      if (listener)
        await new Promise((resolve) => {
          listener.close(resolve);
          listener.closeAllConnections();
        });
    },
  };
};
