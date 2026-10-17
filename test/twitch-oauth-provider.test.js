const test = require("node:test");
const assert = require("node:assert/strict");
const createTwitchOAuthProvider = require("../src/capabilities/feature-platform/providers/twitch-oauth-provider");

test("managed reward creation admits one writer per purpose and releases failed writers", async (t) => {
  let now = 1000,
    creates = 0,
    release;
  const api = {
    beginDeviceAuthorization: async () => ({
      ok: true,
      deviceCode: "device",
      userCode: "CODE",
      interval: 1,
      expiresIn: 600,
    }),
    pollDeviceAuthorization: async () => ({
      ok: true,
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 3600,
    }),
    validateToken: async () => ({
      ok: true,
      clientId: "clientid12345",
      userId: "viewer",
      login: "streamer",
      scopes: ["channel:manage:redemptions"],
      expiresIn: 3600,
    }),
    inspectReward: async () => ({ ok: true, exists: true }),
    createReward: async (input) => {
      creates++;
      await new Promise((resolve) => {
        release = resolve;
      });
      return {
        ok: true,
        rewardId: "one-reward",
        title: input.title,
        cost: 100,
      };
    },
  };
  const provider = createTwitchOAuthProvider({
    now: () => now,
    defaultClientId: "clientid12345",
    api,
  });
  t.after(() => provider.shutdown());
  await provider.begin();
  now += 1000;
  await provider.poll();
  const first = provider.createReward({
    purpose: "song_request",
    title: "Request",
  });
  assert.equal(
    (
      await provider.createReward({
        purpose: "song_request",
        title: "Duplicate",
      })
    ).error,
    "twitch_reward_creation_in_progress",
  );
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal((await first).ok, true);
  assert.equal(creates, 1);
  assert.equal(
    (await provider.createReward({ purpose: "song_request" })).error,
    "twitch_reward_purpose_exists",
  );
  api.createReward = async () => {
    throw new Error("network_down");
  };
  await assert.rejects(provider.createReward({ purpose: "lights" }), /network_down/);
  api.createReward = async () => ({
    ok: true,
    rewardId: "lights-retry",
    title: "Lights",
    cost: 100,
  });
  assert.equal((await provider.createReward({ purpose: "lights" })).ok, true);
});

test("OAuth provider starts with the shipped public application Client ID", async () => {
  const provider = createTwitchOAuthProvider({
    defaultClientId: "publicclient12345",
    api: { revokeToken: async () => ({ ok: true }) },
  });
  assert.equal(provider.status().configured, true);
  assert.equal(JSON.stringify(provider.status()).includes("publicclient12345"), false);
  assert.equal((await provider.clearClientId()).configured, false);
});

