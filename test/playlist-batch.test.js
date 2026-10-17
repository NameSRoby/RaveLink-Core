const test = require("node:test"),
  assert = require("node:assert/strict");
const createTransfers = require("../features/song-request/dist/playlist-transfers");
const { createPlaylistLibrary } = require("../features/song-request/dist/playlist-library");
const id = (letter) => letter.repeat(22),
  track = (letter) => ({
    provider: "spotify",
    providerItemId: id(letter),
    title: "Song",
    artists: ["Artist"],
    durationMs: 180000,
  });
function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const library = createPlaylistLibrary(),
    storage = new Map(),
    destinations = new Map(),
    calls = [];
  const source = new Map([
    [id("A"), [track("C"), track("C")]],
    [id("E"), [track("F"), track("F")]],
  ]);
  const context = {
    callCapability: async (cap, method, payload) => {
      if (cap === "ravelink.storage.v1") {
        if (method === "get")
          return {
            ok: true,
            found: storage.has(payload.key),
            value: structuredClone(storage.get(payload.key)),
          };
        if (method === "remove") storage.delete(payload.key);
        else storage.set(payload.key, structuredClone(payload.value));
        return { ok: true };
      }
      assert.equal(cap, "spotify.desktop.host.v1");
      assert.equal(method, "playlist");
      calls.push({ ...payload });
      if (payload.action === "create") {
        const next = id(destinations.size ? "H" : "B");
        destinations.set(next, []);
        return { ok: true, id: "spotify:playlist:" + next };
      }
      const key = payload.id.replace(/^spotify:playlist:/, "");
      if (payload.action === "append") {
        destinations.get(key).push(...payload.ids);
        return { ok: true };
      }
      if (payload.action === "read") {
        const rows = source.get(key) || destinations.get(key)?.map((value) => track(value[0]));
        if (!rows) return { ok: false, error: "spotify_playlist_unavailable" };
        const offset = payload.offset || 0,
          limit = source.has(key) ? 1 : 25;
        return {
          ok: true,
          name: key === id("A") ? "First" : "Second",
          total: rows.length,
          revision: "v1",
          tracks: rows.slice(offset, offset + limit),
          cursor: offset + limit < rows.length ? String(offset + limit) : "",
        };
      }
      throw Error("Unexpected action");
    },
  };
  let worker = createTransfers({
    context,
    library,
    saveLibrary: async () => {},
  });
  t.after(() => worker.stop());
  const call = async (action, extra = {}) =>
    worker.handle({
      action,
      jobId: (await worker.handle({ action: "status" })).job?.id,
      ...extra,
    });
  const run = async (n = 12) => {
    for (let i = 0; i < n; i++) {
      t.mock.timers.tick(1000);
      await new Promise((r) => setImmediate(r));
    }
  };
  const begin = () =>
    call("source_batch", {
      sourceKind: "spotify",
      playlists: [
        { id: id("A"), name: "First" },
        { id: id("E"), name: "Second" },
      ],
    });
  return {
    library,
    call,
    run,
    begin,
    destinations,
    calls,
    restart: async () => {
      worker.stop();
      worker = createTransfers({
        context,
        library,
        saveLibrary: async () => {},
      });
      await worker.load();
    },
  };
}
for (const mode of ["playlist", "single"])
  test(
    "selected Spotify playlists " +
      (mode === "playlist" ? "remain separate" : "merge in order") +
      " and survive restart between sources",
    async (t) => {
      const f = fixture(t);
      assert.equal((await f.begin()).ok, true);
      await f.run(2);
      await f.restart();
      await f.run(5);
      const loaded = await f.call("status");
      assert.equal(loaded.job.state, "review");
      assert.equal(loaded.job.count, 4);
      assert.deepEqual(
        loaded.rows.map((row) => row.sourcePlaylist.name),
        ["First", "First", "Second", "Second"],
      );
      await f.call("match", { target: "spotify" });
      await f.run(6);
      const plan = await f.call("plan", { groupBy: mode });
      assert.deepEqual(
        plan.plan.map((p) => p.count),
        mode === "playlist" ? [2, 2] : [4],
      );
      await f.call("write_spotify", { groupBy: mode });
      await f.run(6);
      const done = await f.call("status");
      assert.equal(done.job.verified, true);
      assert.deepEqual(
        [...f.destinations.values()],
        mode === "playlist"
          ? [
              [id("C"), id("C")],
              [id("F"), id("F")],
            ]
          : [[id("C"), id("C"), id("F"), id("F")]],
      );
      const reused = await f.call("review_source");
      assert.equal(reused.job.state, "review");
      assert.notEqual(reused.job.id, done.job.id);
      assert.equal(reused.job.destinationId, "");
      assert.equal(reused.job.sourcePlaylists.length, 2);
    },
  );
for (const mode of ["playlist", "single"])
  test(
    "local batch saving supports " +
      mode +
      " and does not combine playlists with identical names unless requested",
    async (t) => {
      const f = fixture(t),
        one = f.library.create({ name: "Same name" }).collection,
        two = f.library.create({ name: "Same name" }).collection;
      f.library.replace(one.id, [track("C"), track("C")]);
      f.library.replace(two.id, [track("F")]);
      const loaded = await f.call("source_batch", {
        sourceKind: "library",
        playlists: [{ id: one.id }, { id: two.id }],
      });
      assert.equal(loaded.job.valid, 3);
      const done = await f.call("save_local", { groupBy: mode });
      assert.equal(done.ok, true);
      assert.deepEqual(
        done.job.localDestinations.map((d) => d.count),
        mode === "playlist" ? [2, 1] : [3],
      );
      const tracks = done.job.localDestinations.flatMap((d) => f.library.get(d.id).tracks);
      assert.deepEqual(
        tracks.map((row) => row.candidate.providerItemId),
        [id("C"), id("C"), id("F")],
      );
    },
  );
test("invalid selections leave the loaded source intact and rematching the same destination preserves manual choices", async (t) => {
  const f = fixture(t);
  await f.begin();
  await f.run();
  const loaded = await f.call("status");
  assert.equal(
    (
      await f.call("source_batch", {
        sourceKind: "spotify",
        playlists: [{ id: id("A") }, { id: "spotify:playlist:" + id("A") }],
      })
    ).code,
    "transfer_sources_invalid",
  );
  assert.equal((await f.call("status")).job.id, loaded.job.id);
  await f.call("match", { target: "spotify" });
  await f.run(6);
  await f.call("choose", { index: 0, choice: -1 });
  const again = await f.call("match", { target: "spotify" });
  assert.equal(again.job.state, "review");
  assert.equal(again.rows[0].include, false);
  assert.equal(again.job.selected, 3);
});
