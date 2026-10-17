const test = require("node:test");
const assert = require("node:assert/strict");
const { createPlaylistLibrary } = require("../features/song-request/dist/playlist-library");
const { createPlaylistService } = require("../features/song-request/dist/playlist-service");

test("large library restoration yields startup, blocks edits until complete and preserves all occurrences", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const library = createPlaylistLibrary(),
    list = library.create({ name: "Large" }).collection;
  library.replace(
    list.id,
    Array.from({ length: 5000 }, (_, id) => ({
      provider: "tidal",
      providerItemId: String(id),
      title: "Track " + id,
      artists: ["Artist"],
    })),
  );
  const saved = library.exportStorage(),
    values = new Map(saved.pages.map(([key, value]) => ["library-page-" + key, value]));
  values.set("playlist-library-index-v1", saved.index);
  let writes = 0;
  const context = {
    callCapability: async (cap, method, input) => {
      if (method !== "get") {
        writes++;
        return { ok: true };
      }
      return {
        ok: true,
        found: values.has(input.key),
        value: values.get(input.key),
      };
    },
  };
  const queue = {
    status: () => ({ playlistState: { mode: "off" } }),
    moderate: () => {},
    importPlaylist: () => {},
  };
  const service = createPlaylistService({
    context,
    queue,
    schedulePersistence: () => {},
    publishChange: () => {},
  });
  t.after(() => service.stop());
  let activated = false;
  const startup = service.activate().then(() => {
    activated = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1500);
  await new Promise((resolve) => setImmediate(resolve));
  await startup;
  assert.equal(activated, true);
  assert.equal((await service.read({}, {})).recovering, true);
  assert.equal(
    (await service.mutate({ action: "create", name: "Blocked" }, {})).code,
    "playlist_recovering",
  );
  await service.persist();
  assert.equal(writes, 0);
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const restored = await service.read({}, {});
  assert.equal(restored.recovering, false);
  assert.equal(restored.page.total, 5000);
});
