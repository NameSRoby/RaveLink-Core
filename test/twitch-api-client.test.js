const test = require("node:test");
const assert = require("node:assert/strict");
const { createTwitchApiClient, DEFAULT_SCOPES, normalizeScopes } = require("../src/capabilities/feature-platform/providers/twitch-api-client");

test("granted scope normalization never invents permissions for an empty list", () => {
  assert.deepEqual(normalizeScopes(undefined), [...DEFAULT_SCOPES].sort());
  assert.deepEqual(normalizeScopes([], []), []);
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body || {}) };
}

test("Twitch Device Code flow requests only the bounded supported scopes", async () => {
  const calls = [];
  const api = createTwitchApiClient({ fetch: async (url, init) => {
    calls.push({ url, init });
    return response(200, { device_code: "device-secret", user_code: "ABCD1234", verification_uri: "https://www.twitch.tv/activate", expires_in: 1800, interval: 5 });
  } });
  const result = await api.beginDeviceAuthorization({ clientId: "abcdefghij123456", scopes: [...DEFAULT_SCOPES, "user:read:email"] });
  assert.equal(result.ok, true);
  assert.equal(result.userCode, "ABCD1234");
  assert.equal(String(calls[0].init.body).includes("user%3Aread%3Aemail"), false);
  for (const scope of DEFAULT_SCOPES) assert.equal(result.scopes.includes(scope), true);
});

test("public Device Code clients refresh without a client secret and rotate the refresh token", async () => {
  const calls = [];
  const api = createTwitchApiClient({ fetch: async (url, init) => {
    calls.push({ url, init });
    return response(200, { access_token: "next-access", refresh_token: "next-refresh", expires_in: 14400, scope: DEFAULT_SCOPES });
  } });
  const result = await api.refreshUserAccessToken({ clientId: "client123456", refreshToken: "old refresh/+" });
  assert.equal(result.ok, true);
  assert.equal(result.refreshToken, "next-refresh");
  assert.match(calls[0].url, /oauth2\/token$/);
  assert.equal(calls[0].init.body.get("grant_type"), "refresh_token");
  assert.equal(calls[0].init.body.get("refresh_token"), "old refresh/+");
  assert.equal(calls[0].init.body.has("client_secret"), false);
});

test("redemption settlement uses Twitch's explicit fulfilled/canceled states", async () => {
  const calls = [];
  const api = createTwitchApiClient({ fetch: async (url, init) => { calls.push({ url, init }); return response(200, { data: [{ id: "redemption-1" }] }); } });
  const credentials = { clientId: "client123456", accessToken: "access-secret", userId: "broadcaster-1" };
  const canceled = await api.settleRedemption({ credentials, rewardId: "reward-1", redemptionId: "redemption-1", status: "CANCELED" });
  assert.deepEqual(canceled, { ok: true, status: "CANCELED", redemptionId: "redemption-1", refunded: true });
  assert.match(calls[0].url, /channel_points\/custom_rewards\/redemptions/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { status: "CANCELED" });
  assert.equal(calls[0].init.headers.Authorization, "Bearer access-secret");
  assert.equal((await api.settleRedemption({ credentials, status: "unknown" })).error, "twitch_settlement_invalid");
});

test("reward inspection distinguishes visible rewards from rewards manageable by this Client ID", async () => {
  const calls = [];
  const api = createTwitchApiClient({ fetch: async (url, init) => {
    calls.push({ url, init });
    const manageable = String(url).includes("only_manageable_rewards=true");
    return response(200, { data: manageable ? [] : [{ id: "manual-reward", title: "Change lights" }] });
  } });
  const result = await api.inspectReward({
    credentials: { clientId: "client123456", accessToken: "access-secret", userId: "broadcaster-1" },
    rewardId: "manual-reward"
  });
  assert.deepEqual(result, { ok: true, rewardId: "manual-reward", exists: true, manageable: false, title: "Change lights" });
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /only_manageable_rewards=true/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer access-secret");
});

