const test = require("node:test"),
  assert = require("node:assert/strict");
const documents = require("../integrations/spotify-desktop/catalog-documents.cjs");
const { writeArchive } = require("../integrations/spotify-desktop/archive.cjs");
const facade = require("../integrations/spotify-desktop/native-facade.cjs");
const adapter = require("../integrations/spotify-desktop/desktop-adapter.cjs");
const URI = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA";

test("native catalog descriptors come only from unique supported operations in local client assets", async () => {
  const bytes = await writeArchive([
    {
      name: "search.js",
      data: Buffer.from(
        'new q.Doc("searchTracks","query","' +
          "a".repeat(64) +
          '",null);new q.Doc("getTrack","query","' +
          "b".repeat(64) +
          '",null);',
      ),
    },
  ]);
  assert.deepEqual(await documents(bytes), {
    searchTracks: "a".repeat(64),
    getTrack: "b".repeat(64),
  });
  const ambiguous = await writeArchive([
    {
      name: "search.js",
      data: Buffer.from(
        'new q.Doc("searchTracks","query","' +
          "a".repeat(64) +
          '",null);new q.Doc("searchTracks","query","' +
          "b".repeat(64) +
          '",null);',
      ),
    },
  ]);
  assert.deepEqual(await documents(ambiguous), {});
});

test("rejected public lookup falls back to a bounded native search without extracting account tokens", async () => {
  const calls = [];
  const native = facade(
    {
      getPlayerAPI: () => ({
        _cosmos: {
          get: async () => {
            throw Error("public lookup forbidden");
          },
        },
      }),
      getGraphQLLoader: () => async (document, variables) => {
        calls.push({ document, variables });
        return {
          data: {
            searchV2: {
              tracksV2: {
                items: [
                  {
                    item: {
                      data: {
                        __typename: "Track",
                        uri: URI,
                        name: "One More Time",
                        artists: {
                          items: [{ profile: { name: "Daft Punk" } }],
                        },
                        albumOfTrack: { name: "Discovery" },
                        duration: { totalMilliseconds: 300000 },
                      },
                    },
                  },
                ],
              },
            },
          },
        };
      },
    },
    { catalog: { searchTracks: "a".repeat(64) } },
  );
  const result = await adapter(native).search("Daft Punk One More Time");
  assert.equal(result.candidates[0].title, "One More Time");
  assert.equal(result.candidates[0].artists[0], "Daft Punk");
  assert.equal(calls[0].document.operation, "query");
  assert.equal(calls[0].document.name, "searchTracks");
  assert.equal(calls[0].variables.limit, 10);
  assert.throws(() => native.searchCatalog("https://example.com"), /query_invalid/);
});

test("native queue acknowledgements distinguish definite rejections and retain supplied occurrence ownership", async () => {
  let request;
  const player = {
    _queue: {
      _client: {
        addToQueue: async (value) => {
          request = value;
          return { error: 1, reasons: "restricted" };
        },
      },
      getInternalQueue: () => ({ nextTracks: [] }),
    },
  };
  const native = facade({ getPlayerAPI: () => player });
  const result = await adapter(native, {
    verifyLocalDevice: () => true,
  }).append(URI, { uid: "a".repeat(32) });
  assert.equal(result.error, "spotify_playback_restricted");
  assert.equal(request.track.uid, "a".repeat(32));
  assert.equal(request.track.uri, URI);
});

test("idle Spotify queues through the native command without playing or requiring a current track", async () => {
  let queue = null,
    played = false;
  const player = {
    _state: { isPaused: true },
    resume: () => {
      played = true;
    },
    _queue: {
      getInternalQueue: () => queue,
      addToQueue: async () => {
        throw Error("idle high-level queue must not be used");
      },
      _client: {
        addToQueue: async ({ track }) => {
          queue = {
            track: null,
            nextTracks: [{ contextTrack: track, provider: "queue" }],
          };
          return { error: 0 };
        },
      },
    },
  };
  const native = facade({
    getPlayerAPI: () => player,
    getConnectDevicesAPI: () => ({
      getActiveDevice: () => ({ isLocal: true, isActive: true }),
    }),
  });
  assert.equal(native.snapshot().current, null);
  const result = await adapter(native, {
    verifyLocalDevice: () => native.localDevice(),
  }).append(URI, { uid: "b".repeat(32) });
  assert.equal(result.ok, true);
  assert.equal(result.uid, "b".repeat(32));
  assert.equal(played, false);
  assert.equal(native.snapshot().queue.length, 1);
});
