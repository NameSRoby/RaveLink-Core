const test = require("node:test");
const assert = require("node:assert/strict");
const feature = require("../features/twitch-integration/dist/main");
const { createFeatureRuntimeHarness } = require("./support/feature-runtime-harness");

test("Twitch feature forwards only its declared narrow host operations", async (t) => {
  const observed = [];
  const scopes = [
    "channel:manage:redemptions",
    "channel:read:vips",
    "moderation:read",
    "user:read:chat",
    "user:write:chat",
    "channel:read:subscriptions",
    "channel:read:hype_train",
    "moderator:read:followers",
    "bits:read",
  ];
  const providers = {};
  for (const method of [
    "status",
    "configure",
    "clear-client-id",
    "begin",
    "poll",
    "disconnect",
    "inspect-reward",
    "list-rewards",
    "create-reward",
    "settle",
    "send-chat",
  ]) {
    providers[`twitch.host.v1/${method}`] = async (payload) => {
      observed.push({ method, payload });
      if (method === "settle")
        return {
          ok: true,
          status: payload.status,
          redemptionId: payload.redemptionId,
          refunded: payload.status === "CANCELED",
        };
      if (method === "inspect-reward")
        return {
          ok: true,
          rewardId: payload.rewardId,
          exists: true,
          manageable: true,
          title: "Lights",
        };
      if (method === "list-rewards")
        return {
          ok: true,
          cached: false,
          events: [
            {
              id: "event:channel.raid",
              type: "channel.raid",
              label: "Incoming raid",
              scope: "",
              available: true,
            },
          ],
          rewards: [
            {
              id: "rw1",
              title: "Lights",
              prompt: "",
              cost: 1000,
              enabled: true,
              paused: false,
              userInputRequired: true,
              manageable: true,
              managedPurpose: "lights",
            },
          ],
        };
      if (method === "create-reward")
        return {
          ok: true,
          purpose: payload.purpose,
          rewardId: "managed",
          title: payload.title,
          cost: payload.cost,
          manageable: true,
        };
      if (method === "send-chat")
        return { ok: true, messageId: "message-1", dropped: false, reason: "" };
      return {
        ok: true,
        configured: true,
        connected: method !== "disconnect",
        login: "streamer",
        userId: "user-1",
        scopes,
        expiresAt: 0,
        authorizationPending: false,
        userCode: "",
        verificationUri: "",
        nextPollAt: 0,
        authorizationExpiresAt: 0,
        requiredScopes: scopes,
        vault: "windows_dpapi",
        lastError: "",
      };
    };
  }
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "twitch-integration",
    providers,
  });
  t.after(() => harness.stop());
  await harness.start();
  const status = await harness.request("twitch.connection.read.v1", "status", null);
  assert.equal(status.scopes.length, 9);
  const reward = await harness.request("twitch.rewards.read.v1", "inspect", {
    rewardId: "rw1",
  });
  assert.equal(reward.manageable, true);
  const catalog = await harness.request("twitch.rewards.catalog.v1", "list", {});
  assert.equal(catalog.rewards[0].title, "Lights");
  assert.equal(catalog.events[0].label, "Incoming raid");
  const created = await harness.request("twitch.rewards.admin.v1", "create", {
    purpose: "lights",
    title: "Lights",
    cost: 1000,
  });
  assert.equal(created.rewardId, "managed");
  const settlement = await harness.request("twitch.redemptions.v1", "settle", {
    redemptionId: "r1",
    rewardId: "rw1",
    status: "CANCELED",
  });
  assert.equal(settlement.refunded, true);
  const chat = await harness.request("twitch.chat.send.v1", "send", {
    message: "hello",
  });
  assert.equal(chat.messageId, "message-1");
  await harness.request("twitch.oauth.admin.v1", "clear", null);
  assert.deepEqual(
    observed.map((row) => row.method),
    [
      "status",
      "inspect-reward",
      "list-rewards",
      "create-reward",
      "settle",
      "send-chat",
      "clear-client-id",
    ],
  );
  await assert.rejects(
    () => harness.request("twitch.oauth.admin.v1", "export-token", null),
    /method_unavailable/,
  );
});
