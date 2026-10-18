/**
 * Experimental tidal bridge.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#startup-and-shutdown
 */
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { confidence, derivativeAllowed, normalizePolicy } = require("./youtube-catalog-provider");
const { readJsonFileWithMetadata, writeJsonFile } = require("../../../shared/fs/json-file-store");

const fail = (error) => ({ ok: false, error });
function trackId(value) {
  const input = String(value || "").trim();
  if (/^[1-9][0-9]{0,19}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      !["tidal.com", "www.tidal.com", "listen.tidal.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      return "";
    return /^\/(?:browse\/)?track\/([1-9][0-9]{0,19})\/?$/.exec(url.pathname)?.[1] || "";
  } catch {
    return "";
  }
}
function candidateFrom(value, id) {
  if (
    !id ||
    !value ||
    value.provider !== "tidal" ||
    value.providerItemId !== id ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 200 ||
    !Number.isInteger(value.durationMs) ||
    value.durationMs < 1 ||
    value.durationMs > 86400000 ||
    !Array.isArray(value.artists) ||
    value.artists.length > 8 ||
    value.artists.some((item) => typeof item !== "string" || item.length > 100)
  )
    return null;
  return {
    provider: "tidal",
    providerItemId: id,
    title: value.title,
    artists: value.artists,
    durationMs: value.durationMs,
    album: String(value.album || "").slice(0, 200),
  };
}
module.exports = function createExperimentalTidalBridge(options) {
  const now = options.now || Date.now;
  const searches = [],
    resolving = new Map();
  const token = crypto.randomBytes(32).toString("hex");
  const sessionId = crypto.randomUUID();
  const journalPath = path.join(options.runtimeDir, "experimental-tidal-handoffs.json");
  const pairingPath = path.join(options.runtimeDir, "experimental-tidal-pairing.json");
  for (const filename of [journalPath, `${journalPath}.bak`])
    if (fs.existsSync(filename) && fs.statSync(filename).size > 1048576)
      throw new Error("tidal_journal_invalid");
  const stored = readJsonFileWithMetadata(journalPath, { entries: [] }).value;
  if (fs.existsSync(journalPath) && readJsonFileWithMetadata(journalPath, null).value === null)
    throw new Error("tidal_journal_invalid");
  if (!Array.isArray(stored?.entries) || stored.entries.length > 250)
    throw new Error("tidal_journal_invalid");
  if (
    stored.entries.some(
      (row) =>
        !row ||
        !/^[A-Za-z0-9_-]{1,160}$/.test(row.entryId || "") ||
        !trackId(row.trackId) ||
        !["pending", "failed", "unknown", "appended", "playing", "finished"].includes(row.phase),
    )
  )
    throw new Error("tidal_journal_invalid");
  const receipts = new Map(
    stored.entries.map((row) => [
      row.entryId,
      { ...row, phase: row.phase === "pending" ? "unknown" : row.phase },
    ]),
  );
  const commands = new Map();
  let companion = "",
    seenAt = 0,
    ready = false,
    queueReady = false,
    moderationReady = false,
    volumeReady = false,
    stopped = false;
  let nativeQueue = null;
  const persist = () =>
    writeJsonFile(journalPath, {
      schemaVersion: 1,
      entries: [...receipts.values()],
    });
  if (receipts.size) persist();
  fs.mkdirSync(options.runtimeDir, { recursive: true });
  writeJsonFile(
    pairingPath,
    { schemaVersion: 1, token, sessionId },
    { mode: 0o600, backup: false },
  );
  function status() {
    const reservations = [...commands.values()].filter(
      (command) => command.kind === "append",
    ).length;
    const active = [...receipts.values()].filter((row) =>
      ["appended", "playing", "unknown", "pending"].includes(row.phase),
    );
    const visible = [
      ...new Map(
        [...active, ...[...receipts.values()].slice(-10)].map((row) => [row.entryId, row]),
      ).values(),
    ].slice(-25);
    const owner = [...receipts.values()].find((row) => row.uid === nativeQueue?.currentUid);
    return {
      ok: true,
      enabled: true,
      experimental: true,
      connected: !stopped && Boolean(companion) && now() - seenAt < 10000,
      ready: ready && queueReady && Boolean(nativeQueue),
      controlsAvailable: moderationReady,
      volumeAvailable: ready && volumeReady,
      current: nativeQueue
        ? {
            uid: nativeQueue.currentUid,
            trackId: nativeQueue.currentTrackId || owner?.trackId || "",
            ...(owner ? { entryId: owner.entryId } : {}),
            ...(owner?.requesterKey
              ? {
                  requesterKey: owner.requesterKey,
                  requesterLabel: owner.requesterLabel || "",
                  requesterRole: owner.requesterRole || "viewer",
                }
              : {}),
          }
        : null,
      capacity: {
        limit: 10,
        queued: nativeQueue?.count ?? 0,
        pending: reservations,
        reported: Boolean(nativeQueue),
        available: nativeQueue ? Math.max(0, 10 - nativeQueue.count - reservations) : 0,
      },
      pending: commands.size,
      reviewCount: [...receipts.values()].filter((row) => row.phase === "unknown").length,
      review: [...receipts.values()]
        .filter((row) => row.phase === "unknown")
        .slice(-10)
        .map((row) => ({ ...row })),
      handoffs: visible.map((row) => ({ ...row })),
      queueOrder: (nativeQueue?.uids || [])
        .map((uid) => active.find((row) => row.uid === uid)?.entryId)
        .filter(Boolean),
      pairingFile: pairingPath,
    };
  }
  function authorized(input) {
    const supplied = Buffer.from(String(input || ""));
    return supplied.length === token.length && crypto.timingSafeEqual(supplied, Buffer.from(token));
  }
  function request(kind, id, entryId = "", candidate = null, automatic = false, requester = {}) {
    if (!status().connected || !ready) return Promise.resolve(fail("tidal_companion_unavailable"));
    if (kind === "append" && !queueReady)
      return Promise.resolve(fail("tidal_initialized_queue_required"));
    if (kind === "append" && !nativeQueue)
      return Promise.resolve(fail("tidal_companion_update_required"));
    if (commands.size >= 8) return Promise.resolve(fail("tidal_bridge_busy"));
    if (kind === "append") {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(entryId))
        return Promise.resolve(fail("tidal_entry_invalid"));
      const previous = receipts.get(entryId);
      if (
        previous?.phase === "failed" &&
        automatic &&
        previous.lastError !== "tidal_native_queue_full"
      )
        return Promise.resolve(fail("tidal_delivery_retry_required"));
      if (previous && previous.phase !== "failed")
        return Promise.resolve(
          ["appended", "playing", "finished"].includes(previous.phase)
            ? { ok: true, appended: true, duplicate: true, uid: previous.uid }
            : fail("tidal_handoff_needs_review"),
        );
      if (status().capacity.available < 1) return Promise.resolve(fail("tidal_native_queue_full"));
      if (!previous && receipts.size >= 250)
        return Promise.resolve(fail("tidal_handoff_history_full"));
      const owner = /^req_[a-f0-9]{64}$/.test(requester.requesterKey || "")
        ? {
            requesterKey: requester.requesterKey,
            requesterLabel: String(requester.requesterLabel || "Twitch user")
              .replace(/[\u0000-\u001f\u007f]/g, " ")
              .slice(0, 80),
            requesterRole: ["viewer", "vip", "moderator"].includes(requester.requesterRole)
              ? requester.requesterRole
              : "viewer",
          }
        : {};
      receipts.set(entryId, {
        entryId,
        trackId: id,
        phase: "pending",
        uid: "",
        title: candidate.title,
        artists: candidate.artists,
        ...owner,
      });
      persist();
    }
    const commandId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => finish(commandId, fail("tidal_companion_timeout")),
        options.timeoutMs || 8000,
      );
      timer.unref?.();
      commands.set(commandId, {
        id: commandId,
        kind,
        trackId: id,
        entryId,
        expiresAt: now() + (options.timeoutMs || 8000),
        delivered: false,
        resolve,
        timer,
      });
    });
  }
  function finish(id, result) {
    const command = commands.get(id);
    if (!command) return fail("tidal_command_stale");
    if (command.kind === "append") {
      const row = receipts.get(command.entryId);
      row.phase =
        result.ok === true && result.appended === true
          ? "appended"
          : result.writeAttempted === false
            ? "failed"
            : "unknown";
      row.lastError = result.ok ? "" : result.error;
      row.uid = row.phase === "appended" ? result.uid : "";
      if (row.phase === "appended" && nativeQueue && !nativeQueue.uids.includes(row.uid)) {
        nativeQueue.count += 1;
        nativeQueue.uids = [...nativeQueue.uids, row.uid].slice(0, 50);
      }
      try {
        persist();
      } catch {
        stopped = true;
        result = fail("tidal_journal_write_failed");
      }
    }
    if (command.kind === "remove" && result.ok) {
      for (const row of receipts.values())
        if (command.targets.some((target) => target.uid === row.uid)) {
          row.phase = "finished";
          row.moderated = true;
        }
      if (nativeQueue) {
        const removed = new Set(command.targets.map((row) => row.uid)),
          before = nativeQueue.uids.length;
        nativeQueue.uids = nativeQueue.uids.filter((uid) => !removed.has(uid));
        nativeQueue.count = Math.max(0, nativeQueue.count - before + nativeQueue.uids.length);
      }
      try {
        persist();
      } catch {
        stopped = true;
        result = fail("tidal_journal_write_failed");
      }
    }
    clearTimeout(command.timer);
    commands.delete(id);
    command.resolve(result);
    return { ok: true };
  }
  function poll(input = {}) {
    if (stopped || !/^[A-Za-z0-9_-]{1,80}$/.test(input.companionId || ""))
      return fail("tidal_companion_invalid");
    if (companion && companion !== input.companionId) {
      if (now() - seenAt < 10000) return fail("tidal_companion_owned");
      for (const command of [...commands.values()])
        finish(command.id, {
          ...fail("tidal_companion_reconnected"),
          ...(!command.delivered ? { writeAttempted: false } : {}),
        });
    }
    companion = input.companionId;
    seenAt = now();
    ready = input.ready === true;
    queueReady = ready && input.queueReady !== false;
    moderationReady = input.moderationReady === true;
    volumeReady = input.volumeReady === true;
    const report = input.queue;
    const validReport =
      report &&
      Number.isInteger(report.count) &&
      report.count >= 0 &&
      report.count <= 1000 &&
      /^[A-Za-z0-9_-]{1,160}$/.test(report.currentUid || "") &&
      Array.isArray(report.uids) &&
      report.uids.length <= 50 &&
      report.uids.every((uid) => /^[A-Za-z0-9_-]{1,160}$/.test(uid)) &&
      report.uids.length <= report.count &&
      (report.currentTrackId === undefined || /^[1-9][0-9]{0,19}$/.test(report.currentTrackId));
    const previousQueue = JSON.stringify(nativeQueue);
    nativeQueue = validReport
      ? {
          count: report.count,
          currentUid: report.currentUid,
          ...(report.currentTrackId ? { currentTrackId: report.currentTrackId } : {}),
          uids: [...report.uids],
        }
      : null;
    const changed = validReport && previousQueue !== JSON.stringify(nativeQueue);
    if (nativeQueue) {
      let reconciled = false;
      for (const row of receipts.values())
        if (["appended", "playing"].includes(row.phase)) {
          const phase =
            row.uid === nativeQueue.currentUid
              ? "playing"
              : nativeQueue.uids.includes(row.uid)
                ? "appended"
                : nativeQueue.count === nativeQueue.uids.length
                  ? "finished"
                  : row.phase;
          if (row.phase !== phase) {
            row.phase = phase;
            row.confirmation = "native-queue";
            reconciled = true;
          }
        }
      if (reconciled) {
        try {
          persist();
        } catch {
          stopped = true;
        }
      }
    }
    if (changed && ready && queueReady) {
      try {
        options.onQueueChanged?.();
      } catch {}
    }
    const command = ready ? [...commands.values()].find((row) => !row.delivered) : null;
    if (command) command.delivered = true;
    return {
      ok: true,
      sessionId,
      command: command
        ? {
            id: command.id,
            kind: command.kind,
            trackId: command.trackId,
            entryId: command.entryId,
            expiresAt: command.expiresAt,
            ...(command.targets ? { targets: command.targets } : {}),
            ...(command.kind === "volume" ? { percent: command.percent } : {}),
          }
        : null,
    };
  }
  function complete(input = {}) {
    const command = commands.get(input.id);
    if (stopped || input.companionId !== companion || !command?.delivered)
      return fail("tidal_command_stale");
    const reasons = [
      "tidal_track_not_playable",
      "tidal_duration_invalid",
      "tidal_local_queue_required",
      "tidal_initialized_queue_required",
      "tidal_already_in_native_queue",
      "tidal_append_unconfirmed",
      "tidal_command_expired",
      "tidal_hooks_unavailable",
      "tidal_metadata_timeout",
      "tidal_metadata_failed",
      "tidal_cloud_queue_required",
      "tidal_native_queue_full",
      "tidal_remove_invalid",
      "tidal_remove_unavailable",
      "tidal_remove_unconfirmed",
      "tidal_volume_invalid",
      "tidal_volume_unavailable",
      "tidal_volume_unconfirmed",
    ];
    let result = fail(reasons.includes(input.error) ? input.error : "tidal_companion_rejected");
    if (input.ok !== true && input.writeAttempted === false) result.writeAttempted = false;
    if (input.ok === true && command.kind === "volume") {
      if (input.percent !== command.percent) return fail("tidal_volume_unconfirmed");
      result = { ok: true, percent: command.percent };
    } else if (input.ok === true && command.kind === "resolve") {
      const candidate = candidateFrom(input.candidate, command.trackId);
      if (!candidate) return fail("tidal_metadata_invalid");
      result = { ok: true, candidate };
    } else if (input.ok === true && command.kind === "append") {
      if (input.appended !== true || !/^[A-Za-z0-9_-]{1,160}$/.test(input.uid || ""))
        return fail("tidal_append_unconfirmed");
      result = { ok: true, appended: true, uid: input.uid };
    } else if (input.ok === true && command.kind === "remove") {
      if (
        input.removed !== true ||
        !Array.isArray(input.uids) ||
        input.uids.length !== command.targets.length ||
        command.targets.some((row) => !input.uids.includes(row.uid))
      )
        return fail("tidal_remove_unconfirmed");
      result = { ok: true, removed: command.targets.length };
    }
    return finish(input.id, result);
  }
  async function resolveQuery(input) {
    const query = String(input?.query || "")
      .normalize("NFKC")
      .trim()
      .replace(/^!(?:sr|songrequest)\s+/i, "")
      .replace(/\s+/g, " ");
    const id = trackId(query);
    if (id) return request("resolve", id);
    if (
      query.length < 2 ||
      query.length > 300 ||
      /[\u0000-\u001f\u007f]/.test(query) ||
      /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|tidal\.com|^\d+$|^[./\\])/i.test(query)
    )
      return fail("tidal_query_invalid");
    if (resolving.has(query)) return resolving.get(query);
    while (searches.length && searches[0] <= now() - 60000) searches.shift();
    if (searches.length >= 10 || resolving.size >= 8) return fail("tidal_search_rate_limited");
    searches.push(now());
    const work = (async () => {
      const found = options.search
        ? await options.search(query)
        : fail("tidal_catalog_setup_required");
      if (!found.ok) return found;
      if (
        !Array.isArray(found.candidates) ||
        found.candidates.length > 5 ||
        found.candidates.some((value) => !candidateFrom(value, trackId(value?.providerItemId)))
      )
        return fail("tidal_search_results_invalid");
      const policy = normalizePolicy(input.policy || {});
      const matching = found.candidates
        .map((candidate, rank) => ({
          candidate,
          score: confidence(query, [...candidate.artists, candidate.title].join(" "), rank),
        }))
        .filter(({ score }) => score >= policy.minimumConfidence)
        .sort((a, b) => b.score - a.score);
      if (!matching.length)
        return fail(
          found.candidates.length ? "tidal_search_no_eligible_match" : "tidal_search_no_results",
        );
      const versions = matching.filter(
        ({ candidate }) => derivativeAllowed(query, candidate.title, policy).ok,
      );
      if (!versions.length)
        return {
          ...fail("tidal_search_version_filtered"),
          details: {
            blocked: derivativeAllowed(query, matching[0].candidate.title, policy).blocked,
          },
        };
      const ranked = versions.filter(
        ({ candidate }) => candidate.durationMs <= policy.maxDurationMs,
      );
      if (!ranked.length)
        return {
          ...fail("duration_limit"),
          details: {
            title: versions[0].candidate.title,
            durationMs: versions[0].candidate.durationMs,
            maxDurationMs: policy.maxDurationMs,
          },
        };
      const resolved = await request("resolve", ranked[0].candidate.providerItemId);
      if (!resolved.ok) return resolved;
      if (resolved.candidate.durationMs > policy.maxDurationMs)
        return {
          ...fail("duration_limit"),
          details: {
            title: resolved.candidate.title,
            durationMs: resolved.candidate.durationMs,
            maxDurationMs: policy.maxDurationMs,
          },
        };
      if (
        confidence(query, [...resolved.candidate.artists, resolved.candidate.title].join(" "), 0) <
          policy.minimumConfidence ||
        !derivativeAllowed(query, resolved.candidate.title, policy).ok
      )
        return fail("tidal_search_metadata_changed");
      return { ...resolved, matchedQuery: query };
    })();
    resolving.set(query, work);
    try {
      return await work;
    } finally {
      resolving.delete(query);
    }
  }
  return {
    status,
    authorized,
    poll,
    complete,
    volume: require("./tidal-native-volume")({
      commands,
      status,
      finish,
      now,
      timeoutMs: options.timeoutMs,
    }),
    remove: require("./tidal-native-moderation")({
      receipts,
      commands,
      status,
      finish,
      now,
      timeoutMs: options.timeoutMs,
    }),
    review(input = {}) {
      const row = receipts.get(input.entryId);
      if (input.decision !== "not-in-tidal" || row?.phase !== "unknown")
        return fail("tidal_review_invalid");
      const previous = { ...row };
      row.phase = "failed";
      row.lastError = "tidal_operator_confirmed_absent";
      try {
        persist();
      } catch {
        receipts.set(input.entryId, previous);
        return fail("tidal_journal_write_failed");
      }
      return {
        ok: true,
        entryId: input.entryId,
        retryAllowed: true,
        resent: false,
      };
    },
    resolve: resolveQuery,
    enqueue: (input) => {
      const id = trackId(input?.trackId),
        candidate = candidateFrom(input?.candidate, id);
      return id && candidate
        ? request("append", id, input.entryId, candidate, input.automatic === true, input)
        : Promise.resolve(fail("tidal_track_invalid"));
    },
    observe(input = {}) {
      if (
        stopped ||
        input.provider !== "tidal" ||
        input.available !== true ||
        input.status !== "playing"
      )
        return;
      const normalize = (value) =>
        String(value || "")
          .normalize("NFKC")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ");
      const observedArtists = (input.artists || []).map(normalize);
      const matches = [...receipts.values()].filter(
        (row) =>
          row.phase === "appended" &&
          normalize(row.title) === normalize(input.title) &&
          row.artists?.length &&
          (row.artists.every((artist) => observedArtists.includes(normalize(artist))) ||
            [", ", " & "].some((separator) =>
              observedArtists.includes(normalize(row.artists.join(separator))),
            )),
      );
      if (matches.length !== 1) return;
      matches[0].phase = "playing";
      matches[0].observedAt = now();
      matches[0].confirmation = "windows-title-artist";
      try {
        persist();
      } catch {
        stopped = true;
      }
    },
    shutdown() {
      stopped = true;
      ready = false;
      for (const id of [...commands.keys()]) finish(id, fail("tidal_bridge_stopped"));
      fs.rmSync(pairingPath, { force: true });
    },
  };
};
module.exports.trackId = trackId;
