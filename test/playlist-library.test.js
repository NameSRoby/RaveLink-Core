const test = require("node:test");
const assert = require("node:assert/strict");
const { createPlaylistLibrary, MAX_TRACKS } = require("../features/song-request/dist/playlist-library");

function track(id, title = id) {
  return { provider: "youtube", providerItemId: id, title, artists: ["Artist"] };
}

test("playlist library keeps independent selectable collections", () => {
  const library = createPlaylistLibrary({ now: () => 1000 });
  const first = library.create({ name: "First" }).collection;
  library.replace(first.id, [track("AAAAAAAAAAA", "One")]);
  const second = library.create({ name: "Second" }).collection;
  library.replace(second.id, [track("BBBBBBBBBBB", "Two")]);
  assert.equal(library.select(first.id).tracks[0].candidate.title, "One");
  assert.equal(library.select(second.id).tracks[0].candidate.title, "Two");
  assert.equal(library.status().collections.length, 2);
});

test("random selection chooses a non-empty user playlist before chat history", () => {
  const library = createPlaylistLibrary();
  const chat = library.ensureChatCollection().collection;
  library.replace(chat.id, [{ providerItemId: "abcdefghijk", title: "History" }]);
  const first = library.create({ name: "First" }).collection;
  const second = library.create({ name: "Second" }).collection;
  library.replace(first.id, [{ providerItemId: "lmnopqrstuv", title: "First song" }]);
  library.replace(second.id, [{ providerItemId: "wxyzABCDE12", title: "Second song" }]);
  assert.equal(library.selectRandom(() => 0).collection.id, first.id);
  assert.equal(library.selectRandom(() => 0.99).collection.id, second.id);
});

test("playlist storage is paged and restores stable provider IDs", () => {
  const library = createPlaylistLibrary({ now: () => 1000 });
  const collection = library.create({ name: "Imported", provider: "youtube", sourceId: "PL123456789" }).collection;
  const rows = Array.from({ length: 45 }, (_, index) => track(String(index).padStart(11, "A")));
  library.replace(collection.id, rows);
  const stored = library.exportStorage();
  assert.equal(stored.pages.length, 2);
  const pages = Object.fromEntries([[collection.id, stored.pages.flatMap(([, page]) => page)]]);
  const restored = createPlaylistLibrary({ now: () => 2000 });
  restored.restore(stored.index, pages);
  assert.equal(restored.status().page.total, 45);
  assert.match(restored.active().tracks[0].candidate.sourceUrl, /^https:\/\/www\.youtube\.com\/watch\?v=/);
});

test("playlist library de-duplicates and caps imported tracks", () => {
  const library = createPlaylistLibrary();
  const collection = library.create({ name: "Bounded" }).collection;
  const rows = Array.from({ length: MAX_TRACKS + 10 }, (_, index) => track(index.toString(36).padStart(11, "0").slice(-11)));
  rows.push(rows[0]);
  assert.equal(library.replace(collection.id, rows).collection.count, MAX_TRACKS);
});

test("playlist library preserves official SoundCloud playlist tracks", () => {
  const library = createPlaylistLibrary({ now: () => 1000 });
  const collection = library.create({ name: "SoundCloud", provider: "soundcloud", sourceId: "soundcloud:playlists:42" }).collection;
  const result = library.replace(collection.id, [{ provider: "soundcloud", providerItemId: "soundcloud:tracks:7", title: "Track", artists: ["Artist"], sourceUrl: "https://soundcloud.com/artist/track" }], { provider: "soundcloud" });
  assert.equal(result.collection.count, 1);
  assert.equal(result.tracks[0].candidate.provider, "soundcloud");
  assert.equal(result.tracks[0].candidate.sourceUrl, "https://soundcloud.com/artist/track");
});

test("the required chat archive is protected and its history policy is explicit", () => {
  const library = createPlaylistLibrary({ now: () => 1000 });
  const chat = library.ensureChatCollection().collection;
  assert.equal(chat.purpose, "chat-history");
  assert.equal(library.remove(chat.id).code, "chat_playlist_required");
  assert.equal(library.capturePlayed(track("AAAAAAAAAAA")).code, "history_disabled");
  assert.equal(library.configureHistory({ enabled: true, destinationId: chat.id }).ok, true);
  assert.equal(library.capturePlayed(track("AAAAAAAAAAA")).code, "history_saved");
  assert.equal(library.capturePlayed(track("AAAAAAAAAAA")).code, "history_refreshed");
  assert.equal(library.status().page.total, 1);
});
