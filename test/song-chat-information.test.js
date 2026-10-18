const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const information = require("../features/song-request/dist/chat-information");
const key = (name) => "req_" + crypto.createHash("sha256").update(name).digest("hex");

test("queue estimates sum predecessors, qualify pauses and propagate unknown timing", () => {
  const timing = require("../features/song-request/dist/chat-queue-timing");
  const now = 100000;
  const current = {
    status: "playing",
    durationMs: 180000,
    positionMs: 60000,
    observedAt: now - 10000,
  };
  const input = {
    rows: [{ durationMs: 180000 }, { durationMs: 120000 }, { durationMs: 60000 }],
    current,
    observation: current,
    playback: { control: {} },
    native: false,
    now,
  };
  assert.deepEqual(timing(input), ["in ~1:50", "in ~4:50", "in ~6:50"]);
  current.status = "paused";
  assert.deepEqual(timing(input), [
    "~2:00 after resume",
    "~5:00 after resume",
    "~7:00 after resume",
  ]);
  delete input.rows[0].durationMs;
  assert.deepEqual(timing(input), ["~2:00 after resume", "ETA unavailable", "ETA unavailable"]);
  current.observedAt = now - 16000;
  assert.ok(timing(input).every((label) => label === "ETA unavailable"));
  current.observedAt = now;
  input.native = true;
  input.state = { capacity: { queued: 3 }, queueOrder: ["known-request"] };
  assert.ok(
    timing(input).every((label) => label === "ETA unavailable"),
    "unowned native entries cannot be timed",
  );
});
test("Windows media metadata describes a non-requested desktop song without a candidate wrapper", async () => {
  const queue = require("../features/song-request/dist/domain").createSongQueue();
  queue.configurePlaybackSource({ source: "tidal" });
  queue.observe({
    provider: "tidal",
    sourceId: "fixture",
    available: true,
    title: "Background song",
    artists: ["Background artist"],
    status: "playing",
  });
  const result = await information(
    {
      queue,
      preferences: async () => ({ ok: true, player: "tidal" }),
      tidal: async () => ({
        ok: true,
        ready: true,
        connected: true,
        current: { uid: "background", trackId: "123" },
        handoffs: [],
        queueOrder: [],
      }),
    },
    { command: "song", requesterId: "alice" },
  );
  assert.match(result.message, /Now playing: Background song - Background artist/);
  queue.observe({ provider: "tidal", sourceId: "fixture", available: false });
  const missing = await information(
    {
      queue,
      preferences: async () => ({ ok: true, player: "tidal" }),
      tidal: async () => ({
        ok: true,
        ready: true,
        connected: true,
        current: { uid: "background", trackId: "123" },
        handoffs: [],
        queueOrder: [],
      }),
    },
    { command: "song", requesterId: "alice" },
  );
  assert.equal(
    missing.ok,
    false,
    "a known playing occurrence with missing metadata is unavailable, not an empty player",
  );
});
function fixture(provider) {
  const native = ["tidal", "spotify"].includes(provider);
  const row = (id, title, owner = "bob") => ({
    id,
    entryId: id,
    uid: id + "-uid",
    requesterKey: key(owner),
    phase: "appended",
    candidate: { provider, providerItemId: id, title, artists: ["Artist"], durationMs: 180000 },
  });
  const current = {
    ...row("current", "Current song", "alice"),
    phase: "playing",
    status: "playing",
    observedAt: Date.now(),
    positionMs: 60000,
    durationMs: 180000,
  };
  const next = Array.from({ length: 6 }, (_, i) =>
    row("next" + i, "Upcoming " + (i + 1), i === 1 ? "alice" : "bob"),
  );
  const waiting = row("waiting", "Waiting song", "alice");
  const state = {
    ok: true,
    connected: true,
    ready: true,
    current,
    handoffs: [...next].reverse().concat(current),
    queueOrder: next.map((x) => x.entryId),
  };
  const playback = {
    primary: current,
    managed: native ? null : current,
    control: { paused: false },
  };
  const local = native ? [next[0], waiting] : [current, ...next, waiting];
  const queue = {
    status: ({ offset = 0, limit = 25 } = {}) => ({
      counts: { queued: local.length },
      queue: local.slice(offset, offset + limit),
    }),
    playbackStatus: () => playback,
  };
  const player = async (method) => {
    assert.equal(method, "status", "information must never issue a playback or queue write");
    return state;
  };
  return {
    state,
    playback,
    local,
    query: (command, requesterId = "alice") =>
      information(
        {
          queue,
          preferences: async () => ({ ok: true, player: provider }),
          tidal: player,
          spotify: player,
        },
        { command, requesterId },
      ),
  };
}
for (const provider of ["youtube", "soundcloud", "tidal", "spotify"]) {
  test(`information commands report current song, five queued requests and own position on ${provider}`, async () => {
    const f = fixture(provider),
      before = JSON.stringify([f.state, f.local]);
    assert.match((await f.query("song")).message, /Now playing: Current song - Artist/);
    const next = (await f.query("songqueue")).message;
    assert.match(next, /1\. Upcoming 1/);
    assert.match(next, /Upcoming 1.*in ~[12]:/);
    assert.match(next, /5\. Upcoming 5/);
    assert.doesNotMatch(next, /Upcoming 6|Current song|Waiting song|req_/);
    assert.match((await f.query("queue")).message, /playing now.*#2.*1 ahead.*1 more queued/);
    assert.match((await f.query("queue")).message, /Upcoming 2.*in ~[45]:/);
    assert.match((await f.query("queue", "stranger")).message, /no pending song requests/);
    assert.equal(
      JSON.stringify([f.state, f.local]),
      before,
      "read-only replies must not change queue or receipts",
    );
    f.playback.primary.status = "paused";
    f.playback.control.paused = true;
    assert.match((await f.query("song")).message, /^Paused:/);
    assert.match((await f.query("songqueue")).message, /after resume/);
  });
}
test("uncertain or disconnected native delivery never invents an exact position", async () => {
  const f = fixture("tidal");
  f.state.handoffs.find((x) => x.entryId === "next0").phase = "unknown";
  assert.match((await f.query("songqueue")).message, /awaiting player confirmation/);
  assert.match((await f.query("queue")).message, /position is not confirmed/);
  f.state.connected = false;
  f.state.ready = false;
  assert.equal((await f.query("queue")).ok, false);
  f.playback.primary = null;
  assert.match((await f.query("song")).message, /temporarily unavailable/);
});

test("chat metadata removes delimiters from nested, unfinished and normalized markup", async () => {
  const f = fixture("youtube");
  for (const title of [
    "<<script>script>alert(1)</script>",
    "<script",
    "<b>Song</b>",
    "\uff1cscript\uff1e",
  ]) {
    f.playback.managed.candidate.title = title;
    f.playback.managed.candidate.artists = ["Artist <img", "<<b>b>Guest</b>"];
    const current = await f.query("song");
    assert.equal(current.ok, true);
    assert.doesNotMatch(current.message, /[<>\uff1c\uff1e\r\n]/);
    f.local[1].candidate.title = title;
    assert.doesNotMatch((await f.query("songqueue")).message, /[<>\uff1c\uff1e\r\n]/);
  }
});
test("queue position pages beyond the first 25 requests and sanitizes bounded multilingual titles", async () => {
  const f = fixture("youtube");
  f.local.splice(
    0,
    f.local.length,
    ...Array.from({ length: 65 }, (_, i) => ({
      id: "entry" + i,
      requesterKey: key(i === 60 ? "alice" : "bob"),
      candidate: { provider: "youtube", title: "<b>曲\n🎵</b>".repeat(100), artists: ["Artist"] },
    })),
  );
  f.playback.managed = null;
  f.playback.primary = null;
  assert.match((await f.query("queue")).message, /#61.*60 ahead/);
  const next = (await f.query("songqueue")).message;
  assert.ok(next.length <= 450);
  assert.doesNotMatch(next, /<b>|\n|req_/);
  f.local.splice(0);
  assert.match((await f.query("song")).message, /No song/);
  assert.match((await f.query("songqueue")).message, /no pending/);
});
