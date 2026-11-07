/** Optional capabilities mapped to the scopes their existing Helix/EventSub
 * owners use. Identity/validation needs no email or other optional scope.
 * Sources: dev.twitch.tv/docs/authentication/scopes/ and /docs/chat/authenticating */
const GROUPS = Object.freeze([
  {
    id: "rewards",
    label: "Channel Points",
    description:
      "Read and manage RaveLink rewards, receive redemptions, and settle their outcomes.",
    scopes: ["channel:manage:redemptions"],
  },
  {
    id: "chat-read",
    label: "Read chat commands",
    description: "Receive lighting, Song Request and !clip commands through EventSub.",
    scopes: ["user:read:chat"],
  },
  {
    id: "chat-send",
    label: "Send chat replies",
    description: "Send command replies, Song Request updates and created clip links.",
    scopes: ["user:write:chat"],
  },
  {
    id: "roles",
    label: "Moderator and VIP roles",
    description: "Look up requester roles for role limits and command permissions.",
    scopes: ["channel:read:vips", "moderation:read"],
  },
  {
    id: "clips",
    label: "Create stream clips",
    description: "Create clips of your live broadcast from buttons or chat commands.",
    scopes: ["clips:edit"],
  },
  {
    id: "followers",
    label: "Recent followers",
    description:
      "Show recent follower names in status widgets. The total count can work without this access.",
    scopes: ["moderator:read:followers"],
  },
  {
    id: "subscribers",
    label: "Subscriber widgets",
    description: "Read your subscriber total and subscription points for dashboard widgets.",
    scopes: ["channel:read:subscriptions"],
  },
  {
    id: "markers",
    label: "Twitch Highlighter markers",
    description:
      "Add a marker to your live VOD when you press its button. Local timestamps work without this access.",
    scopes: ["channel:manage:broadcast"],
  },
]);
const DEFAULT_GROUPS = Object.freeze(["rewards", "chat-read", "chat-send", "roles"]);
function normalizeGroups(value, fallback = DEFAULT_GROUPS) {
  if (value === undefined) return [...fallback];
  if (
    !Array.isArray(value) ||
    value.length > GROUPS.length ||
    value.some((id) => typeof id !== "string" || !GROUPS.some((group) => group.id === id)) ||
    new Set(value).size !== value.length
  )
    throw Error("twitch_permission_groups_invalid");
  return GROUPS.filter((group) => value.includes(group.id)).map((group) => group.id);
}
const scopesForGroups = (ids) =>
  [
    ...new Set(GROUPS.filter((group) => ids.includes(group.id)).flatMap((group) => group.scopes)),
  ].sort();
const groupsForScopes = (scopes) =>
  GROUPS.filter((group) => group.scopes.every((scope) => scopes.includes(scope))).map(
    (group) => group.id,
  );
function describe(selected, granted, connected) {
  return GROUPS.map((group) => ({
    ...group,
    scopes: [...group.scopes],
    selected: selected.includes(group.id),
    granted: group.scopes.every((scope) => granted.includes(scope)),
    available: connected && group.scopes.every((scope) => granted.includes(scope)),
    missingScopes: group.scopes.filter((scope) => !granted.includes(scope)),
  }));
}
module.exports = {
  GROUPS,
  DEFAULT_GROUPS,
  normalizeGroups,
  scopesForGroups,
  groupsForScopes,
  describe,
};
