const test = require("node:test"),
  assert = require("node:assert/strict");
const desktop = require("../integrations/spotify-desktop/desktop-adapter.cjs");
const official = require("../integrations/spotify-desktop/official-adapter.cjs");
const { trackUri } = require("../integrations/spotify-desktop/catalog.cjs");
const A = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA",
  B = "spotify:track:BBBBBBBBBBBBBBBBBBBBBB";
const track = {
  uri: A,
  name: "Example song",
  artists: [{ name: "Artist" }],
  duration_ms: 180000,
};

test("Spotify references and shared text search stay bounded and never become an arbitrary URL proxy", async () => {
  assert.equal(
    trackUri("https://open.spotify.com/intl-pt/track/AAAAAAAAAAAAAAAAAAAAAA?si=ignored"),
    A,
  );
  for (const input of [
    "https://example.com/track/AAAAAAAAAAAAAAAAAAAAAA",
    "https://user:pass@open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA",
    "spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA",
    "file:///test",
  ])
    assert.equal(trackUri(input), "");
  const calls = [],
    client = desktop({
      CosmosAsync: {
        get: async (url) => {
          calls.push(url);
          return {
            tracks: {
              items: [track, { ...track, is_playable: false }, ...Array(20).fill(track)],
            },
          };
        },
      },
    });
  const result = await client.search("Artist & song");
  assert.equal(result.ok, true);
  assert.equal(result.candidates.length, 9);
  assert.equal(result.candidates[0].providerItemId, "AAAAAAAAAAAAAAAAAAAAAA");
  const url = new URL(calls[0]);
  assert.equal(url.origin, "https://api.spotify.com");
  assert.equal(url.searchParams.get("q"), "Artist & song");
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal((await client.search("https://example.com/private")).ok, false);
  assert.equal(calls.length, 1);
});

test("desktop queue appends serialize FIFO and remove one UID without replacing or clearing the playlist", async () => {
  const calls = [],
    queue = {
      nextTracks: [
        { uri: A, uid: "personal-copy", provider: "queue" },
        { uri: B, uid: "playlist-song", provider: "context" },
      ],
    };
  let nextId = 0;
  const client = desktop(
    {
      Queue: queue,
      addToQueue: async (rows) => {
        calls.push(rows[0].uri);
        await new Promise((resolve) => setTimeout(resolve, 5));
        queue.nextTracks.splice(queue.nextTracks.length - 1, 0, {
          ...rows[0],
          uid: "ravelink-" + ++nextId,
          provider: "queue",
        });
      },
      removeFromQueue: async (rows) => {
        assert.ok(rows[0].uid);
        queue.nextTracks = queue.nextTracks.filter((row) => row.uid !== rows[0].uid);
      },
    },
    { verifyLocalDevice: () => true },
  );
  const [first, second] = await Promise.all([client.append(A), client.append(B)]);
  assert.deepEqual(calls, [A, B]);
  assert.equal(first.delivery, "confirmed");
  assert.equal(second.delivery, "confirmed");
  assert.deepEqual(
    queue.nextTracks.map((row) => row.uid),
    ["personal-copy", first.uid, second.uid, "playlist-song"],
  );
  assert.equal((await client.remove({ uri: A, uid: first.uid })).removed, true);
  assert.ok(queue.nextTracks.some((row) => row.uid === "personal-copy"));
  assert.ok(queue.nextTracks.some((row) => row.uid === "playlist-song"));
  assert.equal((await client.remove({ uri: A })).error, "spotify_queue_entry_id_required");
  assert.equal(
    (await client.remove({ uri: B, uid: "playlist-song" })).error,
    "spotify_queue_entry_not_found",
  );
});

test("desktop rejects unknown devices and never retries an ambiguous native submission", async () => {
  let writes = 0;
  const api = {
    Queue: { nextTracks: [] },
    addToQueue: async () => {
      writes++;
    },
  };
  assert.equal((await desktop(api).append(A)).error, "spotify_local_device_unverified");
  assert.equal(writes, 0);
  const result = await desktop(api, { verifyLocalDevice: () => true }).append(A);
  assert.equal(result.error, "spotify_delivery_unconfirmed");
  assert.equal(result.retrySafe, false);
  assert.equal(writes, 1);
  const broken = desktop(
    {
      get Queue() {
        throw Error("Client changed");
      },
      addToQueue() {
        writes++;
      },
    },
    { verifyLocalDevice: () => true },
  );
  assert.equal((await broken.append(A)).error, "spotify_queue_shape_unavailable");
  assert.equal(writes, 1);
});

test("Premium transport targets an explicitly chosen device and treats 204 as receipt rather than confirmation", async () => {
  const calls = [],
    client = official({
      getAccessToken: async () => "fixture-token",
      fetch: async (url, options) => {
        calls.push({ url, options });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(null, { status: 204 });
      },
    });
  assert.equal((await client.append(A)).error, "spotify_device_selection_required");
  assert.equal(calls.length, 0);
  const rows = await Promise.all([client.append(A, "desktop-1"), client.append(B, "desktop-1")]);
  assert.ok(
    rows.every((row) => row.delivery === "accepted_unconfirmed" && row.retrySafe === false),
  );
  assert.deepEqual(
    calls.map((row) => new URL(row.url).searchParams.get("uri")),
    [A, B],
  );
  assert.ok(
    calls.every(
      (row) =>
        row.options.redirect === "error" && new URL(row.url).origin === "https://api.spotify.com",
    ),
  );
  assert.equal(client.capabilities.queueRemoval, false);
  assert.equal((await client.remove({ uri: A })).error, "spotify_queue_removal_unsupported");
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(rows).includes("fixture-token"), false);
});

test("Premium transport honors Spotify backoff, contains API errors and does not replay a timed-out write", async () => {
  let time = 1000,
    calls = 0;
  const client = official({
    now: () => time,
    getAccessToken: async () => "fixture-token",
    fetch: async () => {
      calls++;
      return new Response("", {
        status: 429,
        headers: { "retry-after": "12" },
      });
    },
  });
  assert.equal((await client.search("Artist")).retryAfterMs, 12000);
  assert.equal((await client.append(A, "desktop-1")).error, "spotify_rate_limited");
  assert.equal(calls, 1);
  time += 12000;
  await client.search("Artist");
  assert.equal(calls, 2);
  const failed = official({
    getAccessToken: async () => "private-token",
    fetch: async () => {
      throw Error("private-token");
    },
  });
  const result = await failed.append(A, "desktop-1");
  assert.equal(result.error, "spotify_delivery_unconfirmed");
  assert.equal(result.retrySafe, false);
  assert.equal(JSON.stringify(result).includes("private-token"), false);
  for (const [status, error] of [
    [401, "spotify_sign_in_required"],
    [403, "spotify_account_or_app_access_required"],
  ]) {
    const denied = official({
      getAccessToken: async () => "fixture-token",
      fetch: async () => new Response("", { status }),
    });
    assert.equal((await denied.search("Artist")).error, error);
  }
});
