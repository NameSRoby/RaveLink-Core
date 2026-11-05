const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const source = fs.readFileSync(
  path.join(__dirname, "../integrations/youtube-browser/extension/native-service.js"),
  "utf8",
);
function fixture() {
  const row = (id, selected = false) => ({
    playlistPanelVideoRenderer: {
      videoId: id,
      selected,
      title: { simpleText: "Same title" },
      longBylineText: { runs: [{ text: "Artist" }, { text: " \u2022 10m views" }] },
    },
  });
  const items = [row("aaaaaaaaaaa", true), row("bbbbbbbbbbb")];
  const queueState = {
    items,
    nextQueueItemId: 2,
    queueContextParams: "fixture-context",
    shuffleEnabled: false,
  };
  const media = { paused: true, volume: 1, currentTime: 10, duration: 180, readyState: 4 };
  const writes = [],
    requests = [];
  let beforeFetch = null;
  const queueNode = {
    queue: {
      getItems: () => queueState.items,
      store: { store: { getState: () => ({ queue: queueState }) } },
    },
    dispatch: (action) => {
      writes.push(action.type);
      if (action.type === "ADD_ITEMS")
        queueState.items.splice(action.payload.index, 0, ...action.payload.items);
      if (action.type === "REMOVE_ITEM") queueState.items.splice(action.payload, 1);
    },
  };
  const player = {
    getVideoData: () => ({ video_id: "aaaaaaaaaaa", title: "Current", author: "Artist" }),
    pauseVideo: () => {
      media.paused = true;
    },
    playVideo: async () => {
      media.paused = false;
    },
    setVolume: (value) => {
      media.volume = value / 100;
    },
  };
  const app = {
    networkManager: {
      fetch: async (endpoint, payload) => {
        requests.push({ endpoint, payload });
        if (beforeFetch) await beforeFetch();
        return { queueDatas: [{ content: row(payload.videoIds[0]) }] };
      },
    },
  };
  const document = {
    querySelector: (selector) =>
      selector === "#queue"
        ? queueNode
        : selector === "ytmusic-app"
          ? app
          : selector === "ytmusic-player"
            ? { playerApi: player }
            : selector === "ytmusic-player video, #movie_player video"
              ? media
              : null,
  };
  const context = {
    document,
    location: { origin: "https://music.youtube.com" },
    crypto: require("node:crypto").webcrypto,
    setTimeout,
  };
  vm.runInNewContext(source, context);
  const call = (command) => context.RaveLinkYouTubeNative(command);
  const command = (action, nativeDocumentId, other = {}) => ({
    id: require("node:crypto").randomUUID(),
    sessionId: "fixture-session",
    action,
    nativeDocumentId,
    expectedVideoId: "aaaaaaaaaaa",
    deadlineAt: Date.now() + 5000,
    ...other,
  });
  return {
    call,
    command,
    queueState,
    queueNode,
    app,
    writes,
    requests,
    media,
    row,
    onFetch: (fn) => {
      beforeFetch = fn;
    },
  };
}
test("native queue reads stable object handles and distinguishes identical songs", async () => {
  const f = fixture();
  f.queueState.items.push(f.row("bbbbbbbbbbb"));
  const first = await f.call({ action: "inspect" }),
    second = await f.call({ action: "inspect" });
  assert.equal(first.native.allIdentified, true);
  assert.equal(first.snapshot.queue[0].artist, "Artist");
  assert.equal(first.snapshot.queue[1].occurrenceId, second.snapshot.queue[1].occurrenceId);
  assert.notEqual(first.snapshot.queue[1].occurrenceId, first.snapshot.queue[2].occurrenceId);
  assert.equal(f.requests.length, 0, "inspection makes no backend calls");
});