test("OAuth provider keeps device secrets private and settles only after validation", async () => {
  let now = 1000;
  const calls = [];
  let refreshes = 0;
  const api = {
    beginDeviceAuthorization: async (input) => ({
      ok: true,
      deviceCode: "never-expose",
      userCode: "CODE1234",
      verificationUri: "https://www.twitch.tv/activate",
      scopes: input.scopes || ["channel:manage:redemptions"],
      expiresIn: 600,
      interval: 5,
    }),
    pollDeviceAuthorization: async (input) => {
      calls.push(input);
      return {
        ok: true,
        pending: false,
        accessToken: "access",
        refreshToken: "refresh",
        scopes: input.scopes,
        expiresIn: 14400,
      };
    },
    refreshUserAccessToken: async () => {
      refreshes += 1;
      return {
        ok: true,
        accessToken: `access-${refreshes}`,
        refreshToken: `refresh-${refreshes}`,
        expiresIn: 14400,
      };
    },
    validateToken: async () => ({
      ok: true,
      clientId: "clientid12345",
      userId: "user-1",
      login: "streamer",
      scopes: ["channel:manage:redemptions"],
      expiresIn: 14400,
    }),
    revokeToken: async () => ({ ok: true }),
    inspectReward: async (input) => ({
      ok: true,
      rewardId: input.rewardId,
      exists: true,
      manageable: true,
      title: "Lights",
    }),
    createReward: async (input) => ({
      ok: true,
      rewardId: "managed-lights",
      title: input.title,
      cost: input.cost,
      manageable: true,
    }),
    setRewardPaused: async (input) => ({
      ok: true,
      rewardId: input.rewardId,
      paused: input.paused,
    }),
    settleRedemption: async (input) => ({
      ok: true,
      status: input.status,
      redemptionId: input.redemptionId,
      refunded: input.status === "CANCELED",
    }),
    sendChat: async () => ({
      ok: true,
      messageId: "message-1",
      dropped: false,
      reason: "",
    }),
  };
  const provider = createTwitchOAuthProvider({
    api,
    now: () => now,
    eventSubMonitorFactory: () => ({
      start() {},
      restart() {},
      stop() {},
      status: () => ({
        lifecycle: "stopped",
        connected: false,
        subscriptions: [],
      }),
    }),
  });
  assert.equal((await provider.configure({ clientId: "clientid12345" })).configured, true);
  const begun = await provider.begin({
    scopes: ["channel:manage:redemptions"],
  });
  assert.equal(begun.authorizationPending, true);
  assert.equal(JSON.stringify(begun).includes("never-expose"), false);
  assert.equal((await provider.poll()).error, "twitch_poll_too_fast");
  now += 5000;
  const connected = await provider.poll();
  assert.equal(connected.connected, true);
  assert.equal(connected.login, "streamer");
  assert.equal(JSON.stringify(connected).includes("access"), false);
  assert.equal(calls[0].deviceCode, "never-expose");
  assert.equal((await provider.inspectReward({ rewardId: "reward" })).manageable, true);
  now += 14400001;
  assert.equal(provider.status().connected, false);
  await Promise.all([
    provider.inspectReward({ rewardId: "reward-a" }),
    provider.inspectReward({ rewardId: "reward-b" }),
  ]);
  assert.equal(refreshes, 1);
  assert.equal((await provider.ensureStatus()).connected, true);
  assert.equal(
    (
      await provider.createReward({
        purpose: "lights",
        title: "Lights",
        cost: 1000,
      })
    ).rewardId,
    "managed-lights",
  );
  assert.equal(provider.status().managedRewards[0].purpose, "lights");
  assert.equal(
    (
      await provider.createReward({
        purpose: "lights",
        title: "Again",
        cost: 1000,
      })
    ).error,
    "twitch_reward_purpose_exists",
  );
  assert.equal(
    (
      await provider.setManagedRewardPaused({
        purpose: "song_request",
        paused: true,
      })
    ).error,
    "twitch_reward_not_managed",
  );
  await provider.createReward({
    purpose: "song_request",
    title: "Song Request",
    cost: 1000,
  });
  assert.equal(
    (
      await provider.setManagedRewardPaused({
        purpose: "song_request",
        paused: true,
      })
    ).paused,
    true,
  );
  assert.equal(
    (
      await provider.createReward({
        purpose: "teach",
        title: "Teach a color",
        cost: 500,
      })
    ).ok,
    true,
  );
  assert.equal(
    provider.status().managedRewards.some((row) => row.purpose === "teach"),
    true,
  );
  assert.equal(
    (
      await provider.settle({
        rewardId: "manual-reward",
        redemptionId: "redemption",
        status: "CANCELED",
      })
    ).error,
    "twitch_reward_not_managed",
  );
  assert.equal(
    (
      await provider.settle({
        rewardId: "managed-lights",
        redemptionId: "redemption",
        status: "CANCELED",
      })
    ).refunded,
    true,
  );
  assert.equal((await provider.disconnect()).connected, false);
  const cleared = await provider.clearClientId();
  assert.equal(cleared.configured, false);
  assert.equal(cleared.connected, false);
  assert.equal(JSON.stringify(cleared).includes("clientid12345"), false);
});

