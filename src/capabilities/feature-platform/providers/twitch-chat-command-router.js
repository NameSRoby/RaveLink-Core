const { youtubeVideoId } = require("../../../shared/media/youtube-reference");

const MAX_CHAT_COMMAND_USERS = 512;
const MODERATOR_COMMANDS = new Set(["pause", "resume", "volume", "ban", "unban", "timeout", "untimeout", "bansong", "unbansong"]);
const COMMAND_ALIASES = new Map([
  ["sr", "request"], ["songrequest", "request"],
  ["skip", "skip"], ["skipsong", "skip"], ["srskip", "skip"],
  ["remove", "remove"], ["removesong", "remove"], ["srremove", "remove"],
  ["pause", "pause"], ["srpause", "pause"], ["resume", "resume"], ["srresume", "resume"],
  ["volume", "volume"], ["srvolume", "volume"],
  ["ban", "ban"], ["srban", "ban"], ["unban", "unban"], ["srunban", "unban"],
  ["timeout", "timeout"], ["srtimeout", "timeout"], ["untimeout", "untimeout"], ["sruntimeout", "untimeout"],
  ["bansong", "bansong"], ["srbansong", "bansong"], ["unbansong", "unbansong"], ["srunbansong", "unbansong"]
]);

function boundedText(value, maximum) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function roleFromEvent(event = {}) {
  const badges = Array.isArray(event.badges) ? event.badges : [];
  const badgeIds = new Set(badges.map(row => boundedText(row?.set_id || row?.id, 40).toLowerCase()));
  if (event.chatter_user_id && event.chatter_user_id === event.broadcaster_user_id || badgeIds.has("broadcaster") || badgeIds.has("moderator")) return "moderator";
  return badgeIds.has("vip") ? "vip" : "viewer";
}

function resultValue(result) {
  return result?.ok === true && result.value && typeof result.value === "object" ? result.value : result;
}

