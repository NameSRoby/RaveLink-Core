const test = require("node:test"),
  assert = require("node:assert/strict");
const review = require("../features/song-request/dist/playlist-transfer-review");
const catalog = require("../features/song-request/dist/playlist-transfer-catalog");
const choice = (score, extra = {}) => ({
  score,
  providerItemId: String(score),
  ...extra,
});

test("ordinary review pages only read displayed rows and preserve independent row objects", () => {
  const rows = Array.from({ length: 10000 }, (_, index) => ({
    title: String(index),
  }));
  let reads = 0;
  const observed = new Proxy(rows, {
    get(target, property, receiver) {
      if (/^\d+$/.test(String(property))) reads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = review.page(observed, { offset: 9996 });
  assert.deepEqual(
    result.rows.map((row) => row.index),
    [9996, 9997, 9998, 9999],
  );
  assert.equal(reads, 4);
  assert.deepEqual(result.page, { offset: 9996, total: 10000, hasMore: false });
  result.rows[0].title = "edited page";
  assert.equal(rows[9996].title, "9996");
  assert.equal(review.page(rows, { offset: 10001 }).rows.length, 0);
  assert.equal(review.page(rows, { offset: 2.9 }).rows[0].index, 2);
});
test("percentage selection preserves manual choices and rejects different recording versions", () => {
  const rows = [50, 60, 70, 95].map((score) => ({
    choices: [choice(score)],
    include: true,
  }));
  rows.push({ choices: [choice(99)], manuallyReviewed: true, selected: null });
  rows.push({ choices: [choice(100, { autoSelectable: false })] });
  review.accept(rows, 60);
  assert.deepEqual(
    rows.map((row) => row.selected?.score || null),
    [null, 60, 70, 95, null, null],
  );
  rows[1].manuallyReviewed = true;
  review.accept(rows, 70);
  assert.deepEqual(
    rows.map((row) => row.selected?.score || null),
    [null, 60, 70, 95, null, null],
  );
  review.accept(rows, 50);
  assert.equal(rows[0].selected.score, 50);
  for (const value of [49, 101, 60.5])
    assert.throws(() => review.accept(rows, value), /threshold_invalid/);
});
test("weakest-first and filtered review retain original row identities for edits", () => {
  const rows = [
    { choices: [choice(95)], selected: choice(95) },
    { choices: [] },
    { choices: [choice(60)] },
    { choices: [choice(70)], selected: choice(70) },
  ];
  assert.deepEqual(
    review.page(rows, { review: "weakest" }).rows.map((row) => row.index),
    [1, 2, 3, 0],
  );
  assert.deepEqual(
    review.page(rows, { review: "needs_review", threshold: 80 }).rows.map((row) => row.index),
    [1, 2, 3],
  );
  assert.deepEqual(
    review.page(rows, { review: "unmatched" }).rows.map((row) => row.index),
    [1],
  );
});
test("adaptive SoundCloud fallback compares title search results against the original artist query", async () => {
  const calls = [],
    source = {
      provider: "tidal",
      providerItemId: "1",
      title: "Song",
      artists: ["Artist"],
      durationMs: 180000,
    };
  const match = catalog({
    callCapability: async (capability, method, input) => {
      calls.push(input);
      if (calls.length === 1) return { ok: false, reason: "soundcloud_no_eligible_match" };
      return {
        ok: true,
        candidates: [
          {
            ...source,
            provider: "soundcloud",
            providerItemId: "2",
            matchConfidence: 90,
          },
        ],
      };
    },
  });
  const result = await match(source, "soundcloud");
  assert.equal(result.choices[0].providerItemId, "2");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].query, "Song");
  assert.equal(calls[1].matchQuery, "Artist Song");
  calls.length = 0;
  await match(source, "soundcloud", false);
  assert.equal(calls.length, 1);
});
test("adaptive matching respects catalog backoff without issuing extra searches", async () => {
  let calls = 0;
  const match = catalog({
    callCapability: async () => {
      calls++;
      return {
        ok: false,
        reason: "soundcloud_search_rate_limited",
        rateLimitSource: "local",
        retryAfterMs: 15000,
      };
    },
  });
  const result = await match({ title: "Song", artists: ["Artist"] }, "soundcloud");
  assert.equal(result.error, "soundcloud_search_rate_limited");
  assert.equal(calls, 1);
  assert.equal(result.retryAfterMs, 15000);
  assert.equal(result.rateLimitSource, "local");
});

test("transfers use the advertised retry time and clear stale waiting status after an unmatched row", async () => {
  const step = require("../features/song-request/dist/playlist-transfer-match-step");
  const job = { processed: 0, target: "soundcloud" },
    rows = [{ track: { candidate: { title: "Song" } } }];
  let result = {
    ok: false,
    error: "soundcloud_search_rate_limited",
    rateLimitSource: "local",
    retryAfterMs: 1500,
  };
  const context = {
    job,
    rows,
    match: async () => result,
    store: { page: async () => {} },
    save: async () => {},
  };
  const before = Date.now();
  await step(context);
  assert.ok(job.retryAt >= before + 1500 && job.retryAt <= Date.now() + 1500);
  assert.equal(job.processed, 0);
  assert.equal(job.rateLimitSource, "local");
  result = { ok: false, error: "soundcloud_no_eligible_match" };
  await step(context);
  assert.equal(job.processed, 1);
  assert.equal(job.retryAt, 0);
  assert.equal(job.error, "");
  assert.equal(job.rateLimitSource, "");
});

test("loaded playlist CSV export preserves repeats and order, skips excluded rows, and rejects changed or busy jobs", () => {
  const source = require("../features/song-request/dist/playlist-export-source");
  const page = require("../features/song-request/dist/playlist-transfer-export-page");
  const track = (id) => ({
    candidate: {
      provider: "tidal",
      providerItemId: id,
      title: "Song " + id,
      artists: ["Artist"],
    },
  });
  const rows = [
    { track: track("1") },
    { track: track("2"), include: false },
    { track: track("1") },
  ];
  const job = { id: "job", state: "review", name: "Source", revision: 7 };
  const args = {
    library: { get: () => null },
    job,
    rows,
    input: { jobId: "job", action: "export_csv" },
    offset: 0,
  };
  assert.deepEqual(
    source(args).tracks.map((row) => row.candidate.providerItemId),
    ["1", "1"],
  );
  assert.equal(page(args).count, 2);
  assert.equal((page(args).csv.match(/Song 1/g) || []).length, 2);
  assert.throws(() => source({ ...args, input: { jobId: "other" } }), /transfer_changed/);
  assert.throws(() => source({ ...args, job: { ...job, state: "matching" } }), /transfer_busy/);
  assert.throws(
    () => page({ ...args, input: { ...args.input, revision: 6 } }),
    /playlist_changed_export_again/,
  );
});
