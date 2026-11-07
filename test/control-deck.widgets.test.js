const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const normalize = require("../src/domains/control-deck/deck-widget-config"),
  create = require("../src/domains/control-deck/deck-widgets.service");
test("widget layouts preserve explicit display choices and reject executable/unbounded settings", () => {
  assert.deepEqual(normalize().items, []);
  const value = normalize({
    enabled: true,
    columns: 3,
    items: [{ id: "song", type: "now-playing", artwork: false, progress: false, span: 2 }],
  });
  assert.equal(value.items[0].artwork, false);
  assert.equal(value.items[0].progress, false);
  assert.equal(value.items[0].span, 2);
  for (const bad of [
    { enabled: true, columns: 99, items: [] },
    { enabled: true, columns: 3, items: [{ id: "a", type: "script", code: "x" }] },
    { enabled: true, columns: 3, items: [{ id: "a", type: "clock", html: "<script>" }] },
  ])
    assert.throws(() => normalize(bad), /widgets_invalid/);
});
test("music status uses confirmed requester ownership, native next requests and stable idle values", () => {
  const adapt = require("../src/domains/control-deck/deck-media-status");
  const source = {
    selectedPlayer: "tidal",
    playback: {
      primary: {
        provider: "tidal",
        title: "Current song",
        artists: ["Band"],
        observedAt: 1000,
        status: "playing",
        requesterKey: "private-key",
      },
    },
    queue: {
      queue: [
        { id: "q3", candidate: { provider: "tidal", title: "Later" }, requesterLabel: "Viewer C" },
      ],
      counts: { queued: 1 },
    },
    nativeStatus: {
      current: { entryId: "q1", requesterLabel: "Viewer A" },
      queueOrder: ["q2"],
      handoffs: [
        { entryId: "q1", title: "Current song" },
        { entryId: "q2", title: "Next song", requesterLabel: "Viewer B" },
      ],
    },
  };
  const value = adapt(source);
  assert.equal(value.current.requester, "Viewer A");
  assert.equal(value.next[0].requester, "Viewer B");
  assert.equal(value.next[0].title, "Next song");
  assert(!JSON.stringify(value).includes("private-key"));
  assert.deepEqual(adapt(source), value);
  source.nativeStatus.handoffs[0].title = "Another recording";
  assert.equal(adapt(source).current.requester, "");
});
test("widget accounts share cached reads, keep optional subscriber access explicit and never expose credentials", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-widgets-"));
  let calls = 0;
  const provider = {
    status: () => ({ connected: true, userId: "123", scopes: [], accessToken: "private-access" }),
    dashboardStream: async () => {
      calls++;
      return { ok: true, live: true, id: "1", startedAt: 1000, viewers: 12 };
    },
    dashboardFollowers: async () => {
      calls++;
      return { ok: true, total: 500, recent: [] };
    },
    dashboardVod: async () => ({ ok: true, videos: [{ streamId: "1", videoId: "99" }] }),
    dashboardSubscribers: async () => {
      throw Error("must not request ungranted subscriber data");
    },
  };
  const owner = create({ runtimeDir: root, getProvider: () => provider, now: () => 100000 });
  t.after(() => {
    owner.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = { widgets: { enabled: true, items: [{ type: "audience" }] }, pages: [] };
  await Promise.all([owner.refresh(config), owner.refresh(config)]);
  assert.equal(calls, 2);
  await owner.refresh(config);
  assert.equal(calls, 2);
  const state = owner.snapshot();
  assert.equal(state.twitch.followers.total, 500);
  assert.equal(state.twitch.subscribers.error, "twitch_subscriber_scope_required");
  assert(!JSON.stringify(state).includes("private-access"));
  await owner.refresh({ widgets: { enabled: false, items: [] }, pages: [] });
  assert.equal(calls, 2);
});
test("local timestamps capture the press time, survive restart, gain VOD links later and do not call Twitch writes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-moments-"));
  let now = 100000,
    writes = 0;
  const live = { ok: true, live: true, id: "123", startedAt: 90000 };
  const options = {
    runtimeDir: root,
    now: () => now,
    getStream: () => live,
    getObs: () => null,
    getMedia: () => ({ current: { title: "Song" } }),
    getProvider: () => ({
      createStreamMarker: async () => {
        writes++;
        return { ok: true, id: "m1", positionSeconds: 7, createdAt: now };
      },
    }),
    notify() {},
    refresh: async () => {
      now += 5000;
    },
  };
  const owner = require("../src/domains/control-deck/stream-timestamps")(options);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await owner.create({ description: "Great play" });
  assert.equal(result.bookmark.positionSeconds, 10);
  assert.equal(writes, 0);
  assert.equal(owner.list()[0].url, null);
  owner.associate([{ streamId: "123", videoId: "999" }]);
  assert.match(owner.list()[0].url, /videos\/999\?t=0h0m10s$/);
  const restored = require("../src/domains/control-deck/stream-timestamps")(options);
  assert.equal(restored.list()[0].description, "Great play");
  assert.equal(restored.count(), 1);
  const remote = await restored.create({ description: "Highlighter" }, true);
  assert.equal(writes, 1);
  assert.equal(remote.bookmark.positionSeconds, 7);
});
test("cancelled or offline timestamp commands never invent a bookmark", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-moment-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const owner = require("../src/domains/control-deck/stream-timestamps")({
    runtimeDir: root,
    getStream: () => null,
    getObs: () => null,
    getMedia: () => null,
    getProvider: () => null,
    refresh: async () => controller.abort(),
    notify() {},
  });
  await assert.rejects(owner.create({}, false, controller.signal), /cancelled/);
  assert.equal(owner.count(), 0);
  await assert.rejects(owner.create({}), /stream_not_live/);
  assert.equal(owner.count(), 0);
});