test("owned request anchors insert FIFO after the current song and preserve the personal queue", async () => {
  const f = fixture();
  const initial = await f.call({ action: "inspect" });
  const documentId = initial.native.documentId;
  const first = await f.call(
    f.command("append", documentId, {
      videoId: "ccccccccccc",
      afterOccurrenceId: initial.snapshot.queue[0].occurrenceId,
    }),
  );
  assert.equal(first.ok, true);
  const second = await f.call(
    f.command("append", documentId, {
      videoId: "ccccccccccc",
      afterOccurrenceId: first.occurrenceId,
    }),
  );
  assert.equal(second.ok, true);
  assert.notEqual(first.occurrenceId, second.occurrenceId);
  const inserted = await f.call({ action: "inspect" });
  assert.deepEqual(
    Array.from(inserted.snapshot.queue, (row) => row.videoId),
    ["aaaaaaaaaaa", "ccccccccccc", "ccccccccccc", "bbbbbbbbbbb"],
  );
  const rejected = await f.call(
    f.command("append", documentId, {
      videoId: "ddddddddddd",
      afterOccurrenceId: initial.snapshot.queue[1].occurrenceId,
    }),
  );
  assert.equal(rejected.error, "native_entry_not_owned");
  await f.call(f.command("remove", documentId, { occurrenceId: first.occurrenceId }));
  const remaining = await f.call({ action: "inspect" });
  assert.deepEqual(
    Array.from(remaining.snapshot.queue, (row) => row.occurrenceId),
    [
      initial.snapshot.queue[0].occurrenceId,
      second.occurrenceId,
      initial.snapshot.queue[1].occurrenceId,
    ],
  );
});

test("compatibility ignores extra fields but rejects missing or disagreeing queue contracts without writes", async () => {
  for (const kind of [
    "missing-reader",
    "throwing-reader",
    "non-array",
    "missing-state",
    "missing-dispatch",
    "bad-counter",
    "unknown-renderer",
    "mismatch",
    "selection",
    "shuffle",
  ]) {
    const f = fixture();
    const before = await f.call({ action: "inspect" });
    if (kind === "missing-reader") delete f.queueNode.queue.getItems;
    if (kind === "throwing-reader")
      f.queueNode.queue.getItems = () => {
        throw Error("changed");
      };
    if (kind === "non-array") f.queueNode.queue.getItems = () => ({ items: [] });
    if (kind === "missing-state") f.queueNode.queue.store.store.getState = () => ({});
    if (kind === "missing-dispatch") delete f.queueNode.dispatch;
    if (kind === "bad-counter") f.queueState.nextQueueItemId = {};
    if (kind === "unknown-renderer") f.queueState.items[1] = { futureRenderer: {} };
    if (kind === "mismatch") f.queueNode.queue.getItems = () => [f.row("ccccccccccc", true)];
    if (kind === "selection") f.queueState.items[0].playlistPanelVideoRenderer.selected = false;
    if (kind === "shuffle") f.queueState.shuffleEnabled = true;
    const observed = await f.call({ action: "inspect" });
    assert.equal(observed.ok, true, kind);
    assert.equal(observed.native.compatibility.queueReady, false, kind);
    assert.ok(observed.native.compatibility.reasons.length > 0, kind);
    assert.equal(
      (await f.call(f.command("append", before.native.documentId, { videoId: "bbbbbbbbbbb" })))
        .error,
      "native_queue_unavailable",
      kind,
    );
    assert.equal(f.requests.length, 0, kind);
    assert.equal(f.writes.length, 0, kind);
    assert.equal(
      (await f.call(f.command("volume", before.native.documentId, { value: 50 }))).ok,
      true,
      "queue incompatibility must leave independent player controls usable",
    );
  }
  const f = fixture();
  f.queueState.futureOptionalField = { enabled: true };
  f.queueState.items[0].playlistPanelVideoRenderer.futureMetadata = "harmless";
  const read = await f.call({ action: "inspect" });
  assert.equal(read.native.compatibility.queueReady, true);
  assert.equal(
    (await f.call(f.command("append", read.native.documentId, { videoId: "bbbbbbbbbbb" }))).ok,
    true,
  );
});

test("unexpected backend schema latches queue edits without retrying or disabling playback", async () => {
  const f = fixture(),
    before = await f.call({ action: "inspect" });
  let calls = 0;
  f.app.networkManager.fetch = async () => {
    calls++;
    return { futureQueueResponse: [] };
  };
  assert.equal(
    (await f.call(f.command("append", before.native.documentId, { videoId: "bbbbbbbbbbb" }))).error,
    "native_schema_changed",
  );
  const read = await f.call({ action: "inspect" });
  assert.equal(read.native.compatibility.blocked, true);
  assert.ok(read.native.compatibility.reasons.includes("queue_response_changed"));
  assert.equal(
    (await f.call(f.command("append", before.native.documentId, { videoId: "bbbbbbbbbbb" }))).error,
    "native_queue_unavailable",
  );
  assert.equal(calls, 1);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.call(f.command("pause", before.native.documentId))).ok, true);
});

