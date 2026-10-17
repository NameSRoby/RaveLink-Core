const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../src/capabilities/feature-platform/providers/soundcloud-catalog-provider");
const { track, html } = require("./support/soundcloud-catalog-fixture.cjs");
const reply = (body) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

test("SoundCloud transfer search provides a bounded eligible shortlist without changing ordinary request replies", async () => {
  const api = create({
    fetchImpl: async (url) =>
      reply(
        html(url.searchParams.get("q"), [
          track(1, "Song"),
          track(2, "Song"),
          track(3, "Song"),
          track(4, "Song"),
          track(5, "Song remix"),
        ]),
      ),
  });
  const ordinary = await api.resolve({ query: "Fixture Artist Song" });
  assert.equal(ordinary.candidates, undefined);
  const transfer = await api.resolve({
    query: "Fixture Artist Song",
    transfer: true,
    policy: { minimumConfidence: 0.5 },
  });
  assert.equal(transfer.candidates.length, 3);
  assert.ok(
    transfer.candidates.every((row) => row.matchConfidence >= 50 && !row.title.includes("remix")),
  );
});
test("SoundCloud public search uses shared fuzzy/version matching, bounded metadata and no credentials", async () => {
  let calls = 0;
  const api = create({
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url.hostname, "m.soundcloud.com");
      assert.equal(url.pathname, "/search/sounds");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.authorization, undefined);
      assert.equal(init.headers.cookie, undefined);
      return reply(
        html(url.searchParams.get("q"), [
          track(1, "Terror Ried Uppercuts FREESTYLE", "Another uploader"),
          track(2, "UPPERCUTS", "Terror Reid"),
          track(3, "UPPERCUTS (Remix)", "Terror Reid"),
        ]),
      );
    },
  });
  const found = await api.resolve({ query: "Terror Ried Uppercuts" });
  assert.equal(found.candidate.providerItemId, "2");
  assert.equal(found.candidate.artists[0], "Terror Reid");
  assert.ok(found.evidence.confidence > 0.7);
  assert.equal(found.candidate.album, "Fixture album");
  assert.equal(
    (
      await api.resolve({
        query: "Terror Ried Uppercuts",
        maxDurationMs: 60000,
      })
    ).reason,
    "duration_limit",
  );
  assert.equal(calls, 1, "cached search still reapplies the current duration policy");
  assert.equal(
    (await api.resolve({ query: "Terror Reid Uppercuts remix" })).candidate.providerItemId,
    "3",
  );
});
test("SoundCloud declines preview/private/unembeddable results and preserves explicitly requested versions", async () => {
  const blocked = [
    track(1, "Song cover"),
    track(2, "Song", undefined, { policy: "SNIP" }),
    track(3, "Song", undefined, { full_duration: 250000 }),
    track(4, "Song", undefined, { sharing: "private" }),
    track(5, "Song", undefined, { embeddable_by: "none" }),
  ];
  const api = create({
    fetchImpl: async (url) => reply(html(url.searchParams.get("q"), blocked)),
  });
  assert.equal(
    (await api.resolve({ query: "Fixture Artist Song" })).reason,
    "soundcloud_no_eligible_match",
  );
  const wrongRemix = create({
    fetchImpl: async (url) =>
      reply(html(url.searchParams.get("q"), [track(7, "Different Song Remix")])),
  });
  assert.equal(
    (await wrongRemix.resolve({ query: "Fixture Artist Melody remix" })).reason,
    "soundcloud_no_eligible_match",
  );
  const originalOnly = create({
    fetchImpl: async (url) => reply(html(url.searchParams.get("q"), [track(6, "Song")])),
  });
  assert.equal(
    (await originalOnly.resolve({ query: "Fixture Artist Song remix" })).reason,
    "soundcloud_no_eligible_match",
  );
});
test("SoundCloud resolver coalesces pending work, limits requests and rejects malformed links before egress", async () => {
  let calls = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const api = create({
    fetchImpl: async (url) => {
      calls++;
      await gate;
      return reply(html(url.searchParams.get("q"), [track(1)]));
    },
  });
  const first = api.resolve({ query: "Fixture Artist Query Song" }),
    second = api.resolve({ query: "Fixture Artist Query Song" });
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  for (const query of [
    "http://127.0.0.1/internal",
    "https://evil.example/track",
    "https://soundcloud.com/artist/sets/list",
    "hello\nworld",
  ])
    assert.equal((await api.resolve({ query })).ok, false);
  assert.equal(calls, 1);
  const rate = create({
    fetchImpl: async (url) => reply(html(url.searchParams.get("q"), [])),
  });
  for (let i = 0; i < 60; i++) await rate.resolve({ query: "Different query " + i });
  assert.equal(
    (await rate.resolve({ query: "Another query" })).reason,
    "soundcloud_search_rate_limited",
  );
});

test("local SoundCloud allowance permits sixty new lookups and reports the remaining window precisely", async () => {
  let at = 0,
    calls = 0;
  const api = create({
    now: () => at,
    fetchImpl: async (url) => {
      calls++;
      return reply(html(url.searchParams.get("q"), []));
    },
  });
  for (let i = 0; i < 60; i++) await api.resolve({ query: "Budget query " + i });
  at = 45000;
  const held = await api.resolve({ query: "New query" });
  assert.equal(held.rateLimitSource, "local");
  assert.equal(held.retryAfterMs, 15000);
  assert.equal(calls, 60);
  await api.resolve({ query: "Budget query 0" });
  assert.equal(calls, 60, "cache hits do not consume allowance");
  at = 60000;
  await api.resolve({ query: "New query" });
  assert.equal(calls, 61, "the exact window boundary releases allowance");
});

