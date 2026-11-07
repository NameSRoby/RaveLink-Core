const test = require("node:test"),
  assert = require("node:assert/strict");
const make =
  require("../src/capabilities/feature-platform/providers/twitch-api-client").createTwitchApiClient;
const credentials = { accessToken: "private-token", clientId: "fixture", userId: "123" };
function response(body, status = 200) {
  return { ok: status === 200, status, text: async () => JSON.stringify(body) };
}
test("official dashboard queries normalize totals without forwarding user tokens or subscriber identities", async () => {
  const calls = [],
    api = make({
      fetch: async (url, init) => {
        calls.push({ url, init });
        const p = new URL(url).pathname;
        if (p.endsWith("/streams"))
          return response({
            data: [
              {
                id: "99",
                started_at: "2026-01-01T00:00:00Z",
                title: "Stream",
                viewer_count: 12,
                game_name: "Game",
              },
            ],
          });
        if (p.endsWith("/followers")) return response({ total: 200, data: [] });
        return response({ total: 25, points: 30, data: [{ user_id: "private-subscriber-id" }] });
      },
    });
  assert.equal((await api.dashboardStream({ credentials })).viewers, 12);
  assert.equal((await api.dashboardFollowers({ credentials })).total, 200);
  const subs = await api.dashboardSubscribers({ credentials });
  assert.equal(subs.total, 25);
  assert(!JSON.stringify(subs).includes("private-"));
  assert(calls.every((c) => c.init.headers.Authorization === "Bearer private-token"));
});
test("clip counts remain bounded and VOD associations use the actual stream ID", async () => {
  let pages = 0;
  const api = make({
    fetch: async (url) => {
      if (new URL(url).pathname.endsWith("/clips")) {
        pages++;
        return response({
          data: [
            {
              id: "Clip" + pages,
              title: "Clip",
              created_at: "2026-01-01T01:00:00Z",
              creator_name: "Viewer",
            },
          ],
          pagination: { cursor: "more" },
        });
      }
      return response({
        data: [
          { id: "77", stream_id: "99" },
          { id: "88", stream_id: "another" },
        ],
      });
    },
  });
  const clips = await api.dashboardClips({ credentials, startedAt: Date.parse("2026-01-01") });
  assert.equal(pages, 3);
  assert.equal(clips.complete, false);
  assert.equal(clips.count, 3);
  assert.deepEqual((await api.dashboardVod({ credentials, streamIds: ["99"] })).videos, [
    { streamId: "99", videoId: "77" },
  ]);
});
test("marker success requires a confirmed Twitch position and uncertain POSTs are never retried", async () => {
  let calls = 0;
  const api = make({
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init.method, "POST");
      return response({}, 504);
    },
  });
  const result = await api.createStreamMarker({ credentials, description: "Highlight" });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});
