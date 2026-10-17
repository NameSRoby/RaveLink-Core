const test = require("node:test");
const assert = require("node:assert/strict");
const { createSongQueue } = require("../features/song-request/dist/domain");
const create = require("../features/song-request/dist/soundcloud-player");
const sound = (id) => ({
  id: String(id),
  title: "Track " + id,
  duration: 200000,
  policy: "ALLOW",
  user: { username: "Uploader" },
});
test("SoundCloud uses confirmed playback, FIFO requests and resumes its server playlist", async () => {
  const queue = createSongQueue({
    requestProviders: ["soundcloud"],
    playlistProviders: [],
  });
  const api = create({ queue, playlists: {}, changed() {} });
  queue.importPlaylist([
    { candidate: create.candidate(sound(10)) },
    { candidate: create.candidate(sound(11)) },
  ]);
  queue.moderate({ action: "playlist_play" });
  await api("start");
  const background = queue.pull({
    driverId: "sc",
    providers: ["soundcloud"],
  }).action;
  assert.equal(background.candidate.providerItemId, "10");
  assert.equal(queue.playbackStatus().primary.status, "loading");
  queue.acknowledge({
    driverId: "sc",
    leaseId: background.leaseId,
    state: "started",
  });
  assert.equal(queue.playbackStatus().primary.status, "playing");
  for (const id of [1, 2])
    assert.equal((await api("submit", { requestId: "r" + id, sound: sound(id) })).ok, true);
  assert.equal(queue.pull({ driverId: "sc", providers: ["soundcloud"] }).action, null);
  queue.acknowledge({
    driverId: "sc",
    leaseId: background.leaseId,
    state: "ended",
  });
  for (const id of [1, 2, 11]) {
    const entry = queue.pull({
      driverId: "sc",
      providers: ["soundcloud"],
    }).action;
    assert.equal(entry.candidate.providerItemId, String(id));
    queue.acknowledge({
      driverId: "sc",
      leaseId: entry.leaseId,
      state: "ended",
    });
  }
});
test("SoundCloud moderation removes active requester tracks and enforces song timeouts", async () => {
  const queue = createSongQueue({
    requestProviders: ["soundcloud"],
    playlistProviders: [],
  });
  const api = create({ queue, playlists: {}, changed() {} });
  await api("start");
  const first = await api("submit", { requestId: "one", sound: sound(1) });
  await api("submit", { requestId: "two", sound: sound(2) });
  const lease = queue.pull({
    driverId: "sc",
    providers: ["soundcloud"],
  }).action;
  queue.moderate({
    action: "timeout",
    requesterKey: first.entry.requesterKey,
    minutes: 5,
  });
  assert.equal(queue.playbackStatus().managed, null);
  assert.equal(queue.status().queue.length, 0);
  assert.equal(
    queue.acknowledge({
      driverId: "sc",
      leaseId: lease.leaseId,
      state: "started",
    }).code,
    "lease_stale",
  );
  queue.moderate({
    action: "untimeout",
    requesterKey: first.entry.requesterKey,
  });
  queue.moderate({
    action: "timeout_song",
    provider: "soundcloud",
    providerItemId: "2",
    minutes: 1,
  });
  assert.equal(
    (await api("submit", { requestId: "three", sound: sound(2) })).reason,
    "song_timed_out",
  );
  assert.equal((await api("submit", { requestId: "four", sound: sound(4) })).ok, true);
  const next = queue.pull({ driverId: "sc", providers: ["soundcloud"] }).action;
  assert.equal((await api("release", { driverId: "other", leaseId: next.leaseId })).ok, false);
  assert.equal((await api("release", { driverId: "sc", leaseId: next.leaseId })).ok, true);
  assert.equal(queue.status().queue.length, 1, "switching players preserves the waiting request");
});
test("public playlist imports are bounded, ordered, atomic, and retain duplicate occurrences", async () => {
  const saved = [];
  const api = create({
    queue: createSongQueue(),
    changed() {},
    playlists: {
      trackLimit: () => 3,
      installPublicPlaylist: async (name, rows) => {
        saved.push({ name, rows });
        return { ok: true, collectionId: "new" };
      },
    },
  });
  const { uploadId } = await api("import-start", { name: "Public list" });
  assert.equal((await api("import-append", { uploadId, offset: 1, sounds: [sound(1)] })).ok, false);
  assert.equal(
    (
      await api("import-append", {
        uploadId,
        offset: 0,
        sounds: [sound(1), sound(1)],
      })
    ).ok,
    true,
  );
  assert.equal(saved.length, 0);
  assert.equal(
    (
      await api("import-append", {
        uploadId,
        offset: 2,
        sounds: [sound(2), sound(3)],
      })
    ).code,
    "playlist_track_limit",
  );
  assert.equal((await api("import-save", { uploadId })).ok, true);
  assert.deepEqual(
    saved[0].rows.map((row) => row.candidate.providerItemId),
    ["1", "1"],
  );
  assert.equal((await api("import-save", { uploadId })).ok, false);
  for (const bad of [
    { ...sound(1), id: "../evil" },
    { ...sound(1), policy: "SNIP" },
  ])
    assert.equal((await api("submit", { sound: bad })).ok, false);
  assert.equal(create.candidate({ ...sound(4), policy: "MONETIZE" }).providerItemId, "4");
});
test("paused SoundCloud playback stays paused and a missing driver releases its request after the heartbeat expires", () => {
  let now = 1000;
  const queue = createSongQueue({
    now: () => now,
    requestProviders: ["soundcloud"],
    playlistProviders: [],
  });
  queue.configurePlaybackSource({ source: "soundcloud" });
  queue.moderate({ action: "playback_start" });
  queue.submit({
    requestId: "lease",
    requesterId: "user",
    query: "track",
    candidate: create.candidate(sound(1)),
  });
  const first = queue.pull({
    driverId: "one",
    providers: ["soundcloud"],
  }).action;
  queue.acknowledge({
    driverId: "one",
    leaseId: first.leaseId,
    state: "started",
  });
  now += 10000;
  queue.acknowledge({
    driverId: "one",
    leaseId: first.leaseId,
    state: "paused",
  });
  assert.equal(queue.playbackStatus().primary.status, "paused");
  now += 59000;
  assert.equal(queue.pull({ driverId: "two", providers: ["soundcloud"] }).action, null);
  now += 1001;
  const recovered = queue.pull({
    driverId: "two",
    providers: ["soundcloud"],
  }).action;
  assert.equal(recovered.entryId, first.entryId);
  assert.notEqual(recovered.leaseId, first.leaseId);
  assert.equal(queue.status().queue.length, 1);
});
