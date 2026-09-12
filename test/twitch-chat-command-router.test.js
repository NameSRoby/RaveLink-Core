const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const createRouter = require("../src/capabilities/feature-platform/providers/twitch-chat-command-router");

test("native Twitch chat accepts only explicit bounded song request commands", async () => {
  let now = 1000;
  const submitted = [];
  const router = createRouter({ now: () => now, submitSongRequest: async payload => { submitted.push(payload); return { ok: true, value: { ok: true, code: "accepted" } }; } });
  const event = (text, id = "message-1", user = "user-1") => ({ message_id: id, chatter_user_id: user, message: { text } });
  assert.equal((await router.handle(event("!sr song"), { songRequestChatEnabled: false })).code, "channel_points_only");
  assert.equal((await router.handle(event("sr song"), { songRequestChatEnabled: true })).reason, "not_allowlisted");
  assert.equal((await router.handle(event("!lights red"), { songRequestChatEnabled: true })).reason, "not_allowlisted");
  assert.equal((await router.handle(event("!sr"), { songRequestChatEnabled: true })).reason, "invalid_command");
  const unresolved = await router.handle(event("!songrequest a song"), { songRequestChatEnabled: true });
  assert.deepEqual(unresolved, { handled: true, accepted: true, code: "accepted" });
  assert.equal(submitted[0].query, "a song");
  assert.equal(submitted[0].candidate, undefined);
  now += 1500;
  const accepted = await router.handle(event("!songrequest https://www.youtube.com/watch?v=dQw4w9WgXcQ"), { songRequestChatEnabled: true });
  assert.equal(accepted.handled, true);
  assert.equal(submitted[1].candidate.provider, "youtube");
  assert.equal(submitted[1].candidate.providerItemId, "dQw4w9WgXcQ");
  assert.equal((await router.handle(event("!sr dQw4w9WgXcQ", "message-2"), { songRequestChatEnabled: true })).reason, "cooldown");
  now += 1500;
  assert.equal((await router.handle(event("!sr 9bZkp7q19f0", "message-3"), { songRequestChatEnabled: true })).handled, true);
  assert.equal(submitted[2].query, "9bZkp7q19f0");
});

test("chat moderation uses Twitch badges and gives broadcasters moderator authority", async () => {
  const moderation = [];
  const self = [];
  const router = createRouter({
    moderateSongRequest: async payload => { moderation.push(payload); return { ok: true, value: { ok: true, code: payload.action } }; },
    selfManageSongRequest: async payload => { self.push(payload); return { ok: true, value: { ok: true, code: payload.action } }; }
  });
  const chat = (message, overrides = {}) => ({
    message_id: crypto.randomUUID(), chatter_user_id: "viewer", chatter_user_name: "Viewer",
    broadcaster_user_id: "broadcaster", badges: [], message: { text: message }, ...overrides
  });
  assert.equal((await router.handle(chat("!pause"), {})).code, "moderator_required");
  await router.handle(chat("!remove"), {});
  assert.deepEqual(self[0], { action: "remove", requesterId: "viewer", requesterName: "Viewer", notifyChat: true, responseMessageId: self[0].responseMessageId });
  await router.handle(chat("!ban @Trouble", { badges: [{ set_id: "moderator", id: "1" }] }), {});
  await router.handle(chat("!timeout @Trouble 30", { chatter_user_id: "broadcaster" }), {});
  await router.handle(chat("!bansong", { chatter_user_id: "broadcaster" }), {});
  await router.handle(chat("!volume 75", { chatter_user_id: "broadcaster" }), {});
  assert.deepEqual(moderation.map(({ responseMessageId, ...payload }) => payload), [
    { action: "block", requesterName: "@Trouble", removePending: true, notifyChat: true },
    { action: "timeout", requesterName: "@Trouble", minutes: 30, removePending: true, notifyChat: true },
    { action: "block_song", position: 1, notifyChat: true },
    { action: "volume", value: 75, notifyChat: true }
  ]);
});

test("VIP and moderator roles are forwarded only from trusted chat badges", async () => {
  const submitted = [];
  const router = createRouter({ submitSongRequest: async payload => { submitted.push(payload); return { ok: true, value: { ok: true, code: "accepted" } }; } });
  const base = { broadcaster_user_id: "channel", message: { text: "!sr dQw4w9WgXcQ" } };
  await router.handle({ ...base, message_id: "vip-message", chatter_user_id: "vip-user", chatter_user_name: "Vee", badges: [{ set_id: "vip", id: "1" }] }, { songRequestChatEnabled: true });
  await router.handle({ ...base, message_id: "mod-message", chatter_user_id: "mod-user", chatter_user_name: "Mod", badges: [{ set_id: "moderator", id: "1" }] }, { songRequestChatEnabled: true });
  assert.equal(submitted[0].requesterRole, "vip");
  assert.equal(submitted[1].requesterRole, "moderator");
  assert.equal(router.profileFor("vip-user").role, "vip");
});