test("managed reward creation keeps redemptions queued for server settlement", async () => {
  const calls = [];
  const api = createTwitchApiClient({ fetch: async (url, init) => {
    calls.push({ url, init });
    return response(200, { data: [{ id: "managed-reward", title: "RaveLink: Change Lights", cost: 1200 }] });
  } });
  const created = await api.createReward({
    credentials: { clientId: "client123456", accessToken: "access-secret", userId: "broadcaster-1" },
    title: "RaveLink: Change Lights", cost: 1200, prompt: "Enter a color"
  });
  assert.deepEqual(created, { ok: true, rewardId: "managed-reward", title: "RaveLink: Change Lights", cost: 1200, manageable: true });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.is_user_input_required, true);
  assert.equal(body.should_redemptions_skip_request_queue, false);
});

test("managed reward pause uses Helix Update Custom Reward", async () => {
  const calls = [];
  const api = createTwitchApiClient({ fetch: async (url, init) => { calls.push({ url, init }); return response(200, { data: [{ id: "song-reward", is_paused: true }] }); } });
  const result = await api.setRewardPaused({
    credentials: { clientId: "client123456", accessToken: "access-secret", userId: "broadcaster-1" },
    rewardId: "song-reward",
    paused: true
  });
  assert.deepEqual(result, { ok: true, rewardId: "song-reward", paused: true });
  assert.match(calls[0].url, /channel_points\/custom_rewards\?broadcaster_id=broadcaster-1&id=song-reward/);
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].init.body), { is_paused: true });
});

test("Twitch chat sends as the authorized local broadcaster account", async () => {
  const calls = [];
  const api = createTwitchApiClient({ fetch: async (url, init) => { calls.push({ url, init }); return response(200, { data: [{ message_id: "message-1", is_sent: true }] }); } });
  const result = await api.sendChat({ credentials: { clientId: "client123456", accessToken: "token", userId: "user-1" }, message: "Request accepted" });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), { broadcaster_id: "user-1", sender_id: "user-1", message: "Request accepted" });
});

test("Twitch chat reports a dropped Helix message as a delivery failure", async () => {
  const api = createTwitchApiClient({ fetch: async () => response(200, { data: [{ message_id: "message-1", is_sent: false, drop_reason: { code: "automod", message: "Message rejected" } }] }) });
  const result = await api.sendChat({ credentials: { clientId: "client123456", accessToken: "token", userId: "user-1" }, message: "Request accepted" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "twitch_chat_dropped");
  assert.equal(result.reason, "Message rejected");
});

test("Twitch role directory pages through moderators and VIPs with moderator precedence", async () => {
  const calls = [];
  const api = createTwitchApiClient({ fetch: async url => {
    calls.push(String(url));
    if (String(url).includes("/moderation/moderators")) {
      const second = String(url).includes("after=mods-next");
      return response(200, { data: [{ user_id: second ? "mod-2" : "both" }], pagination: second ? {} : { cursor: "mods-next" } });
    }
    return response(200, { data: [{ user_id: "vip-1" }, { user_id: "both" }], pagination: {} });
  } });
  const result = await api.listRequesterRoles({ credentials: { clientId: "client123456", accessToken: "token", userId: "broadcaster-1" } });
  assert.deepEqual(result, { ok: true, moderators: ["both", "mod-2"], vips: ["vip-1"] });
  assert.equal(calls.length, 3);
  assert.match(calls[1], /after=mods-next/);
  assert.match(calls[2], /channels\/vips/);
});

test("EventSub subscriptions use the welcomed WebSocket session and user token", async () => {
  const calls = [];
  const api = createTwitchApiClient({ fetch: async (url, init) => { calls.push({ url, init }); return response(202, { data: [{ id: "sub-1", status: "enabled" }] }); } });
  const result = await api.createEventSubSubscription({
    credentials: { clientId: "client123456", accessToken: "token", userId: "user-1" },
    type: "channel.chat.message",
    version: "1",
    condition: { broadcaster_user_id: "user-1", user_id: "user-1" },
    sessionId: "session-1"
  });
  assert.equal(result.ok, true);
  assert.match(calls[0].url, /helix\/eventsub\/subscriptions$/);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.transport, { method: "websocket", session_id: "session-1" });
  assert.equal(calls[0].init.headers.Authorization, "Bearer token");
});
