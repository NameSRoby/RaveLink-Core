const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createSystemWidgetEventController,
  MAX_DEDUPE_ENTRIES,
} = require("../src/domains/system/widget-event.controller");

function event(id, rewardId, input = "teal", user = "viewer", broadcasterId = "") {
  return {
    detail: {
      listener: "redemption-latest",
      event: {
        redemption: {
          id,
          user_input: input,
          user_name: user,
          broadcaster_id: broadcasterId,
          reward: { id: rewardId },
        },
      },
    },
  };
}

test("Rave saves acknowledge once through the existing lighting reward and failed saves refund", async () => {
  let failed = false;
  const chats = [],
    settlements = [];
  const controller = createSystemWidgetEventController({
    getTwitchIntakeMode: () => "native",
    colorApply: async () => ({
      status: failed ? 400 : 200,
      body: {
        ok: !failed,
        effect: "rave-remember",
        message: "Saved song.",
        ...(failed ? { error: "music_song_already_saved", refundRecommended: true } : {}),
      },
    }),
    sendChat: async (payload) => {
      chats.push(payload);
      return { ok: true };
    },
    settleRedemption: async (payload) => {
      settlements.push(payload);
      return { ok: true, status: payload.status };
    },
  });
  const request = {
    transport: "native",
    widgetConfig: { colorRewardId: "lights" },
    eventEnvelope: event("remember-one", "lights", "rave remember Artist - Song"),
  };
  assert.equal((await controller.handleWidgetEvent(request)).body.status, "FULFILLED");
  assert.equal((await controller.handleWidgetEvent(request)).body.duplicate, true);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].message, "Saved song.");
  failed = true;
  assert.equal(
    (
      await controller.handleWidgetEvent({
        ...request,
        eventEnvelope: event("remember-two", "lights", "rave remember Artist - Song"),
      })
    ).body.status,
    "CANCELED",
  );
  assert.equal(settlements[1].status, "CANCELED");
  assert.equal(chats.length, 2);
});

test("Add to playlist widget route preserves viewer identity and uses the community submission flag", async () => {
  const calls = [];
  const controller = createSystemWidgetEventController({
    submitSongRequest: async (payload) => {
      calls.push(payload);
      return { ok: true, value: { ok: true, code: "accepted" } };
    },
  });
  const result = await controller.handleWidgetEvent({
    transport: "streamelements",
    widgetConfig: { playlistRewardId: "community" },
    eventEnvelope: event("community-one", "community", "Artist Song"),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].addToPlaylist, true);
  assert.equal(calls[0].query, "Artist Song");
  assert.equal(calls[0].requestId, "community-one");
  assert.equal(calls[0].requesterRole, "viewer");
  assert.equal(result.body.action, "add_to_playlist");
});

test("partial lighting fulfills once with an explicit degraded outcome while total failure refunds", async () => {
  const settlements = [];
  let failed = false,
    applied = 0;
  const controller = createSystemWidgetEventController({
    getTwitchIntakeMode: () => "native",
    colorApply: async () => {
      applied++;
      return {
        status: 200,
        body: failed
          ? { ok: false, sent: 0, failed: 2, error: "hardware_delivery_failed" }
          : { ok: true, sent: 1, failed: 1, partial: true },
      };
    },
    settleRedemption: async (payload) => {
      settlements.push(payload);
      return { ok: true, status: payload.status };
    },
  });
  const payload = {
    transport: "native",
    widgetConfig: { colorRewardId: "lights" },
    eventEnvelope: event("partial", "lights"),
  };
  const partial = await controller.handleWidgetEvent(payload);
  assert.equal(partial.body.status, "FULFILLED");
  assert.equal(partial.body.degraded, true);
  assert.deepEqual(partial.body.degradedCapabilities, ["lighting"]);
  assert.equal(settlements[0].reason, "lighting_delivery_partial");
  assert.equal((await controller.handleWidgetEvent(payload)).body.duplicate, true);
  assert.equal(applied, 1);
  assert.equal(settlements.length, 1);
  failed = true;
  const total = await controller.handleWidgetEvent({
    ...payload,
    eventEnvelope: event("failed", "lights"),
  });
  assert.equal(total.body.status, "CANCELED");
  assert.equal(settlements[1].status, "CANCELED");
});

