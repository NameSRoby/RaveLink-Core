const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createSongQueue } = require("../features/song-request/dist/domain");
const source = fs.readFileSync(
  path.join(__dirname, "../features/song-request/ui/player-youtube.js"),
  "utf8",
);
function fixture(ack) {
  let active = { candidate: { providerItemId: "aaaaaaaaaaa" } },
    observed = "aaaaaaaaaaa",
    clock = 0;
  const calls = [],
    timers = new Map();
  let serial = 0,
    pulls = 0;
  const factory = vm.runInNewContext(source + "\ncreateYoutubePlaybackGuard", {
    setTimeout,
    clearTimeout,
    Date,
    Promise,
  });
  const guard = factory({
    current: () => active,
    videoId: () => observed,
    acknowledge: async (state, lease) => {
      calls.push({ state, lease });
      if (ack) return ack(state, lease);
      if (["ended", "failed"].includes(state)) active = null;
      return { ok: true };
    },
    pull: () => {
      pulls++;
    },
    refresh: async () => {},
    notice: () => {},
    now: () => clock,
    schedule: (fn, delay) => {
      timers.set(++serial, { fn, at: clock + delay });
      return serial;
    },
    cancel: (id) => timers.delete(id),
  });
  return {
    guard,
    calls,
    timers,
    setActive: (value) => {
      active = value;
      observed = value?.candidate.providerItemId || "";
    },
    observe: (id) => {
      observed = id;
    },
    advance(ms) {
      clock += ms;
      for (const [id, timer] of timers)
        if (timer.at <= clock) {
          timers.delete(id);
          timer.fn();
        }
    },
    pulls: () => pulls,
  };
}
test("duplicate embed errors settle one lease and pace subsequent requests; three failures stop automatic pulls", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    f.setActive({ candidate: { providerItemId: "aaaaaaaaaaa" } });
    await Promise.all([f.guard.failed(100), f.guard.failed(100), f.guard.ended()]);
    assert.equal(f.calls.length, i + 1);
    assert.equal(f.guard.canPull(), false);
    f.advance(1999);
    assert.equal(f.pulls(), i);
    f.advance(1);
    assert.equal(f.pulls(), Math.min(i + 1, 2));
  }
  f.advance(60000);
  assert.equal(f.pulls(), 2);
  assert.equal(f.guard.resume(), true);
  assert.equal(f.guard.canPull(), true);
});
test("autoplay and player-identification failures keep the request instead of refunding or draining it", async () => {
  const f = fixture();
  f.guard.autoplayBlocked();
  await f.guard.failed(100);
  f.advance(10000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.pulls(), 0);
  f.guard.resume();
  await f.guard.failed(153);
  assert.equal(f.calls.length, 0);
  assert.equal(f.guard.canPull(), false);
});
test("stale video events and unconfirmed outcomes never advance the next request", async () => {
  const f = fixture(async () => null);
  f.observe("bbbbbbbbbbb");
  await f.guard.failed(100);
  assert.equal(f.calls.length, 0);
  f.observe("aaaaaaaaaaa");
  await f.guard.failed(100);
  f.advance(10000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.pulls(), 0);
  assert.equal(f.guard.canPull(), false);
});
test("only confirmed playback can end a lease, and page disposal cancels queued advancement", async () => {
  const f = fixture();
  await f.guard.ended();
  assert.equal(f.calls.length, 0);
  await Promise.all([f.guard.started(), f.guard.started()]);
  assert.equal(f.calls.length, 1);
  await f.guard.ended();
  assert.equal(f.calls.length, 2);
  f.guard.dispose();
  f.advance(10000);
  assert.equal(f.pulls(), 0);
});

test("a closed embed cannot own playback forever; live heartbeats keep its lease and stale tabs cannot acknowledge a replacement", () => {
  let at = 1000;
  const queue = createSongQueue({ now: () => at });
  queue.submit({
    requestId: "owner-fixture",
    requesterId: "fixture-viewer",
    query: "Fixture song",
    candidate: {
      provider: "youtube",
      providerItemId: "aaaaaaaaaaa",
      title: "Fixture song",
      artists: [],
      durationMs: 180000,
    },
  });
  queue.moderate({ action: "playback_start" });
  const first = queue.pull({ driverId: "first-tab", providers: ["youtube"] }).action;
  assert(first);
  assert.equal(
    queue.acknowledge({ driverId: "first-tab", leaseId: first.leaseId, state: "started" }).ok,
    true,
  );
  at += 30000;
  assert.equal(queue.pull({ driverId: "second-tab", providers: ["youtube"] }).action, null);
  queue.acknowledge({ driverId: "first-tab", leaseId: first.leaseId, state: "progress" });
  at += 40000;
  assert.equal(queue.pull({ driverId: "second-tab", providers: ["youtube"] }).action, null);
  at += 20001;
  const replacement = queue.pull({ driverId: "second-tab", providers: ["youtube"] }).action;
  assert.equal(replacement.entryId, first.entryId);
  assert.notEqual(replacement.leaseId, first.leaseId);
  assert.equal(
    queue.acknowledge({ driverId: "first-tab", leaseId: first.leaseId, state: "ended" }).code,
    "lease_stale",
  );
  assert.equal(queue.status().counts.queued, 1);
});