module.exports = function createTwitchChatCommandRouter(options = {}) {
  const submitSongRequest = options.submitSongRequest || (async () => ({ ok: false, error: "song_request_unavailable" }));
  const selfManageSongRequest = options.selfManageSongRequest || (async () => ({ ok: false, error: "song_request_unavailable" }));
  const moderateSongRequest = options.moderateSongRequest || (async () => ({ ok: false, error: "song_request_unavailable" }));
  const now = options.now || Date.now;
  const cooldowns = new Map();
  const profiles = new Map();

  function observeProfile(event) {
    const userId = boundedText(event?.chatter_user_id, 160);
    if (!userId) return { userId: "", displayName: "", role: "viewer" };
    const profile = {
      userId,
      displayName: boundedText(event?.chatter_user_name || event?.chatter_user_login, 80) || "Twitch user",
      role: roleFromEvent(event),
      observedAt: Number(now())
    };
    profiles.delete(userId);
    while (profiles.size >= MAX_CHAT_COMMAND_USERS) profiles.delete(profiles.keys().next().value);
    profiles.set(userId, profile);
    return profile;
  }

  function profileFor(userId) {
    const profile = profiles.get(boundedText(userId, 160));
    return profile ? { ...profile } : { userId: boundedText(userId, 160), displayName: "", role: "viewer", observedAt: 0 };
  }

  function takeCooldown(userId) {
    const timestamp = Number(now());
    if (Number(cooldowns.get(userId) || 0) > timestamp) return false;
    while (cooldowns.size >= MAX_CHAT_COMMAND_USERS) cooldowns.delete(cooldowns.keys().next().value);
    cooldowns.set(userId, timestamp + 1500);
    return true;
  }

  async function requestSong(event, profile, argument, config) {
    if (config.songRequestChatEnabled !== true) return { handled: true, accepted: false, code: "channel_points_only" };
    const videoId = youtubeVideoId(argument);
    const requestId = boundedText(event.message_id, 160);
    if (!requestId || !takeCooldown(profile.userId)) return { handled: false, reason: requestId ? "cooldown" : "invalid_command" };
    const result = resultValue(await submitSongRequest({
      requestId,
      requesterId: profile.userId,
      requesterName: profile.displayName,
      requesterRole: profile.role,
      notifyChat: true,
      responseMessageId: requestId,
      query: argument,
      ...(videoId ? { candidate: { provider: "youtube", providerItemId: videoId, title: argument, artists: [], durationMs: 0 } } : {})
    }));
    return { handled: true, accepted: result?.ok === true, code: boundedText(result?.code || result?.error?.code || result?.error, 40) };
  }

  async function selfOrModerator(command, profile, argument, event) {
    const position = /^\d{1,3}$/.test(argument) ? Number(argument) : undefined;
    const result = profile.role === "moderator"
      ? resultValue(await moderateSongRequest({ action: command, position, requesterName: profile.displayName, notifyChat: true, responseMessageId: boundedText(event?.message_id, 160) }))
      : resultValue(await selfManageSongRequest({ action: command, requesterId: profile.userId, requesterName: profile.displayName, notifyChat: true, responseMessageId: boundedText(event?.message_id, 160) }));
    return { handled: true, accepted: result?.ok === true, code: boundedText(result?.code || result?.reason || result?.error?.code || result?.error, 40) };
  }

  function moderatorPayload(command, argument) {
    const parts = argument.split(" ").filter(Boolean);
    const position = /^\d{1,3}$/.test(parts[0] || "") ? Number(parts[0]) : undefined;
    const target = boundedText(parts[0], 80);
    const routes = {
      pause: { action: "pause" }, resume: { action: "resume" },
      volume: { action: "volume", value: Number(parts[0]) },
      ban: { action: "block", requesterName: target, removePending: true },
      unban: { action: "unblock", requesterName: target },
      timeout: { action: "timeout", requesterName: target, minutes: Number(parts[1] || 10), removePending: true },
      untimeout: { action: "untimeout", requesterName: target },
      bansong: { action: "block_song", position: position || 1 },
      unbansong: { action: "unblock_song", providerItemId: youtubeVideoId(parts[0]) }
    };
    return routes[command];
  }

  async function handle(event = {}, config = {}) {
    const profile = observeProfile(event);
    const message = boundedText(event?.message?.text, 560);
    const match = /^!([a-z][a-z0-9]*)(?:\s+(.+))?$/i.exec(message);
    if (!match) return { handled: false, reason: "not_allowlisted" };
    const command = COMMAND_ALIASES.get(match[1].toLowerCase());
    if (!command) return { handled: false, reason: "not_allowlisted" };
    const argument = boundedText(match[2], 500);
    if (!profile.userId) return { handled: false, reason: "invalid_command" };
    if (command === "request") return argument ? requestSong(event, profile, argument, config) : { handled: false, reason: "invalid_command" };
    if (command === "skip" || command === "remove") return selfOrModerator(command, profile, argument, event);
    if (!MODERATOR_COMMANDS.has(command) || profile.role !== "moderator") return { handled: true, accepted: false, code: "moderator_required" };
    const payload = moderatorPayload(command, argument);
    const invalid = command === "volume" && (!Number.isInteger(payload.value) || payload.value < 1 || payload.value > 100)
      || ["ban", "unban", "timeout", "untimeout"].includes(command) && !payload.requesterName
      || command === "unbansong" && !payload.providerItemId;
    if (invalid) return { handled: true, accepted: false, code: "invalid_command" };
    const result = resultValue(await moderateSongRequest({ ...payload, notifyChat: true, responseMessageId: boundedText(event?.message_id, 160) }));
    return { handled: true, accepted: result?.ok === true, code: boundedText(result?.code || result?.reason || result?.error?.code || result?.error, 40) };
  }

  return Object.freeze({ handle, profileFor });
};

module.exports.COMMAND_ALIASES = COMMAND_ALIASES;
module.exports.MAX_CHAT_COMMAND_USERS = MAX_CHAT_COMMAND_USERS;
module.exports.roleFromEvent = roleFromEvent;
module.exports.youtubeVideoId = youtubeVideoId;
