/**
 * Chat responses.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
const RESPONSE_KINDS = Object.freeze([
  "queued",
  "queue_failed",
  "now_playing",
  "playback_failed",
  "skip_succeeded",
  "skip_failed",
  "remove_succeeded",
  "remove_failed",
  "song_ban_succeeded",
  "song_ban_failed",
  "user_ban_succeeded",
  "user_ban_failed",
  "user_restored",
  "user_timeout_succeeded",
  "user_timeout_failed",
  "user_timeout_removed",
  "volume_changed",
  "volume_failed",
  "intake_paused",
  "intake_resumed",
]);

const ACTION_KINDS = Object.freeze({
  pause: ["intake_paused", "intake_paused"],
  resume: ["intake_resumed", "intake_resumed"],
  volume: ["volume_changed", "volume_failed"],
  skip: ["skip_succeeded", "skip_failed"],
  remove: ["remove_succeeded", "remove_failed"],
  block_song: ["song_ban_succeeded", "song_ban_failed"],
  unblock_song: ["song_ban_succeeded", "song_ban_failed"],
  block: ["user_ban_succeeded", "user_ban_failed"],
  unblock: ["user_restored", "user_ban_failed"],
  timeout: ["user_timeout_succeeded", "user_timeout_failed"],
  untimeout: ["user_timeout_removed", "user_timeout_failed"],
});

const REASONS = Object.freeze({
  tidal_search_unavailable: "TIDAL search is unavailable",
  spotify_search_unavailable: "Spotify search is unavailable",
  tidal_experiment_disabled: "the TIDAL desktop connection is unavailable",
  spotify_companion_unavailable: "the Spotify desktop connection is unavailable",
  tidal_query_invalid: "enter a song name or a valid track link",
  song_link_track_required: "the link must point to one song",
  song_link_metadata_unavailable:
    "the linked song's details are temporarily unavailable; try its artist and title",
  tidal_search_no_results: "TIDAL returned no matching songs",
  tidal_search_no_eligible_match: "no TIDAL result passed the matching filters",
  tidal_search_version_filtered: "the matching version is excluded by the song filters",
  spotify_match_not_found: "Spotify returned no eligible match",
  tidal_oauth_sign_in_required: "TIDAL needs to be connected in Setup",
  player_inactive: "that player is no longer selected",
  requester_limit: "you have reached your request limit",
  queue_full: "the queue is full",
  intake_paused: "requests are paused",
  requester_blocked: "you are blocked from Song Request",
  requester_timed_out: "you are temporarily blocked from Song Request",
  song_blocked: "that song is blocked",
  item_duplicate:
    "that song is already queued or playing, or needs another song to play before it can be requested again",
  request_replay: "that request was already processed",
  youtube_reference_required: "a valid YouTube URL or video ID is required",
  candidate_invalid: "the song could not be validated",
  duration_limit: "the song is too long",
  entry_not_found: "the requested queue item was not found",
  soundcloud_no_eligible_match: "no playable SoundCloud result passed the song and version filters",
  soundcloud_search_unavailable: "SoundCloud search is unavailable",
  soundcloud_search_rate_limited: "SoundCloud search is temporarily rate limited",
  soundcloud_search_timeout: "SoundCloud search timed out",
  soundcloud_search_page_changed:
    "SoundCloud search is temporarily unavailable; a direct track link may work",
  soundcloud_query_invalid: "enter an artist and song name",
  soundcloud_link_invalid: "a public SoundCloud track link is required for this player",
  youtube_catalog_unconfigured: "YouTube search is not configured",
  youtube_catalog_unavailable: "YouTube search is unavailable",
  youtube_daily_budget_exhausted: "the daily YouTube search budget is exhausted",
  youtube_search_rate_limited: "YouTube search is temporarily rate limited",
  youtube_quota_or_key_rejected: "the YouTube API key or quota was rejected",
  youtube_api_timeout: "YouTube search timed out",
  youtube_keyless_unavailable: "keyless YouTube search is unavailable",
  youtube_keyless_timeout: "keyless YouTube search timed out",
  youtube_keyless_rate_limited: "keyless YouTube search is temporarily rate limited",
  catalog_ambiguous: "the request matched multiple songs too closely",
  catalog_no_results: "YouTube returned no results",
  catalog_no_eligible_match: "no result passed the song safety filters",
  catalog_untrusted_link: "only supported YouTube, Spotify, and TIDAL track links are accepted",
  spotify_track_required: "the Spotify link must point to one track",
  spotify_track_not_found: "the Spotify track could not be found",
  spotify_metadata_unavailable: "Spotify link metadata is unavailable",
  not_current_requester: "you can only skip your own currently playing song",
  invalid_requester: "that requester was not found",
  moderator_required: "a moderator is required",
  invalid_request: "the command was invalid",
  song_ambiguous: "several songs match; use the exact song name or queue position",
  player_control_unavailable:
    "the selected player's controls are unavailable; check its connection in Setup",
  tidal_companion_update_required:
    "update and reconnect the TIDAL companion to enable volume control",
  spotify_command_invalid: "update and reconnect the Spotify companion to enable this control",
  spotify_playback_restricted: "Spotify did not allow this playback control",
  media_session_unavailable: "the selected music app has no unique Windows media session",
  media_control_rejected: "the music app did not accept the playback command",
});

function clean(value, maximum = 180) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function responseKind(request, result) {
  const method = clean(request?.method, 20);
  const action = clean(request?.payload?.action, 30);
  const ok = result?.ok === true;
  if (method === "submit") return ok ? "queued" : "queue_failed";
  if (method === "self")
    return action === "skip"
      ? ok
        ? "skip_succeeded"
        : "skip_failed"
      : ok
        ? "remove_succeeded"
        : "remove_failed";
  if (method === "moderate") return ACTION_KINDS[action]?.[ok ? 0 : 1] || "";
  if (method === "acknowledge" && result?.code === "started") return "now_playing";
  if (method === "acknowledge" && result?.code === "failed") return "playback_failed";
  return "";
}

function contextFrom(request, result, state) {
  const payload = request?.payload || {};
  const entryId = clean(result?.entryId || result?.entry?.id, 160);
  const entry =
    result?.entry || (entryId ? state?.queue?.find((row) => row.id === entryId) : null) || null;
  return {
    user: clean(payload.requesterName || entry?.requesterLabel, 80),
    target: clean(payload.requesterName, 80).replace(/^@/, ""),
    title: clean(entry?.candidate?.title || entry?.query || payload.query, 180),
    position: Number(result?.position || 0),
    reason:
      REASONS[clean(result?.reason || result?.code || result?.error, 80)] ||
      "the request could not be completed",
    removed: Math.max(0, Number(result?.removed || 0)),
    minutes: Math.max(1, Number(payload.minutes || 10)),
    volume: Math.max(0, Math.min(100, Number(payload.value || result?.volume?.control || 0))),
    outputVolume: result?.volume?.outputPercent ?? state?.volume?.outputPercent ?? 0,
    playbackControl: result?.playbackControl,
    succeeded: result?.ok === true,
  };
}

function mention(value) {
  return value ? `@${value.replace(/^@/, "")} ` : "";
}
function title(value) {
  return value ? `\"${value}\"` : "that song";
}

const MESSAGES = Object.freeze({
  queued: (c) =>
    `${mention(c.user)}Queued ${title(c.title)}${c.position ? ` at position ${c.position}` : ""}.`,
  queue_failed: (c) => `${mention(c.user)}Song Request failed: ${c.reason}.`,
  now_playing: (c) => `Now playing ${title(c.title)}${c.user ? `, requested by @${c.user}` : ""}.`,
  playback_failed: (c) =>
    `Playback failed for ${title(c.title)}. The item was removed from the queue.`,
  skip_succeeded: (c) => `${title(c.title)} was skipped.`,
  skip_failed: (c) => `Skip failed: ${c.reason}.`,
  remove_succeeded: (c) => `${title(c.title)} was removed from the queue.`,
  remove_failed: (c) => `Remove failed: ${c.reason}.`,
  song_ban_succeeded: (c) =>
    `${title(c.title)} was ${c.removed ? `blocked and ${c.removed} matching queue item${c.removed === 1 ? " was" : "s were"} removed` : "updated in the song block list"}.`,
  song_ban_failed: (c) => `Song block update failed: ${c.reason}.`,
  user_ban_succeeded: (c) =>
    `${mention(c.target)}was blocked from requesting songs${c.removed ? `; ${c.removed} pending request${c.removed === 1 ? " was" : "s were"} removed` : ""}.`,
  user_ban_failed: (c) => `Requester access update failed: ${c.reason}.`,
  user_restored: (c) => `${mention(c.target)}can request songs again.`,
  user_timeout_succeeded: (c) =>
    `${mention(c.target)}was blocked from Song Request for ${c.minutes} minute${c.minutes === 1 ? "" : "s"}.`,
  user_timeout_failed: (c) => `Requester timeout failed: ${c.reason}.`,
  user_timeout_removed: (c) => `${mention(c.target)}Song Request timeout was removed.`,
  volume_changed: (c) => `Song Request volume changed to ${c.volume}% (output ${c.outputVolume}%).`,
  volume_failed: (c) => `Volume change failed: ${c.reason}.`,
  intake_paused: (c) =>
    c.playbackControl
      ? "Music playback is paused."
      : c.succeeded
        ? "Song Request intake is paused."
        : `Pause failed: ${c.reason}.`,
  intake_resumed: (c) =>
    c.playbackControl
      ? "Music playback resumed."
      : c.succeeded
        ? "Song Request intake is open."
        : `Resume failed: ${c.reason}.`,
});

function composeChatResponse(request, result, state) {
  if (result?.reason === "request_replay" || result?.community?.duplicate === true) return null;
  const kind = responseKind(request, result);
  const enabled = kind && state?.responses?.[kind] === true;
  const eligible =
    request?.payload?.notifyChat === true ||
    ((kind === "now_playing" || kind === "playback_failed") && result?.notifyChat === true);
  if (!enabled || !eligible || !MESSAGES[kind]) return null;
  return {
    kind,
    message: clean(MESSAGES[kind](contextFrom(request, result, state)), 500),
    replyParentMessageId: clean(request?.payload?.responseMessageId, 160),
  };
}

module.exports = { RESPONSE_KINDS, composeChatResponse, responseKind };