test("Rave-busy redemptions are canceled for refund once, including duplicate delivery", async () => {
  const settlements = [];
  const controller = createSystemWidgetEventController({
    getTwitchIntakeMode: () => "native",
    colorApply: async () => ({
      status: 400,
      body: { ok: false, error: "music_rave_active", refundRecommended: true, sent: 0, failed: 0 },
    }),
    settleRedemption: async (payload) => {
      settlements.push(payload);
      return { ok: true, status: payload.status };
    },
  });
  const payload = {
    transport: "native",
    widgetConfig: { colorRewardId: "lights" },
    eventEnvelope: event("rave-busy", "lights", "red"),
  };
  const result = await controller.handleWidgetEvent(payload);
  assert.equal(result.body.desiredStatus, "CANCELED");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].status, "CANCELED");
  assert.equal((await controller.handleWidgetEvent(payload)).body.duplicate, true);
  assert.equal(settlements.length, 1);
});

test("only the selected Twitch intake transport reaches reward handling", async () => {
  let applied = 0;
  const controller = createSystemWidgetEventController({
    getTwitchIntakeMode: () => "native",
    colorApply: async () => {
      applied += 1;
      return { status: 200, body: { ok: true } };
    },
  });
  const payload = {
    widgetConfig: { colorRewardId: "reward-color" },
    eventEnvelope: event("transport-test", "reward-color", "red"),
  };

  const widget = await controller.handleWidgetEvent(payload);
  assert.equal(widget.body.reason, "intake_transport_disabled");
  assert.equal(widget.body.activeTransport, "native");
  assert.equal(applied, 0);

  const native = await controller.handleWidgetEvent({
    ...payload,
    transport: "native",
  });
  assert.equal(native.body.handled, true);
  assert.equal(applied, 1);
});

test("native Twitch EventSub redemption fields retain command and settlement identity", async () => {
  let applied;
  let settled;
  const controller = createSystemWidgetEventController({
    getTwitchIntakeMode: () => "native",
    colorApply: async (payload) => {
      applied = payload;
      return { status: 200, body: { ok: true } };
    },
    settleRedemption: async (payload) => {
      settled = payload;
      return { ok: true, status: payload.status };
    },
  });

  const result = await controller.handleWidgetEvent({
    transport: "native",
    widgetConfig: { colorRewardId: "managed-lights" },
    eventEnvelope: {
      event: {
        id: "redemption-native-1",
        broadcaster_user_id: "broadcaster-1",
        user_id: "viewer-1",
        user_name: "Viewer",
        user_input: "light red 70%",
        reward: { id: "managed-lights", title: "Change Lights" },
      },
    },
  });

  assert.equal(result.body.handled, true);
  assert.equal(result.body.status, "FULFILLED");
  assert.equal(applied.text, "light red 70%");
  assert.deepEqual(settled, {
    redemptionId: "redemption-native-1",
    rewardId: "managed-lights",
    broadcasterId: "broadcaster-1",
    status: "FULFILLED",
    reason: "action_succeeded",
  });
});