test("SoundCloud 429 backoff honors Retry-After and prevents new outbound lookups during that pause", async () => {
  for (const [header, delay] of [
    ["90", 90000],
    [new Date(45000).toUTCString(), 45000],
    ["0", 1000],
    [new Date(-10000).toUTCString(), 1000],
    [null, 60000],
  ]) {
    let at = 0,
      calls = 0;
    const api = create({
      now: () => at,
      fetchImpl: async (url) => {
        calls++;
        return calls === 1
          ? new Response("", {
              status: 429,
              headers: header ? { "retry-after": header } : {},
            })
          : reply(html(url.searchParams.get("q"), []));
      },
    });
    const first = await api.resolve({ query: "Provider pause" });
    assert.equal(first.rateLimitSource, "soundcloud");
    assert.equal(first.retryAfterMs, delay);
    at = 100;
    const held = await api.resolve({ query: "Different query" });
    assert.equal(held.retryAfterMs, Math.max(1000, delay - 100));
    assert.equal(calls, 1);
    at = delay;
    await api.resolve({ query: "Different query" });
    assert.equal(calls, 2);
  }
});

test("a full SoundCloud concurrency slot reports a short retry without consuming another lookup", async () => {
  let release,
    calls = 0;
  const gate = new Promise((resolve) => (release = resolve));
  const api = create({
    fetchImpl: async (url) => {
      calls++;
      await gate;
      return reply(html(url.searchParams.get("q"), []));
    },
  });
  const first = api.resolve({ query: "First pending" }),
    second = api.resolve({ query: "Second pending" });
  const busy = await api.resolve({ query: "Third pending" });
  assert.equal(busy.rateLimitSource, "concurrency");
  assert.equal(busy.retryAfterMs, 1000);
  assert.equal(calls, 2);
  release();
  await Promise.all([first, second]);
  await api.resolve({ query: "Third pending" });
  assert.equal(calls, 3);
});
test("SoundCloud public page changes and oversized replies fail visibly without executing page scripts", async () => {
  for (const [body, reason] of [
    ['<script>throw new Error("Never run")</script>', "soundcloud_search_page_changed"],
    ["x".repeat(1048577), "soundcloud_search_response_too_large"],
  ]) {
    const api = create({ fetchImpl: async () => reply(body) });
    assert.equal((await api.resolve({ query: "Artist Song" })).reason, reason);
  }
  const direct = create({
    fetchImpl: async (url) => {
      assert.equal(url.pathname, "/fixture/track-1");
      return reply(html("", [track(1)]));
    },
  });
  assert.equal(
    (await direct.resolve({ query: "https://soundcloud.com/fixture/track-1" })).candidate
      .providerItemId,
    "1",
  );
});
test("shared Song Request intake resolves text for the saved SoundCloud player and preserves viewer identity", async (t) => {
  const feature = require("../features/song-request/dist/main");
  const { createFeatureRuntimeHarness } = require("./support/feature-runtime-harness");
  let player = "soundcloud",
    sc = 0,
    yt = 0,
    available = true;
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers: {
      "ravelink.storage.v1/get": async (input) =>
        input.key === "player-preferences-v1"
          ? { ok: true, found: true, value: { player } }
          : { ok: true, found: false },
      "ravelink.storage.v1/set": async (input) => {
        if (input.key === "player-preferences-v1") player = input.value.player;
        return { ok: true };
      },
      "soundcloud.catalog.host.v1/resolve": async (input) => {
        sc++;
        if (!available) return { ok: false, reason: "soundcloud_no_eligible_match" };
        assert.equal(input.query, "Fixture Artist Query Song");
        return {
          ok: true,
          candidate: {
            provider: "soundcloud",
            providerItemId: "42",
            title: "Query Song",
            artists: ["Fixture Artist"],
            durationMs: 180000,
          },
        };
      },
      "youtube.catalog.host.v1/resolve": async () => {
        yt++;
        return {
          ok: true,
          candidate: {
            provider: "youtube",
            providerItemId: "dQw4w9WgXcQ",
            title: "Other Song",
            artists: [],
            durationMs: 120000,
          },
        };
      },
    },
  });
  await harness.start();
  t.after(() => harness.stop());
  const result = await harness.request("song.queue.submit.v1", "submit", {
    requestId: "chat-1",
    requesterId: "viewer-1",
    requesterName: "Actual Viewer",
    requesterRole: "vip",
    query: "Fixture Artist Query Song",
    notifyChat: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.entry.candidate.provider, "soundcloud");
  assert.equal(result.entry.requesterLabel, "Actual Viewer");
  assert.equal(result.entry.requesterRole, "vip");
  assert.equal(sc, 1);
  assert.equal(yt, 0);
  await harness.request("song.player.preferences.v1", "select", {
    player: "youtube",
  });
  assert.equal(
    (
      await harness.request("song.queue.submit.v1", "submit", {
        requestId: "chat-2",
        requesterId: "viewer-1",
        query: "Other Song",
      })
    ).entry.candidate.provider,
    "youtube",
  );
  assert.equal(yt, 1);
  assert.equal(sc, 1);
  await harness.request("song.player.preferences.v1", "select", {
    player: "soundcloud",
  });
  available = false;
  assert.equal(
    (
      await harness.request("song.queue.submit.v1", "submit", {
        requestId: "failed-sc",
        requesterId: "viewer-2",
        query: "Unmatched Song",
      })
    ).reason,
    "soundcloud_no_eligible_match",
  );
  assert.equal(yt, 1, "SoundCloud failure must never fall back to another service");
});