test("deleted managed rewards are reconciled and can be recreated", async () => {
  let now = 1000;
  let exists = true;
  let creates = 0;
  const api = {
    beginDeviceAuthorization: async (input) => ({
      ok: true,
      deviceCode: "device",
      userCode: "CODE",
      verificationUri: "https://www.twitch.tv/activate",
      scopes: input.scopes,
      expiresIn: 600,
      interval: 1,
    }),
    pollDeviceAuthorization: async () => ({
      ok: true,
      pending: false,
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 14400,
    }),
    validateToken: async () => ({
      ok: true,
      clientId: "clientid12345",
      userId: "user-1",
      login: "streamer",
      scopes: ["channel:manage:redemptions"],
      expiresIn: 14400,
    }),
    inspectReward: async (input) => ({
      ok: true,
      rewardId: input.rewardId,
      exists,
      manageable: exists,
      title: exists ? "Lights" : "",
    }),
    createReward: async (input) => ({
      ok: true,
      rewardId: `managed-${++creates}`,
      title: input.title,
      cost: input.cost,
      manageable: true,
    }),
    revokeToken: async () => ({ ok: true }),
  };
  const provider = createTwitchOAuthProvider({ api, now: () => now });
  await provider.configure({ clientId: "clientid12345" });
  await provider.begin();
  now += 1000;
  await provider.poll();
  assert.equal(
    (
      await provider.createReward({
        purpose: "lights",
        title: "Lights",
        cost: 100,
      })
    ).rewardId,
    "managed-1",
  );
  exists = false;
  now += 31000;
  await provider.ensureStatus();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(provider.status().managedRewards, []);
  assert.equal(
    (
      await provider.createReward({
        purpose: "lights",
        title: "Lights Again",
        cost: 100,
      })
    ).rewardId,
    "managed-2",
  );
});

test("transient refresh failure retains the grant for a later retry", async () => {
  let now = 1000;
  let refreshes = 0;
  let validations = 0;
  const api = {
    beginDeviceAuthorization: async (input) => ({
      ok: true,
      deviceCode: "device",
      userCode: "CODE",
      verificationUri: "https://www.twitch.tv/activate",
      scopes: input.scopes,
      expiresIn: 600,
      interval: 1,
    }),
    pollDeviceAuthorization: async () => ({
      ok: true,
      pending: false,
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 1,
    }),
    refreshUserAccessToken: async () =>
      ++refreshes === 1
        ? { ok: false, error: "twitch_network_unavailable", status: 0 }
        : {
            ok: true,
            accessToken: "access-2",
            refreshToken: "refresh-2",
            expiresIn: 14400,
          },
    validateToken: async () => ({
      ok: true,
      clientId: "clientid12345",
      userId: "user-1",
      login: "streamer",
      scopes: ["channel:manage:redemptions"],
      expiresIn: ++validations === 1 ? 1 : 14400,
    }),
    inspectReward: async (input) => ({
      ok: true,
      rewardId: input.rewardId,
      exists: true,
      manageable: true,
      title: "Lights",
    }),
    revokeToken: async () => ({ ok: true }),
  };
  const provider = createTwitchOAuthProvider({ api, now: () => now });
  await provider.configure({ clientId: "clientid12345" });
  await provider.begin();
  now += 1000;
  await provider.poll();
  now += 1001;
  assert.equal((await provider.inspectReward({ rewardId: "reward" })).retryable, true);
  assert.equal((await provider.inspectReward({ rewardId: "reward" })).ok, true);
  assert.equal(refreshes, 2);
});

test("OAuth provider reports and enforces missing Twitch scopes", async () => {
  let now = 1000;
  const api = {
    beginDeviceAuthorization: async (input) => ({
      ok: true,
      deviceCode: "device",
      userCode: "CODE",
      verificationUri: "https://www.twitch.tv/activate",
      scopes: input.scopes,
      expiresIn: 600,
      interval: 1,
    }),
    pollDeviceAuthorization: async () => ({
      ok: true,
      pending: false,
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 14400,
    }),
    validateToken: async () => ({
      ok: true,
      clientId: "clientid12345",
      userId: "user-1",
      login: "streamer",
      scopes: [],
      expiresIn: 14400,
    }),
    revokeToken: async () => ({ ok: true }),
    sendChat: async () => ({ ok: true }),
  };
  const provider = createTwitchOAuthProvider({ api, now: () => now });
  await provider.configure({ clientId: "clientid12345" });
  await provider.begin();
  now += 1000;
  const connected = await provider.poll();
  assert.deepEqual(connected.scopes, []);
  assert.deepEqual(connected.missingScopes, connected.requiredScopes);
  assert.equal((await provider.sendChat({ message: "hello" })).error, "twitch_scope_missing");
  assert.equal(provider.status().eventSub.lifecycle, "stopped");
});

