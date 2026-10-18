/** Read-only chat information. Native handoffs precede locally waiting requests;
 * queueOrder comes from the observed desktop queue, not receipt insertion order.
 * Unknown/pending deliveries cannot establish a reliable position. Never retry a
 * write or advance playback while answering these commands. Public replies include
 * only song metadata and request positions, never IDs, hashes or account details.
 */
const crypto = require("node:crypto");
const clean = (value, length = 180) =>
  String(value || "")
    .normalize("NFKC")
    // Metadata is plain text, not HTML. Remove individual delimiters rather than
    // matching whole tags: nested/unfinished input cannot recreate a delimiter.
    // HTML consumers must still use textContent, never innerHTML.
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, length);
const describe = (row, length = 180) => {
  const candidate = row?.candidate || row || {};
  const artists = Array.isArray(candidate.artists)
    ? candidate.artists
        .map((x) => clean(x, 60))
        .filter(Boolean)
        .join(", ")
    : "";
  const artistBudget = Math.min(60, Math.floor(length / 3));
  return (
    clean(
      candidate.title || row?.title || "Untitled song",
      artists ? length - artistBudget - 3 : length,
    ) + (artists ? " - " + clean(artists, artistBudget) : "")
  );
};
module.exports = async function chatInformation({ queue, preferences, tidal, spotify }, payload) {
  const reply = (message) => ({ ok: true, message });
  const selection = await preferences("status", null);
  if (!selection.ok) return { ok: false, message: "Song information is temporarily unavailable." };
  const provider = selection.player,
    native = ["tidal", "spotify"].includes(provider);
  const playback = queue.playbackStatus(),
    local = [];
  const state = native ? await (provider === "tidal" ? tidal : spotify)("status", null) : null;
  const receipts = state?.handoffs || [];
  const currentId = native
    ? state?.current?.entryId ||
      receipts.find((row) => row.uid && row.uid === state?.current?.uid)?.entryId
    : playback.managed?.entryId;
  const current = native
    ? receipts.find((row) => row.entryId === currentId) || state?.current
    : playback.managed;
  const observation =
    (playback.primary?.candidate?.provider || playback.primary?.provider) === provider
      ? playback.primary
      : null;
  if (payload.command === "song") {
    const candidate =
      (!native || state?.connected) && (current?.candidate?.title || current?.title)
        ? current
        : observation;
    if (native && !candidate && (!state?.connected || state?.current?.uid))
      return { ok: false, message: "Now-playing information is temporarily unavailable." };
    if (!candidate || (!native && !["playing", "paused"].includes(candidate.status)))
      return reply("No song is currently playing.");
    const paused =
      (native ? observation?.status : candidate.status) === "paused" ||
      current?.paused === true ||
      current?.status === "paused" ||
      (!native && playback.control?.paused);
    return reply(`${paused ? "Paused" : "Now playing"}: ${describe(candidate)}.`);
  }
  if (native && (!state?.ok || !state.ready || !state.connected))
    return {
      ok: false,
      message: "The player queue is unavailable right now; request positions cannot be confirmed.",
    };
  const first = queue.status({ limit: 25 });
  local.push(...first.queue.filter((row) => row.candidate.provider === provider));
  for (let offset = 25; offset < Math.min(200, first.counts.queued); offset += 25)
    local.push(
      ...queue
        .status({ offset, limit: 25 })
        .queue.filter((row) => row.candidate.provider === provider),
    );
  const uncertain = new Set(
    receipts
      .filter((row) => row.entryId !== currentId && ["pending", "unknown"].includes(row.phase))
      .map((row) => row.entryId),
  );
  const nativeRows = (state?.queueOrder || [])
    .map((id) => receipts.find((row) => row.entryId === id && row.phase === "appended"))
    .filter(Boolean);
  const rows = [
    ...new Map(
      [...nativeRows, ...local]
        .filter(
          (row) => !uncertain.has(row.entryId || row.id) && (row.entryId || row.id) !== currentId,
        )
        .map((row) => [row.entryId || row.id, row]),
    ).values(),
  ];
  // Unknown ordering affects requests behind it too. An exact number would imply
  // knowledge the companion has not confirmed, so return an honest pending state.
  const orderUncertain =
    uncertain.size > 0 ||
    receipts.some(
      (row) =>
        row.phase === "appended" &&
        row.entryId !== currentId &&
        !nativeRows.some((x) => x.entryId === row.entryId),
    );
  if (payload.command === "songqueue") {
    if (orderUncertain)
      return reply(
        "The request queue is awaiting player confirmation. Try !songqueue again shortly.",
      );
    if (!rows.length) return reply("There are no pending song requests.");
    return reply(
      "Next requests: " +
        rows
          .slice(0, 5)
          .map((row, i) => `${i + 1}. ${describe(row, 70)}`)
          .join(" | "),
    );
  }
  const key = "req_" + crypto.createHash("sha256").update(payload.requesterId).digest("hex");
  const playing = current?.requesterKey === key;
  const currentNotice =
    observation?.status === "paused" ||
    current?.paused ||
    current?.status === "paused" ||
    (!native && playback.control?.paused)
      ? "Your requested song is paused."
      : "Your requested song is playing now.";
  const owned = rows
    .map((row, i) => ({ row, position: i + 1 }))
    .filter((x) => x.row.requesterKey === key);
  if (playing && !owned.length) return reply(currentNotice);
  if (
    orderUncertain &&
    (owned.length || receipts.some((row) => row.requesterKey === key && uncertain.has(row.entryId)))
  )
    return reply(
      "Your request is awaiting player confirmation; its queue position is not confirmed yet.",
    );
  if (!owned.length) return reply("You have no pending song requests.");
  return reply(
    `${playing ? currentNotice + " " : ""}Your next request is #${owned[0].position} in the request queue (${owned[0].position - 1} ahead)${owned.length > 1 ? `; ${owned.length - 1} more queued` : ""}.`,
  );
};
