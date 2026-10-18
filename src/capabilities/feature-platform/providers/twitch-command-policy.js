/** Explicit command grants. Roles come from authenticated Twitch events, never
 * command text. Own-song grants and permission to affect others are separate;
 * enabling a viewer's skip/remove command must not silently grant moderation.
 */
const COMMANDS = Object.freeze([
  "request",
  "song",
  "songqueue",
  "queue",
  "volume",
  "skip",
  "remove",
  "pause",
  "resume",
  "ban",
  "unban",
  "timeout",
  "untimeout",
  "bansong",
  "unbansong",
  "skipAny",
  "removeAny",
]);
const ROLES = Object.freeze(["moderator", "vip", "viewer"]);
function normalizeCommandPermissions(input) {
  return Object.fromEntries(
    COMMANDS.map((command) => [
      command,
      Object.fromEntries(
        ROLES.map((role) => [
          role,
          typeof input?.[command]?.[role] === "boolean"
            ? input[command][role]
            : role === "moderator" ||
              ["request", "skip", "remove", "song", "songqueue", "queue"].includes(command),
        ]),
      ),
    ]),
  );
}
module.exports = { COMMANDS, ROLES, normalizeCommandPermissions };