test("widget controller applies a color without OAuth or engine services", async () => {
  let seen;
  const controller = createSystemWidgetEventController({
    colorApply: async (payload) => {
      seen = payload;
      return { status: 200, body: { ok: true } };
    },
    dedupeStore: new Map(),
  });
  const result = await controller.handleWidgetEvent({
    widgetConfig: { colorRewardId: "reward-color" },
    eventEnvelope: event("color-1", "reward-color"),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.action, "color");
  assert.equal(seen.text, "teal");
  assert.deepEqual(result.body.actions, []);
});

test("direct StreamElements redemption events preserve Twitch user input", async () => {
  let seen;
  const controller = createSystemWidgetEventController({
    colorApply: async (payload) => {
      seen = payload;
      return { status: 200, body: { ok: true } };
    },
    dedupeStore: new Map(),
  });
  const result = await controller.handleWidgetEvent({
    widgetConfig: { colorRewardId: "reward-color" },
    eventEnvelope: {
      detail: {
        listener: "redemption-latest",
        event: {
          id: "direct-redemption",
          user_input: "light red 70%",
          reward: { id: "reward-color", title: "Change Lights" },
        },
      },
    },
  });
  assert.equal(result.body.action, "color");
  assert.equal(seen.text, "light red 70%");
});

test("widget reward matching retains capitalization, spacing, and guarded typo tolerance", async () => {
  const controller = createSystemWidgetEventController({
    dedupeStore: new Map(),
  });
  const config = controller.normalizeWidgetConfig({
    colorRewardId: "Change Lights",
  });
  assert.equal(
    controller.resolveRewardAction({ rewardId: "change-ligths", rewardName: "" }, config),
    "color",
  );
  assert.equal(
    controller.resolveRewardAction({ rewardId: "CHANGE   LIGHTS", rewardName: "" }, config),
    "color",
  );
  assert.equal(
    controller.resolveRewardAction({ rewardId: "completely unrelated", rewardName: "" }, config),
    "",
  );
  const idConfig = controller.normalizeWidgetConfig({
    colorRewardId: "1234567890abcdef1234",
  });
  assert.equal(
    controller.resolveRewardAction({ rewardId: "1234567890abcdef1235", rewardName: "" }, idConfig),
    "",
  );
});

test("widget teach failures remain conveyor-only", async () => {
  const controller = createSystemWidgetEventController({
    teachColor: async () => ({
      status: 400,
      body: { ok: false, reason: "already_exists", refundRecommended: true },
    }),
    dedupeStore: new Map(),
  });
  const result = await controller.handleWidgetEvent({
    widgetConfig: { teachRewardId: "reward-teach" },
    eventEnvelope: event("teach-1", "reward-teach", "ocean #00aaff", "viewerTeach"),
  });
  assert.equal(result.body.action, "teach");
  assert.equal(result.body.actions.length, 0);
  assert.equal(result.body.degraded, false);
  assert.deepEqual(result.body.degradedCapabilities, []);
  assert.equal("chatDelivery" in result.body, false);
});

test("teaching can preview successful colors and optionally explain outcomes in chat", async () => {
  const previews = [],
    messages = [];
  const success = createSystemWidgetEventController({
    teachColor: async () => ({
      status: 200,
      body: {
        ok: true,
        changed: true,
        reason: "taught",
        name: "ocean",
        hex: "#00aaff",
      },
    }),
    previewTaughtColor: async (hex) => {
      previews.push(hex);
      return { ok: true, scheduled: true };
    },
    sendChat: async (payload) => {
      messages.push(payload.message);
      return { ok: true };
    },
    getTeachSettings: () => ({
      preview: true,
      chatSuccess: true,
      chatFailure: true,
    }),
    dedupeStore: new Map(),
  });
  const taught = await success.handleWidgetEvent({
    widgetConfig: { teachRewardId: "teach" },
    eventEnvelope: event("teach-ok", "teach", "ocean #00aaff", "ColorFan"),
  });
  assert.deepEqual(previews, ["#00aaff"]);
  assert.match(messages[0], /^@ColorFan, taught ocean as #00AAFF/);
  assert.equal(taught.body.teachPreview.scheduled, true);
  assert.equal(taught.body.chatDelivery.ok, true);

  const failure = createSystemWidgetEventController({
    teachColor: async () => ({
      status: 400,
      body: {
        ok: false,
        changed: false,
        reason: "hex_exists",
        name: "ocean",
        hex: "#00aaff",
        refundRecommended: true,
      },
    }),
    sendChat: async (payload) => {
      messages.push(payload.message);
      return { ok: true };
    },
    getTeachSettings: () => ({
      preview: true,
      chatSuccess: true,
      chatFailure: true,
    }),
    dedupeStore: new Map(),
  });
  const rejected = await failure.handleWidgetEvent({
    widgetConfig: { teachRewardId: "teach" },
    eventEnvelope: event("teach-no", "teach", "other #00aaff", "ColorFan"),
  });
  assert.equal(rejected.body.desiredStatus, "CANCELED");
  assert.match(messages[1], /already saved as ocean/);
});

test("StreamElements conveys a redemption without using Twitch settlement", async () => {
  const settlements = [];
  const controller = createSystemWidgetEventController({
    colorApply: async () => ({ status: 200, body: { ok: true, sent: 2 } }),
    settleRedemption: async (payload) => {
      settlements.push(payload);
      return { ok: true, status: payload.status, refunded: false };
    },
    dedupeStore: new Map(),
  });
  const result = await controller.handleWidgetEvent({
    widgetConfig: { colorRewardId: "reward-color" },
    eventEnvelope: event(
      "redemption-1",
      "reward-color",
      "light blue 70%",
      "viewer",
      "broadcaster-1",
    ),
  });
  assert.equal(result.body.status, "NOT_APPLICABLE");
  assert.equal(result.body.settlement.ok, true);
  assert.equal(result.body.settlement.reason, "transport_conveyor_only");
  assert.deepEqual(settlements, []);
});

test("widget never claims Twitch settlement when OAuth or identity is unavailable", async () => {
  const controller = createSystemWidgetEventController({
    getTwitchIntakeMode: () => "native",
    colorApply: async () => ({
      status: 400,
      body: { ok: false, error: "no_active_fixtures" },
    }),
    settleRedemption: async () => ({
      ok: false,
      error: "twitch_not_connected",
    }),
    dedupeStore: new Map(),
  });
  const result = await controller.handleWidgetEvent({
    transport: "native",
    widgetConfig: { colorRewardId: "reward-color" },
    eventEnvelope: event("redemption-2", "reward-color", "red", "viewer", "broadcaster-1"),
  });
  assert.equal(result.body.status, "UNSETTLED");
  assert.equal(result.body.desiredStatus, "CANCELED");
  assert.equal(result.body.settlement.reason, "twitch_not_connected");
});

test("native unsupported light power commands are canceled for a channel-points refund", async () => {
  let settled;
  const controller = createSystemWidgetEventController({
    getTwitchIntakeMode: () => "native",
    colorApply: async () => ({
      status: 400,
      body: {
        ok: false,
        error: "unsupported_power_command",
        refundRecommended: true,
      },
    }),
    settleRedemption: async (payload) => {
      settled = payload;
      return {
        ok: true,
        status: payload.status,
        refunded: payload.status === "CANCELED",
      };
    },
    dedupeStore: new Map(),
  });
  const result = await controller.handleWidgetEvent({
    transport: "native",
    widgetConfig: { colorRewardId: "reward-color" },
    eventEnvelope: event("power-redemption", "reward-color", "turn off", "viewer", "broadcaster-1"),
  });
  assert.equal(result.body.result.error, "unsupported_power_command");
  assert.equal(result.body.desiredStatus, "CANCELED");
  assert.equal(result.body.status, "CANCELED");
  assert.equal(result.body.settlement.refunded, true);
  assert.equal(settled.status, "CANCELED");
});

test("native Rave rewards fulfill accepted starts and refund rejected starts", async () => {
  for (const accepted of [true, false]) {
    const settlements = [];
    const controller = createSystemWidgetEventController({
      getTwitchIntakeMode: () => "native",
      colorApply: async () => ({
        status: accepted ? 200 : 400,
        body: accepted
          ? { ok: true, effect: "rave", targets: ["light"], sent: 0, failed: 0 }
          : { ok: false, error: "music_rave_disabled" },
      }),
      settleRedemption: async (payload) => {
        settlements.push(payload);
        return { ok: true, status: payload.status, refunded: payload.status === "CANCELED" };
      },
      dedupeStore: new Map(),
    });
    const request = {
      transport: "native",
      widgetConfig: { colorRewardId: "reward-color" },
      eventEnvelope: event("rave-redemption", "reward-color", "rave", "viewer", "broadcaster-1"),
    };
    const result = await controller.handleWidgetEvent(request);
    assert.equal(result.body.desiredStatus, accepted ? "FULFILLED" : "CANCELED");
    assert.equal(result.body.settlement.refunded, !accepted);
    assert.equal((await controller.handleWidgetEvent(request)).body.duplicate, true);
    assert.equal(settlements.length, 1);
  }
});

test("StreamElements conveys Song Request input to the native resolver with no Helix settlement", async () => {
  const submissions = [];
  let settlementCalls = 0;
  const controller = createSystemWidgetEventController({
    submitSongRequest: async (payload) => {
      submissions.push(payload);
      return { ok: true, code: "accepted" };
    },
    settleRedemption: async () => {
      settlementCalls += 1;
      return { ok: true };
    },
    dedupeStore: new Map(),
  });
  const result = await controller.handleWidgetEvent({
    widgetConfig: { songRewardId: "song-reward-42" },
    eventEnvelope: event("song-widget-1", "song-reward-42", "dQw4w9WgXcQ", "viewer"),
  });
  assert.equal(result.body.action, "song_request");
  assert.equal(result.body.status, "NOT_APPLICABLE");
  assert.equal(result.body.settlement.reason, "transport_conveyor_only");
  assert.equal(submissions[0].candidate.providerItemId, "dQw4w9WgXcQ");
  assert.equal(submissions[0].notifyChat, false);
  assert.equal(settlementCalls, 0);

  const textOnly = await controller.handleWidgetEvent({
    widgetConfig: { songRewardId: "song-reward-42" },
    eventEnvelope: event("song-widget-text", "song-reward-42", "artist song title", "viewer"),
  });
  assert.equal(textOnly.body.action, "song_request");
  assert.equal(textOnly.body.status, "NOT_APPLICABLE");
  assert.equal(submissions[1].query, "artist song title");
  assert.equal(submissions[1].candidate, undefined);
  assert.equal(submissions[1].notifyChat, false);
  assert.equal(submissions.length, 2);
  assert.equal(settlementCalls, 0);

  const titleOnly = await controller.handleWidgetEvent({
    widgetConfig: { songRewardId: "song-reward-42" },
    eventEnvelope: {
      detail: {
        listener: "redemption-latest",
        event: {
          redemption: {
            id: "song-widget-2",
            user_input: "dQw4w9WgXcQ",
            user_name: "viewer",
            reward: { id: "different-id", title: "song-reward-42" },
          },
        },
      },
    },
  });
  assert.equal(titleOnly.body.handled, false);
  assert.equal(titleOnly.body.reason, "reward_not_configured");
});

test("native managed Song Request rewards enqueue YouTube and settle from the result", async () => {
  const submissions = [];
  const settlements = [];
  const controller = createSystemWidgetEventController({
    getTwitchIntakeMode: () => "native",
    submitSongRequest: async (payload) => {
      submissions.push(payload);
      return { ok: true, value: { ok: true, code: "accepted" } };
    },
    settleRedemption: async (payload) => {
      settlements.push(payload);
      return { ok: true, status: payload.status };
    },
    dedupeStore: new Map(),
  });
  const result = await controller.handleWidgetEvent({
    transport: "native",
    widgetConfig: { songRewardId: "managed-song" },
    eventEnvelope: {
      event: {
        id: "song-redemption-1",
        user_id: "viewer-42",
        user_input: "https://youtu.be/dQw4w9WgXcQ",
        reward: { id: "managed-song" },
      },
    },
  });
  assert.equal(result.body.action, "song_request");
  assert.equal(result.body.status, "FULFILLED");
  assert.equal(submissions[0].candidate.providerItemId, "dQw4w9WgXcQ");
  assert.equal(submissions[0].requesterId, "viewer-42");
  assert.equal(submissions[0].notifyChat, true);
  assert.equal(settlements[0].status, "FULFILLED");
});

test("invalid native Song Request rewards recommend and request a refund", async () => {
  let submitted = false;
  let settled;
  const controller = createSystemWidgetEventController({
    getTwitchIntakeMode: () => "native",
    submitSongRequest: async (payload) => {
      submitted = payload;
      return {
        ok: true,
        value: {
          ok: false,
          code: "rejected",
          reason: "youtube_reference_required",
        },
      };
    },
    settleRedemption: async (payload) => {
      settled = payload;
      return { ok: true, status: payload.status, refunded: true };
    },
    dedupeStore: new Map(),
  });
  const result = await controller.handleWidgetEvent({
    transport: "native",
    widgetConfig: { songRewardId: "managed-song" },
    eventEnvelope: {
      event: {
        id: "song-redemption-bad",
        user_id: "viewer-42",
        user_input: "spotify:track:123",
        reward: { id: "managed-song" },
      },
    },
  });
  assert.equal(submitted.candidate, undefined);
  assert.equal(submitted.query, "spotify:track:123");
  assert.equal(submitted.notifyChat, true);
  assert.equal(result.body.status, "CANCELED");
  assert.equal(settled.status, "CANCELED");
});

test("widget controller suppresses replayed redemption IDs", async () => {
  let calls = 0;
  const controller = createSystemWidgetEventController({
    colorApply: async () => {
      calls += 1;
      return { status: 200, body: { ok: true } };
    },
    dedupeStore: new Map(),
    now: () => 1000,
  });
  const payload = {
    widgetConfig: { colorRewardId: "reward-color" },
    eventEnvelope: event("same", "reward-color"),
  };
  const first = await controller.handleWidgetEvent(payload);
  const replay = await controller.handleWidgetEvent(payload);
  assert.equal(first.body.handled, true);
  assert.equal(replay.body.duplicate, true);
  assert.equal(calls, 1);
});

test("widget replay diagnostics stay bounded and payload-free under unique-event bursts", async () => {
  const controller = createSystemWidgetEventController({
    colorApply: async () => ({ status: 200, body: { ok: true } }),
    dedupeStore: new Map(),
    now: () => 1000,
  });
  for (let index = 0; index < MAX_DEDUPE_ENTRIES + 5; index += 1) {
    await controller.handleWidgetEvent({
      widgetConfig: { colorRewardId: "reward-color" },
      eventEnvelope: event(
        `private-viewer-event-${index}`,
        "reward-color",
        "red",
        `viewer-${index}`,
      ),
    });
  }
  const diagnostics = controller.getDiagnostics();
  assert.equal(diagnostics.dedupeEntries, MAX_DEDUPE_ENTRIES);
  assert.equal(diagnostics.counters.dedupeEvictions, 5);
  assert.equal(diagnostics.counters.received, MAX_DEDUPE_ENTRIES + 5);
  assert.equal(JSON.stringify(diagnostics).includes("private-viewer"), false);
});