test("OAuth provider revalidates an active Twitch session hourly", async () => {
  let now = 1000;
  let validations = 0;
  const api = {
    beginDeviceAuthorization: async (input) => ({
      ok: true,
      deviceCode: "device",
      userCode: "CODE",
      verificationUri: "https://www.twitch.tv/activate",
      scopes: input.scopes,
      expiresIn: 600,
      interval: 1,
    }),
    pollDeviceAuthorization: async () => ({
      ok: true,
      pending: false,
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 14400,
    }),
    validateToken: async () => {
      validations += 1;
      return {
        ok: true,
        clientId: "clientid12345",
        userId: "user-1",
        login: "streamer",
        scopes: ["channel:manage:redemptions"],
        expiresIn: 14400,
      };
    },
    revokeToken: async () => ({ ok: true }),
  };
  const provider = createTwitchOAuthProvider({ api, now: () => now });
  await provider.configure({ clientId: "clientid12345" });
  await provider.begin();
  now += 1000;
  await provider.poll();
  await provider.ensureStatus();
  assert.equal(validations, 1);
  now += 60 * 60 * 1000;
  await provider.ensureStatus();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(validations, 2);
});

test("OAuth provider isolates reward transport while keeping authorized chat commands active", async () => {
  let now = 1000;
  const modes = [];
  const monitorCalls = { start: 0, restart: 0, stop: 0 };
  let subscriptionConfig;
  const api = {
    beginDeviceAuthorization: async (input) => ({
      ok: true,
      deviceCode: "device",
      userCode: "CODE",
      verificationUri: "https://www.twitch.tv/activate",
      scopes: input.scopes,
      expiresIn: 600,
      interval: 1,
    }),
    pollDeviceAuthorization: async () => ({
      ok: true,
      pending: false,
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 14400,
    }),
    validateToken: async () => ({
      ok: true,
      clientId: "clientid12345",
      userId: "user-1",
      login: "streamer",
      scopes: ["channel:manage:redemptions", "user:read:chat"],
      expiresIn: 14400,
    }),
    createEventSubSubscription: async () => ({ ok: true }),
    revokeToken: async () => ({ ok: true }),
  };
  const provider = createTwitchOAuthProvider({
    api,
    now: () => now,
    onIntakeModeChange: (mode) => modes.push(mode),
    eventSubMonitorFactory: (options) => {
      subscriptionConfig = options.getSubscriptionConfig;
      return {
        start: () => {
          monitorCalls.start += 1;
        },
        restart: () => {
          monitorCalls.restart += 1;
        },
        stop: () => {
          monitorCalls.stop += 1;
        },
        status: () => ({
          lifecycle: "stopped",
          connected: false,
          subscriptions: [],
        }),
      };
    },
  });
  assert.equal(provider.status().monitorConfig.intakeMode, "native");
  await provider.configure({ clientId: "clientid12345" });
  await provider.begin();
  now += 1000;
  await provider.poll();
  assert.ok(monitorCalls.start >= 1);

  const widget = await provider.configureMonitor({
    intakeMode: "streamelements",
    songRequestChatEnabled: true,
    commandPermissions: { volume: { vip: true }, removeAny: { viewer: false } },
  });
  assert.equal(widget.monitorConfig.intakeMode, "streamelements");
  assert.equal(widget.monitorConfig.songRequestChatEnabled, false);
  assert.equal(subscriptionConfig().chat, true);
  assert.equal(subscriptionConfig().redemptions, false);
  assert.ok(monitorCalls.stop >= 1);
  const native = await provider.configureMonitor({
    intakeMode: "native",
    songRequestChatEnabled: true,
  });
  assert.equal(native.monitorConfig.intakeMode, "native");
  assert.equal(
    native.monitorConfig.commandPermissions.volume.vip,
    true,
    "changing intake keeps explicit command grants",
  );
  assert.equal(native.monitorConfig.commandPermissions.volume.viewer, false);
  assert.equal(native.monitorConfig.commandPermissions.removeAny.viewer, false);
  assert.equal(monitorCalls.restart, 2);
  assert.equal(subscriptionConfig().redemptions, true);
  assert.deepEqual(modes.slice(-2), ["streamelements", "native"]);
});

