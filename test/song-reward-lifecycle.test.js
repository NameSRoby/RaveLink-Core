const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createJournal = require("../src/capabilities/feature-platform/providers/twitch-transaction-journal");
const createTransactions = require("../src/capabilities/feature-platform/providers/twitch-transactions");
const {
  createSystemWidgetEventController,
} = require("../src/domains/system/widget-event.controller");
const { createFeatureRuntimeHarness } = require("./support/feature-runtime-harness");
const feature = require("../features/song-request/dist/main");
async function until(predicate) {
  const end = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > end) throw Error("expected settlement did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-rewards-"));
  const filename = path.join(root, "transactions.json"),
    storage = new Map(),
    settlements = [],
    chats = [];
  const profile = { userId: "streamer", managedRewards: { song_request: { rewardId: "songs" } } };
  let transactions, controller;
  const harness = createFeatureRuntimeHarness(feature, {
    providers: {
      "ravelink.storage.v1/get": async ({ key }) => ({
        ok: true,
        found: storage.has(key),
        value: structuredClone(storage.get(key)),
      }),
      "ravelink.storage.v1/set": async ({ key, value }) => {
        storage.set(key, structuredClone(value));
        return { ok: true };
      },
      "twitch.rewards.manage.v1/song-outcome": (input) => transactions.songOutcome(input),
      "twitch.chat.send.v1/send": async ({ message }) => {
        chats.push(message);
        return { ok: true };
      },
      "youtube.catalog.host.v1/resolve": async ({ videoId }) => ({
        ok: true,
        candidate: {
          provider: "youtube",
          providerItemId: videoId,
          title: "Test song",
          artists: ["Test artist"],
          durationMs: 180000,
        },
      }),
    },
  });
  function restartTransactions() {
    transactions = createTransactions({
      journal: createJournal({ filename }),
      getProfile: () => profile,
      withAuthorization: (operation) => operation({}),
      api: {
        settleRedemption: async (input) => {
          settlements.push(input);
          return { ok: true, status: input.status, refunded: input.status === "CANCELED" };
        },
      },
      onRedemption: (event) =>
        controller.handleWidgetEvent({
          transport: "native",
          eventEnvelope: { event },
          widgetConfig: { songRewardId: "songs" },
        }),
      sendChat: async ({ message }) => {
        chats.push(message);
        return { ok: true };
      },
    });
  }
  restartTransactions();
  controller = createSystemWidgetEventController({
    getTwitchIntakeMode: () => "native",
    submitSongRequest: async (input) => ({
      ok: true,
      value: await harness.request("song.queue.submit.v1", "submit", input),
    }),
    settleRedemption: (input) => transactions.settle(input),
  });
  await harness.start();
  t.after(async () => {
    await harness.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await harness.request("song.queue.admin.v1", "configure", {
    responses: { queued: true, remove_succeeded: true },
  });
  const redeem = (id = "redemption-one") =>
    transactions.receiveRedemption({
      id,
      user_id: "viewer",
      user_name: "Viewer",
      broadcaster_user_id: "streamer",
      redeemed_at: new Date().toISOString(),
      status: "UNFULFILLED",
      user_input: "https://youtu.be/dQw4w9WgXcQ",
      reward: { id: "songs" },
    });
  const pull = async () => {
    await harness.request("song.queue.admin.v1", "moderate", { action: "playback_start" });
    return (
      await harness.request("song.playback.driver.v1", "pull", {
        driverId: "test",
        providers: ["youtube"],
      })
    ).action;
  };
  return {
    harness,
    settlements,
    chats,
    redeem,
    pull,
    restartTransactions,
    storage,
    outcome: (input) => transactions.songOutcome(input),
  };
}

test("reward acceptance stays pending; artist is announced; !remove during loading refunds once across journal restart", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.redeem()).body.settlement.pending, true);
  assert.equal(f.settlements.length, 0);
  assert(f.chats.some((text) => text.includes("Test song - Test artist")));
  await f.pull();
  f.restartTransactions();
  const removed = await f.harness.request("song.queue.submit.v1", "self", {
    action: "remove",
    requesterId: "viewer",
    notifyChat: true,
  });
  assert.equal(removed.ok, true);
  await until(() => f.chats.some((text) => /points were refunded/i.test(text)));
  assert.equal(f.settlements.length, 1);
  assert.equal(f.settlements[0].status, "CANCELED");
  assert.equal(f.chats.filter((text) => /points were refunded/i.test(text)).length, 1);
  await f.outcome({ requestId: "redemption-one", status: "CANCELED", requesterName: "Viewer" });
  assert.equal(f.settlements.length, 1);
  assert.equal(f.chats.filter((text) => /points were refunded/i.test(text)).length, 1);
});

test("actual start fulfills once; progress, replay and later skip cannot refund an already played request", async (t) => {
  const f = await fixture(t);
  await f.redeem();
  const action = await f.pull();
  for (const state of ["started", "progress", "skipped"])
    assert.equal(
      (
        await f.harness.request("song.playback.driver.v1", "acknowledge", {
          driverId: "test",
          leaseId: action.leaseId,
          state,
        })
      ).ok,
      true,
    );
  await until(() => f.settlements.length === 1);
  assert.deepEqual(
    f.settlements.map((row) => row.status),
    ["FULFILLED"],
  );
  assert.equal((await f.redeem()).duplicate, true);
  assert.equal(
    (await f.outcome({ requestId: "unrelated-chat-request", status: "CANCELED" })).ignored,
    true,
  );
});