test("an exception after mutation blocks subsequent queue edits instead of assuming failure had no effect", async () => {
  const f = fixture(),
    before = await f.call({ action: "inspect" });
  const dispatch = f.queueNode.dispatch;
  f.queueNode.dispatch = (action) => {
    dispatch(action);
    throw Error("post-mutation failure");
  };
  assert.equal(
    (await f.call(f.command("append", before.native.documentId, { videoId: "bbbbbbbbbbb" }))).error,
    "control_unconfirmed",
  );
  assert.equal(f.queueState.items.length, 3, "mutation actually happened");
  assert.equal((await f.call({ action: "inspect" })).native.compatibility.blocked, true);
  assert.equal(
    (await f.call(f.command("append", before.native.documentId, { videoId: "bbbbbbbbbbb" }))).error,
    "native_queue_unavailable",
  );
  assert.equal(f.writes.length, 1);
});

test("a silently ignored queue action latches after the observation deadline", async () => {
  const f = fixture(),
    before = await f.call({ action: "inspect" });
  f.queueNode.dispatch = () => {};
  assert.equal(
    (
      await f.call(
        f.command("append", before.native.documentId, {
          videoId: "bbbbbbbbbbb",
          deadlineAt: Date.now() + 120,
        }),
      )
    ).error,
    "control_unconfirmed",
  );
  assert.ok(
    (await f.call({ action: "inspect" })).native.compatibility.reasons.includes(
      "queue_write_unconfirmed",
    ),
  );
  assert.equal(f.queueState.items.length, 2);
});
test("native insertion calls one allowlisted backend operation, preserves order and removes only owned duplicates", async () => {
  const f = fixture(),
    before = await f.call({ action: "inspect" });
  const doc = before.native.documentId;
  const append = f.command("append", doc, { videoId: "bbbbbbbbbbb" });
  const one = await f.call(append),
    two = await f.call(f.command("append", doc, { videoId: "bbbbbbbbbbb" }));
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.notEqual(one.occurrenceId, two.occurrenceId);
  assert.equal((await f.call(append)).occurrenceId, one.occurrenceId);
  assert.equal(f.requests.length, 2, "replayed command must not fetch/insert again");
  assert.equal(f.requests[0].endpoint, "/music/get_queue");
  assert.deepEqual(Array.from(f.requests[0].payload.videoIds), ["bbbbbbbbbbb"]);
  const unowned = await f.call(
    f.command("remove", doc, { occurrenceId: before.snapshot.queue[1].occurrenceId }),
  );
  assert.equal(unowned.error, "native_entry_not_owned");
  assert.equal(
    (await f.call(f.command("remove", doc, { occurrenceId: one.occurrenceId }))).ok,
    true,
  );
  const after = await f.call({ action: "inspect" });
  assert.deepEqual(
    Array.from(after.snapshot.queue.slice(0, 2), (row) => row.occurrenceId),
    Array.from(before.snapshot.queue, (row) => row.occurrenceId),
  );
  assert.equal(after.snapshot.queue.at(-1).occurrenceId, two.occurrenceId);
  assert.equal(
    (await f.call(f.command("remove", doc, { occurrenceId: two.occurrenceId }))).ok,
    true,
  );
  assert.equal(f.queueState.items.length, 2);
  assert.equal(f.media.paused, true);
});
test("queue changes, deadlines and disconnect during a backend read prevent dispatch", async () => {
  for (const kind of ["reorder", "retire", "deadline"]) {
    const f = fixture(),
      read = await f.call({ action: "inspect" });
    const command = f.command("append", read.native.documentId, { videoId: "ccccccccccc" });
    f.onFetch(async () => {
      if (kind === "reorder") f.queueState.items.reverse();
      if (kind === "retire") await f.call({ action: "retire" });
      if (kind === "deadline") command.deadlineAt = Date.now() - 1;
    });
    assert.equal((await f.call(command)).error, "control_unconfirmed");
    assert.equal(f.writes.length, 0);
  }
});
test("replaced objects and reloaded documents invalidate removal handles instead of guessing", async () => {
  const f = fixture(),
    before = await f.call({ action: "inspect" });
  const added = await f.call(
    f.command("append", before.native.documentId, { videoId: "bbbbbbbbbbb" }),
  );
  f.queueState.items[2] = f.row("bbbbbbbbbbb");
  assert.equal(
    (
      await f.call(
        f.command("remove", before.native.documentId, { occurrenceId: added.occurrenceId }),
      )
    ).error,
    "native_entry_not_owned",
  );
  assert.equal(
    (await f.call(f.command("append", "another-document", { videoId: "ccccccccccc" }))).error,
    "player_changed",
  );
  assert.equal(f.queueState.items.length, 3);
});
