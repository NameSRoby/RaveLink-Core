const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../src/capabilities/feature-platform/providers/song-link-input");
const urls = {
  youtube: "https://youtu.be/dQw4w9WgXcQ?si=test",
  spotify: "https://open.spotify.com/track/6S2iHbyPSIhQgCyAVQ2SO6?si=test",
  tidal: "https://listen.tidal.com/track/123?u=test",
};
for (const target of ["youtube", "spotify", "tidal", "soundcloud"])
  test("song links resolve into " + target + " input", async () => {
    const calls = [];
    const input = create({
      fetchImpl: async (url) => {
        calls.push(String(url));
        const u = String(url);
        if (u.startsWith("https://www.youtube.com/oembed"))
          return new Response(JSON.stringify({ title: "Song", author_name: "Artist" }));
        if (u.startsWith("https://open.spotify.com/embed/track/"))
          return new Response(
            '<script id="__NEXT_DATA__">' +
              JSON.stringify({
                props: {
                  pageProps: {
                    state: {
                      data: {
                        entity: {
                          title: "Song",
                          artists: [{ name: "Artist" }],
                        },
                      },
                    },
                  },
                },
              }) +
              "</script>",
          );
        if (u === "https://tidal.com/track/123")
          return new Response(
            '<script type="application/ld+json">' +
              JSON.stringify({
                "@type": "MusicRecording",
                name: "Song",
                byArtist: { name: "Artist" },
              }) +
              "</script>",
          );
        throw Error("unexpected URL " + u);
      },
    });
    for (const [source, url] of Object.entries(urls)) {
      const result = await input.normalize(url, target);
      assert.equal(result.ok, true, JSON.stringify(result));
      if (source === target) {
        assert.equal(result.translated, false);
        assert.ok(result.query.startsWith("https://"));
      } else {
        assert.equal(result.query, "Artist Song");
        assert.equal(result.translated, true);
      }
    }
  });
test("song link parsing blocks untrusted hosts, credentials, ports and non-track references", async () => {
  let calls = 0;
  const input = create({
    fetchImpl: () => {
      calls++;
      throw Error("unexpected fetch");
    },
  });
  for (const query of [
    "https://open.spotify.com.evil/track/6S2iHbyPSIhQgCyAVQ2SO6",
    "https://user:secret@tidal.com/track/123",
    "https://tidal.com:444/track/123",
    "https://open.spotify.com/playlist/123",
    "https://tidal.com/album/123",
    "http://youtube.com/watch?v=dQw4w9WgXcQ",
  ])
    assert.equal((await input.normalize(query, "soundcloud")).ok, false, query);
  assert.equal(calls, 0);
});
test("metadata failures stay failures instead of searching the raw URL", async () => {
  const input = create({
    fetchImpl: async () => new Response("", { status: 503 }),
  });
  assert.deepEqual(await input.normalize(urls.youtube, "tidal"), {
    ok: false,
    reason: "song_link_metadata_unavailable",
  });
});