test("failure before start refunds", async (t) => {
  const f = await fixture(t);
  await f.redeem();
  const action = await f.pull();
  await f.harness.request("song.playback.driver.v1", "acknowledge", {
    driverId: "test",
    leaseId: action.leaseId,
    state: "failed",
  });
  await until(() => f.settlements.length === 1);
  assert.deepEqual(
    f.settlements.map((row) => row.status),
    ["CANCELED"],
  );
});

test("failure after actual playback cannot refund the completed reward", async (t) => {
  const f = await fixture(t);
  await f.redeem();
  const action = await f.pull();
  for (const state of ["started", "failed"])
    await f.harness.request("song.playback.driver.v1", "acknowledge", {
      driverId: "test",
      leaseId: action.leaseId,
      state,
    });
  await until(() => f.settlements.length === 1);
  assert.deepEqual(
    f.settlements.map((row) => row.status),
    ["FULFILLED"],
  );
  assert.equal(
    f.chats.some((text) => /were refunded/i.test(text)),
    false,
  );
});

test("maximum outcome history uses bounded IPC pages and rewrites only a changed page", async () => {
  const createStorage = require("../features/song-request/dist/reward-outcome-storage");
  const saved = new Map();
  let writes = 0;
  const context = {
    callCapability: async (_cap, method, payload) => {
      assert(Buffer.byteLength(JSON.stringify(payload)) < 60000);
      if (method === "set") {
        writes++;
        saved.set(payload.key, structuredClone(payload.value));
      }
      return { ok: true, value: structuredClone(saved.get(payload.key)) };
    },
  };
  const rows = new Map(
    Array.from({ length: 1000 }, (_, index) => [
      String(index),
      {
        id: String(index) + "a".repeat(150),
        requestId: "\u66f2".repeat(160),
        requesterLabel: "\u97f3".repeat(80),
        status: "CANCELED",
        delivered: false,
      },
    ]),
  );
  const storage = createStorage(context, "outcomes");
  await storage.load();
  await storage.store(rows);
  assert.equal(writes, 41);
  rows.get("12").delivered = true;
  await storage.store(rows);
  assert.equal(writes, 42);
  const restored = await createStorage(context, "outcomes").load();
  assert.deepEqual(restored, [...rows.values()]);
});

test("durable outcomes retry after restart without reversing or repeating a delivered decision", async (t) => {
  const createOutcomes = require("../features/song-request/dist/reward-outcomes");
  const storage = new Map(),
    sent = [];
  let connected = false;
  const context = {
    callCapability: async (cap, method, payload) => {
      if (cap === "ravelink.storage.v1") {
        if (method === "set") storage.set(payload.key, structuredClone(payload.value));
        return { ok: true, value: structuredClone(storage.get(payload.key)) };
      }
      if (!connected) return { ok: false, error: "twitch_not_connected" };
      sent.push(payload);
      return { ok: true };
    },
  };
  const first = createOutcomes({ context });
  await first.load();
  const entry = { id: "entry", requestId: "reward", requesterLabel: "Viewer" };
  await first.record(entry);
  await first.decide(entry, "CANCELED");
  assert.equal(sent.length, 0);
  await first.stop();
  const second = createOutcomes({ context });
  await second.load();
  t.after(() => second.stop());
  connected = true;
  await second.flush();
  await second.decide(entry, "FULFILLED");
  await second.flush();
  assert.deepEqual(
    sent.map((row) => row.status),
    ["CANCELED"],
  );
});

test("desktop handoff never fulfills; exact observed desktop occurrence does", async (t) => {
  const f = await fixture(t);
  const createOutcomes = require("../features/song-request/dist/reward-outcomes");
  const createDesktop = require("../features/song-request/dist/desktop-chat-responses");
  const context = {
    callCapability: async (cap, method, payload) => {
      if (cap === "ravelink.storage.v1") {
        if (method === "set") f.storage.set(payload.key, structuredClone(payload.value));
        return { ok: true, value: f.storage.get(payload.key) };
      }
      if (cap === "twitch.rewards.manage.v1") return f.outcome(payload);
      return { ok: true, current: { uid: "owned", entryId: "native-entry", paused: false } };
    },
  };
  await f.redeem();
  const outcomes = createOutcomes({ context });
  await outcomes.load();
  t.after(() => outcomes.stop());
  const entry = {
    id: "native-entry",
    requestId: "redemption-one",
    requesterLabel: "Viewer",
    chatNotify: true,
    candidate: { provider: "tidal", title: "Native song", artists: ["Artist"] },
  };
  await outcomes.record(entry);
  const desktop = createDesktop({
    context,
    send() {},
    started: (row) => outcomes.decide(row, "FULFILLED"),
  });
  await desktop.record(entry);
  await desktop.observe({ provider: "tidal", status: "paused" });
  assert.equal(f.settlements.length, 0);
  await desktop.observe({ provider: "tidal", status: "playing" });
  await desktop.observe({ provider: "tidal", status: "playing" });
  await until(() => f.settlements.length === 1);
  assert.deepEqual(
    f.settlements.map((row) => row.status),
    ["FULFILLED"],
  );
});