test("OAuth provider refreshes the bounded VIP and moderator directory and accepts chat badge corrections", async () => {
  let now = 1000;
  let lists = 0;
  const scopes = [
    "channel:manage:redemptions",
    "channel:read:vips",
    "moderation:read",
    "user:read:chat",
    "user:write:chat",
  ];
  const api = {
    beginDeviceAuthorization: async (input) => ({
      ok: true,
      deviceCode: "device",
      userCode: "CODE",
      verificationUri: "https://www.twitch.tv/activate",
      scopes: input.scopes,
      expiresIn: 600,
      interval: 1,
    }),
    pollDeviceAuthorization: async () => ({
      ok: true,
      pending: false,
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 14400,
    }),
    validateToken: async () => ({
      ok: true,
      clientId: "clientid12345",
      userId: "broadcaster",
      login: "streamer",
      scopes,
      expiresIn: 14400,
    }),
    listRequesterRoles: async () => {
      lists += 1;
      return {
        ok: true,
        moderators: ["mod-user", "both-user"],
        vips: ["vip-user", "both-user"],
      };
    },
    createEventSubSubscription: async () => ({ ok: true }),
    revokeToken: async () => ({ ok: true }),
  };
  const provider = createTwitchOAuthProvider({
    api,
    now: () => now,
    eventSubMonitorFactory: () => ({
      start() {},
      restart() {},
      stop() {},
      status: () => ({
        lifecycle: "stopped",
        connected: false,
        subscriptions: [],
      }),
    }),
  });
  await provider.configure({ clientId: "clientid12345" });
  await provider.begin();
  now += 1000;
  await provider.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lists, 1);
  assert.equal((await provider.resolveRequesterRole("broadcaster")).role, "moderator");
  assert.equal((await provider.resolveRequesterRole("mod-user")).role, "moderator");
  assert.equal((await provider.resolveRequesterRole("vip-user")).role, "vip");
  assert.deepEqual(provider.status().roleDirectory.moderators, 2);
  assert.deepEqual(provider.status().roleDirectory.vips, 1);

  provider.observeRequesterRole("vip-user", "moderator");
  provider.observeRequesterRole("departed-user", "vip");
  assert.equal((await provider.resolveRequesterRole("vip-user")).role, "moderator");
  assert.equal((await provider.resolveRequesterRole("departed-user")).role, "vip");
  provider.observeRequesterRole("departed-user", "viewer");
  assert.equal((await provider.resolveRequesterRole("departed-user")).role, "viewer");

  now += 30 * 60 * 1000 + 1;
  await provider.resolveRequesterRole("unknown-user");
  assert.equal(lists, 2);
});

test("background Twitch refresh failures remain provider state instead of process rejections", async () => {
  let now = 1000;
  const scopes = ["channel:manage:redemptions", "channel:read:vips", "moderation:read"];
  const provider = createTwitchOAuthProvider({
    now: () => now,
    api: {
      beginDeviceAuthorization: async (input) => ({
        ok: true,
        deviceCode: "device",
        userCode: "CODE",
        verificationUri: "https://www.twitch.tv/activate",
        scopes: input.scopes,
        expiresIn: 600,
        interval: 1,
      }),
      pollDeviceAuthorization: async () => ({
        ok: true,
        pending: false,
        accessToken: "access",
        refreshToken: "refresh",
        expiresIn: 14400,
      }),
      validateToken: async () => ({
        ok: true,
        clientId: "clientid12345",
        userId: "broadcaster",
        login: "streamer",
        scopes,
        expiresIn: 14400,
      }),
      listRequesterRoles: async () => {
        throw Object.assign(new Error("role endpoint offline"), {
          code: "ROLE_NETWORK",
        });
      },
      revokeToken: async () => ({ ok: true }),
    },
  });
  await provider.configure({ clientId: "clientid12345" });
  await provider.begin({ scopes });
  now += 1000;
  assert.equal((await provider.poll()).connected, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.status().lastError, "ROLE_NETWORK");
  assert.equal(provider.status().connected, true);
});
