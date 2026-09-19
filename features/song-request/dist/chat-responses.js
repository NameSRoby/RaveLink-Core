const RESPONSE_KINDS = Object.freeze([
  "queued", "queue_failed", "now_playing", "playback_failed",
  "skip_succeeded", "skip_failed", "remove_succeeded", "remove_failed",
  "song_ban_succeeded", "song_ban_failed", "user_ban_succeeded", "user_ban_failed", "user_restored",
  "user_timeout_succeeded", "user_timeout_failed", "user_timeout_removed",
  "volume_changed", "volume_failed", "intake_paused", "intake_resumed"
]);

const ACTION_KINDS = Object.freeze({
  pause: ["intake_paused", "intake_paused"], resume: ["intake_resumed", "intake_resumed"],
  volume: ["volume_changed", "volume_failed"], skip: ["skip_succeeded", "skip_failed"],
  remove: ["remove_succeeded", "remove_failed"], block_song: ["song_ban_succeeded", "song_ban_failed"],
  unblock_song: ["song_ban_succeeded", "song_ban_failed"], block: ["user_ban_succeeded", "user_ban_failed"],
  unblock: ["user_restored", "user_ban_failed"], timeout: ["user_timeout_succeeded", "user_timeout_failed"],
  untimeout: ["user_timeout_removed", "user_timeout_failed"]
});

const REASONS = Object.freeze({
  requester_limit: "you have reached your request limit", queue_full: "the queue is full", intake_paused: "requests are paused",
  requester_blocked: "you are blocked from Song Request", requester_timed_out: "you are temporarily blocked from Song Request",
  song_blocked: "that song is blocked", item_duplicate: "that song is already queued or recently played",
  request_replay: "that request was already processed", youtube_reference_required: "a valid YouTube URL or video ID is required",
  candidate_invalid: "the song could not be validated", duration_limit: "the song is too long", entry_not_found: "the requested queue item was not found",
  youtube_catalog_unconfigured: "YouTube search is not configured", youtube_catalog_unavailable: "YouTube search is unavailable",
  youtube_daily_budget_exhausted: "the daily YouTube search budget is exhausted", youtube_search_rate_limited: "YouTube search is temporarily rate limited",
  youtube_quota_or_key_rejected: "the YouTube API key or quota was rejected", youtube_api_timeout: "YouTube search timed out",
  youtube_keyless_unavailable: "keyless YouTube search is unavailable", youtube_keyless_timeout: "keyless YouTube search timed out",
  youtube_keyless_rate_limited: "keyless YouTube search is temporarily rate limited", catalog_ambiguous: "the request matched multiple songs too closely",
  catalog_no_results: "YouTube returned no results", catalog_no_eligible_match: "no result passed the song safety filters",
  catalog_untrusted_link: "only trusted YouTube and Spotify links are accepted", spotify_track_required: "the Spotify link must point to one track",
  spotify_track_not_found: "the Spotify track could not be found", spotify_metadata_unavailable: "Spotify link metadata is unavailable",
  not_current_requester: "you can only skip your own currently playing song", invalid_requester: "that requester was not found",
  moderator_required: "a moderator is required", invalid_request: "the command was invalid"
});

function clean(value, maximum = 180) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function responseKind(request, result) {
  const method = clean(request?.method, 20);
  const action = clean(request?.payload?.action, 30);
  const ok = result?.ok === true;
  if (method === "submit") return ok ? "queued" : "queue_failed";
  if (method === "self") return action === "skip" ? (ok ? "skip_succeeded" : "skip_failed") : (ok ? "remove_succeeded" : "remove_failed");
  if (method === "moderate") return ACTION_KINDS[action]?.[ok ? 0 : 1] || "";
  if (method === "acknowledge" && result?.code === "started") return "now_playing";
  if (method === "acknowledge" && result?.code === "failed") return "playback_failed";
  return "";
}

function contextFrom(request, result, state) {
  const payload = request?.payload || {};
  const entryId = clean(result?.entryId || result?.entry?.id, 160);
  const entry = result?.entry || (entryId ? state?.queue?.find(row => row.id === entryId) : null) || null;
  return {
    user: clean(payload.requesterName || entry?.requesterLabel, 80),
    target: clean(payload.requesterName, 80).replace(/^@/, ""),
    title: clean(entry?.candidate?.title || entry?.query || payload.query, 180),
    position: Number(result?.position || 0),
    reason: REASONS[clean(result?.reason || result?.code || result?.error, 80)] || "the request could not be completed",
    removed: Math.max(0, Number(result?.removed || 0)),
    minutes: Math.max(1, Number(payload.minutes || 10)),
    volume: Math.max(0, Math.min(100, Number(payload.value || result?.volume?.control || 0)))
  };
}

function mention(value) { return value ? `@${value.replace(/^@/, "")} ` : ""; }
function title(value) { return value ? `\"${value}\"` : "that song"; }

const MESSAGES = Object.freeze({
  queued: c => `${mention(c.user)}Queued ${title(c.title)}${c.position ? ` at position ${c.position}` : ""}.`,
  queue_failed: c => `${mention(c.user)}Song Request failed: ${c.reason}.`,
  now_playing: c => `Now playing ${title(c.title)}${c.user ? `, requested by @${c.user}` : ""}.`,
  playback_failed: c => `Playback failed for ${title(c.title)}. The item was removed from the queue.`,
  skip_succeeded: c => `${title(c.title)} was skipped.`, skip_failed: c => `Skip failed: ${c.reason}.`,
  remove_succeeded: c => `${title(c.title)} was removed from the queue.`, remove_failed: c => `Remove failed: ${c.reason}.`,
  song_ban_succeeded: c => `${title(c.title)} was ${c.removed ? `blocked and ${c.removed} matching queue item${c.removed === 1 ? " was" : "s were"} removed` : "updated in the song block list"}.`,
  song_ban_failed: c => `Song block update failed: ${c.reason}.`,
  user_ban_succeeded: c => `${mention(c.target)}was blocked from requesting songs${c.removed ? `; ${c.removed} pending request${c.removed === 1 ? " was" : "s were"} removed` : ""}.`,
  user_ban_failed: c => `Requester access update failed: ${c.reason}.`, user_restored: c => `${mention(c.target)}can request songs again.`,
  user_timeout_succeeded: c => `${mention(c.target)}was blocked from Song Request for ${c.minutes} minute${c.minutes === 1 ? "" : "s"}.`,
  user_timeout_failed: c => `Requester timeout failed: ${c.reason}.`, user_timeout_removed: c => `${mention(c.target)}Song Request timeout was removed.`,
  volume_changed: c => `Song Request volume changed to ${c.volume}% (maximum output ${Math.round(c.volume * 0.4)}%).`,
  volume_failed: c => `Volume change failed: ${c.reason}.`, intake_paused: () => "Song Request intake is paused.", intake_resumed: () => "Song Request intake is open."
});

function composeChatResponse(request, result, state) {
  const kind = responseKind(request, result);
  const enabled = kind && state?.responses?.[kind] === true;
  const eligible = request?.payload?.notifyChat === true || (kind === "now_playing" || kind === "playback_failed") && result?.notifyChat === true;
  if (!enabled || !eligible || !MESSAGES[kind]) return null;
  return { kind, message: clean(MESSAGES[kind](contextFrom(request, result, state)), 500), replyParentMessageId: clean(request?.payload?.responseMessageId, 160) };
}

module.exports = { RESPONSE_KINDS, composeChatResponse, responseKind };

