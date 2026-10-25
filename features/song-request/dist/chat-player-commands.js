/** Route chat to the selected player, not the YouTube queue by accident.
 * Native handoffs retain requester hashes after leaving the local queue. Check
 * ownership against those receipts, and remove exact occurrences, never a guessed
 * track ID. Ambiguous titles fail without modifying any queue.
 */
const crypto = require("node:crypto");
const fail = (reason) => ({ ok: false, code: "rejected", reason });
const text = (value) =>
  String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
module.exports = function chatPlayerCommands({
  queue,
  preferences,
  tidal,
  spotify,
  context,
  changed,
}) {
  return async function route(request) {
    try {
      const payload = request.payload || {},
        self = request.method === "self";
      if (
        !(self && request.capability === "song.queue.submit.v1") &&
        !(
          request.capability === "song.queue.admin.v1" &&
          request.method === "moderate" &&
          payload.notifyChat === true
        )
      )
        return null;
      const action = payload.action;
      if (self && !["remove", "skip"].includes(action)) return null;
      const restrictions = [
        "block",
        "unblock",
        "timeout",
        "untimeout",
        "block_song",
        "unblock_song",
      ];
      if (!["volume", "pause", "resume", "remove", "skip", ...restrictions].includes(action))
        return null;
      const selected = await preferences("status", null);
      if (!selected.ok) return { value: fail("player_preferences_unavailable") };
      const native = ["tidal", "spotify"].includes(selected.player),
        player = selected.player === "tidal" ? tidal : spotify;
      const finish = (value) => {
        if (value.ok) changed(value);
        return { value };
      };
      if (["block", "unblock", "timeout", "untimeout"].includes(action)) {
        const requesterKey = queue.requesterModerationKey(payload);
        return finish(
          native ? await player("moderate", { ...payload, requesterKey }) : queue.moderate(payload),
        );
      }
      if (action === "unblock_song")
        return finish(queue.moderate({ ...payload, provider: selected.player }));
      if (action === "volume") {
        const volume = queue.status().volume;
        const output = Math.round(
          volume.floorPercent +
            (payload.value * (volume.ceilingPercent - volume.floorPercent)) / 100,
        );
        if (native) {
          const reply = await player(
            selected.player === "tidal" ? "volume" : "control",
            selected.player === "tidal" ? { percent: output } : { action: "volume", value: output },
          );
          if (!reply.ok)
            return { value: fail(reply.error || reply.reason || "player_control_unavailable") };
        }
        return finish(queue.moderate({ action, value: payload.value }));
      }
      if (["pause", "resume"].includes(action)) {
        if (native) {
          const reply =
            selected.player === "spotify"
              ? await player("control", { action })
              : await context.callCapability(
                  "media.windows.now-playing.v1",
                  "control",
                  { action, provider: "tidal" },
                  { timeoutMs: 10000 },
                );
          return finish(
            reply.ok
              ? { ok: true, code: "playback_" + action, playbackControl: action }
              : fail(reply.error || "player_control_unavailable"),
          );
        }
        return finish(queue.controlPlayback({ action }));
      }
      const local = [];
      const first = queue.status({ limit: 25 });
      for (let offset = 0; offset < Math.min(200, first.counts.queued); offset += 25)
        local.push(...queue.status({ offset, limit: 25 }).queue);
      let status = null;
      if (native) status = await player("status", null);
      const managed = queue.playbackStatus().managed;
      const currentId = native
        ? status?.current?.entryId
        : action === "remove" && !managed?.started && managed?.status !== "playing"
          ? ""
          : managed?.entryId;
      const receipts = native
        ? (status?.handoffs || []).filter((r) =>
            ["appended", "playing", "pending", "unknown"].includes(r.phase),
          )
        : [];
      const rows = [
        ...new Map(
          [
            ...(!native && managed?.origin === "playlist"
              ? [{ ...managed, id: managed.entryId }]
              : []),
            ...receipts,
            ...local,
          ].map((r) => [
            r.entryId || r.id,
            {
              ...r,
              id: r.entryId || r.id,
              candidate: r.candidate || {
                provider: selected.player,
                title: r.title || "",
                providerItemId: r.trackId,
              },
            },
          ]),
        ).values(),
      ].filter((r) => r.candidate.provider === selected.player);
      const owner = self
        ? "req_" +
          crypto
            .createHash("sha256")
            .update(payload.requesterId || "")
            .digest("hex")
        : null;
      let choices =
        action === "skip"
          ? rows.filter((r) => r.id === currentId)
          : action === "block_song"
            ? rows
            : rows.filter((r) => r.id !== currentId);
      if (self) choices = choices.filter((r) => r.requesterKey === owner);
      const query = text(payload.query);
      if (payload.entryId) {
        choices = choices.filter((r) => r.id === payload.entryId);
      } else if (payload.position || /^\d{1,3}$/.test(query)) {
        const entry = rows[(payload.position || Number(query)) - 1];
        choices = choices.filter((r) => r.id === entry?.id);
      } else if (query) {
        const exact = choices.filter(
          (r) => text(r.candidate.title) === query || r.id === payload.query,
        );
        choices = exact.length
          ? exact
          : choices.filter((r) => text(r.candidate.title).includes(query));
      } else if (action === "remove") choices = choices.slice(-1);
      if (
        !self &&
        action === "skip" &&
        native &&
        !choices.length &&
        !query &&
        !payload.position &&
        !payload.entryId
      ) {
        if (!status?.current?.uid) return { value: fail("entry_not_found") };
        if (selected.player === "spotify")
          return finish(
            await player("control", { action: "skip", currentUid: status.current.uid }),
          );
        return finish(await player("moderate", { action: "skip", currentUid: status.current.uid }));
      }
      if (choices.length !== 1)
        return {
          value: fail(
            choices.length > 1
              ? "song_ambiguous"
              : self && action === "skip"
                ? "not_current_requester"
                : "entry_not_found",
          ),
        };
      const entry = choices[0];
      if (native)
        return finish({
          ...(await player("moderate", {
            action,
            entryId: entry.id,
            ...(action === "skip" ? { currentUid: status.current.uid } : {}),
          })),
          entry,
        });
      return finish({ ...queue.moderate({ action, entryId: entry.id }), entry });
    } catch {
      return { value: fail("player_control_unavailable") };
    }
  };
};
