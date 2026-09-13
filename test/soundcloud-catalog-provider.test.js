const test = require("node:test");
const assert = require("node:assert/strict");
const { createSoundCloudCatalogProvider, soundCloudUrl } = require("../src/capabilities/feature-platform/providers/soundcloud-catalog-provider");

function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }

test("SoundCloud URL admission accepts only official HTTPS hosts", () => {
  assert.equal(soundCloudUrl("https://soundcloud.com/artist/song"), "https://soundcloud.com/artist/song");
  assert.equal(soundCloudUrl("https://on.soundcloud.com/abc"), "https://on.soundcloud.com/abc");
  assert.equal(soundCloudUrl("http://soundcloud.com/artist/song"), "");
  assert.equal(soundCloudUrl("https://soundcloud.com.evil.example/song"), "");
});

test("SoundCloud provider keeps credentials write-only, caches OAuth, and returns playable tracks", async () => {
  const calls = [];
  const provider = createSoundCloudCatalogProvider({ now: () => 1000, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/oauth/token")) return response({ access_token: "access-token-value", refresh_token: "refresh-token-value", expires_in: 3600 });
    return response({ collection: [
      { urn: "soundcloud:tracks:blocked", title: "Blocked", access: "blocked", duration: 1000, user: { username: "No" } },
      { urn: "soundcloud:tracks:12345", title: "Playable", access: "playable", duration: 180000, metadata_artist: "Artist", permalink_url: "https://soundcloud.com/artist/playable" }
    ] });
  } });
  const configured = await provider.configure({ clientId: "client_id_12345", clientSecret: "client_secret_value_12345" });
  assert.equal(configured.configured, true);
  assert.equal(JSON.stringify(configured).includes("client_secret_value"), false);
  const first = await provider.resolve({ query: "artist playable", maxDurationMs: 600000 });
  const second = await provider.resolve({ query: "artist playable", maxDurationMs: 600000 });
  assert.equal(first.ok, true);
  assert.equal(first.candidate.provider, "soundcloud");
  assert.equal(first.candidate.providerItemId, "soundcloud:tracks:12345");
  assert.equal(first.candidate.sourceUrl, "https://soundcloud.com/artist/playable");
  assert.equal(calls.filter(row => row.url.includes("/oauth/token")).length, 1);
  assert.equal(calls.filter(row => row.url.includes("/tracks?")).length, 1);
  assert.deepEqual(second, first);
});

test("SoundCloud direct resolution rejects preview-only resources", async () => {
  const provider = createSoundCloudCatalogProvider({ fetchImpl: async url => String(url).includes("/oauth/token")
    ? response({ access_token: "token", refresh_token: "refresh", expires_in: 3600 })
    : response({ urn: "soundcloud:tracks:99", title: "Preview", access: "preview", duration: 30000 }) });
  await provider.configure({ clientId: "client_id_12345", clientSecret: "client_secret_value_12345" });
  const result = await provider.resolve({ query: "https://soundcloud.com/artist/preview" });
  assert.deepEqual(result, { ok: false, reason: "soundcloud_no_playable_track" });
});

test("SoundCloud imports public playlists through bounded paginated jobs", async () => {
  const provider = createSoundCloudCatalogProvider({ fetchImpl: async url => {
    const value = String(url);
    if (value.includes("/oauth/token")) return response({ access_token: "token", refresh_token: "refresh", expires_in: 3600 });
    if (value.includes("/resolve?")) return response({ kind: "playlist", urn: "soundcloud:playlists:42", title: "My Set" });
    if (value.includes("cursor=next")) return response({ collection: [
      { urn: "soundcloud:tracks:2", title: "Second", access: "playable", duration: 2000, permalink_url: "https://soundcloud.com/a/second" }
    ] });
    return response({ collection: [
      { urn: "soundcloud:tracks:1", title: "First", access: "playable", duration: 1000, permalink_url: "https://soundcloud.com/a/first" },
      { urn: "soundcloud:tracks:no", title: "Blocked", access: "blocked", duration: 1000 }
    ], next_href: "https://api.soundcloud.com/playlists/soundcloud:playlists:42/tracks?cursor=next&linked_partitioning=true" });
  } });
  await provider.configure({ clientId: "client_id_12345", clientSecret: "client_secret_value_12345" });
  const started = provider.importPlaylistStart({ url: "https://soundcloud.com/a/sets/my-set", limit: 20 });
  assert.equal(started.ok, true);
  let status;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
    status = provider.importPlaylistStatus({ jobId: started.jobId });
    if (status.state !== "running") break;
  }
  assert.equal(status.state, "complete", JSON.stringify(status));
  assert.equal(status.count, 2);
  const page = provider.importPlaylistPage({ jobId: started.jobId, offset: 0, limit: 10 });
  assert.deepEqual(page.items.map(item => item.providerItemId), ["soundcloud:tracks:1", "soundcloud:tracks:2"]);
});
