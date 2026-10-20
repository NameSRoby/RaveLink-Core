const test = require("node:test");
const assert = require("node:assert/strict");
const createOwnership = require("../src/domains/fixtures/fixture-output-ownership.service");
const createQueue = require("../src/domains/fixtures/fixture-output-queue");
const normalizeState = require("../src/domains/fixtures/fixture-output-state");

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function environment(overrides = {}) {
  let at = 0,
    reads = 0;
  const eligible = new Set(["a", "b"]),
    states = new Map([
      ["a", { on: false, bri: 254, ct: 350 }],
      ["b", { on: true, dimming: 35, sceneId: 4, speed: 20 }],
    ]),
    writes = [],
    timers = new Set();
  const service = createOwnership({
    now: () => at,
    isEligible: (id) => eligible.has(id),
    setTimer: () => {
      const t = { unref() {} };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
    readState: async (id) => {
      reads++;
      return { ok: true, state: structuredClone(states.get(id)) };
    },
    writeState: async (id, state) => {
      writes.push({ id, state: structuredClone(state), kind: "write" });
      states.set(id, structuredClone(state));
      return { sent: 1, failed: 0 };
    },
    restoreState: async (id, state) => {
      writes.push({ id, state: structuredClone(state), kind: "restore" });
      states.set(id, structuredClone(state));
      return { sent: 1, failed: 0 };
    },
    ...overrides,
  });
  return {
    service,
    states,
    writes,
    eligible,
    timers,
    set: (v) => {
      at = v;
    },
    get reads() {
      return reads;
    },
  };
}

test("effect preemption resumes the latest music intent and preserves the original native baseline", async () => {
  const e = environment(),
    s = e.service;
  const original = structuredClone(e.states.get("a"));
  const music = await s.acquire({ fixtureId: "a", kind: "music", owner: "music-session" });
  await s.write(music.token, { on: true, bri: 60, ct: 350 }, { sampledAt: 0 });
  const effect = await s.acquire({ fixtureId: "a", kind: "effect", owner: "redemption" });
  assert.equal(
    effect.startingState.bri,
    60,
    "scene fades start from current music, not the original brighter baseline",
  );
  await s.write(effect.token, { on: true, bri: 200, xy: [0.6, 0.3] });
  e.set(100);
  assert.equal(
    (await s.write(music.token, { on: true, bri: 90, ct: 350 }, { sampledAt: 100 })).suspended,
    true,
  );
  await s.release(effect.token);
  assert.deepEqual(e.states.get("a"), { on: true, bri: 90, ct: 350 });
  await s.release(music.token);
  assert.deepEqual(e.states.get("a"), original);
  assert.equal(e.reads, 1);
  assert.equal(e.timers.size, 0);
  assert.equal(s.snapshot().fixtures.length, 0);
});

test("cinematic release interpolates owned states and finishes with the exact native baseline", async () => {
  const e = environment(),
    s = e.service;
  const baseline = structuredClone(e.states.get("a"));
  const lease = await s.acquire({ fixtureId: "a", kind: "music", owner: "cinema" });
  await s.write(lease.token, { on: true, bri: 180, xy: [0.5, 0.3] }, { sampledAt: 0 });
  await s.releaseOwner("cinema", { fadeMs: 500, style: 1 });
  assert(e.writes.some((write) => write.kind === "write" && write.state.bri < 180));
  assert.deepEqual(e.states.get("a"), baseline);
  assert.equal(s.snapshot().fixtures.length, 0);
  await s.shutdown();
});

test("a manual takeover cancels a pending ending and is never overwritten by its final restore", async () => {
  const e = environment(),
    s = e.service;
  const lease = await s.acquire({ fixtureId: "a", kind: "music", owner: "cinema" });
  await s.write(lease.token, { on: true, bri: 180, xy: [0.5, 0.3] }, { sampledAt: 0 });
  const ending = s.releaseOwner("cinema", { fadeMs: 500, style: 2 });
  while (e.writes.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  const manual = { on: true, bri: 72, ct: 400 };
  await s.manualWrite("a", manual);
  const count = e.writes.length;
  await ending;
  assert.deepEqual(e.states.get("a"), manual);
  assert.equal(e.writes.length, count);
  await s.shutdown();
});

test("an effect ending returns to fresh underlying music rather than the historical room state", async () => {
  const e = environment(),
    s = e.service;
  const music = await s.acquire({ fixtureId: "a", kind: "music", owner: "song" });
  const target = { on: true, bri: 75, xy: [0.2, 0.4] };
  await s.write(music.token, target, { sampledAt: 0 });
  const effect = await s.acquire({ fixtureId: "a", kind: "effect", owner: "cinema" });
  await s.write(effect.token, { on: true, bri: 180, xy: [0.5, 0.3] });
  await s.releaseOwner("cinema", { fadeMs: 500, style: 1 });
  assert.deepEqual(e.states.get("a"), target);
  assert.equal(s.has(music.token), true);
  await s.shutdown();
});
test("manual takeover waits for real in-flight writes; a new lease captures the manual state", async () => {
  const slow = deferred(),
    entered = deferred();
  let active = 0,
    peak = 0;
  const actual = { on: false, bri: 10 };
  const delivered = [];
  const e = environment({
      readState: async () => ({ ok: true, state: { ...actual } }),
      writeState: async (_id, state) => {
        active++;
        peak = Math.max(peak, active);
        delivered.push(state.bri);
        if (state.bri === 60) {
          entered.resolve();
          await slow.promise;
        }
        Object.assign(actual, state);
        active--;
        return { sent: 1, failed: 0 };
      },
    }),
    s = e.service;
  const music = await s.acquire({ fixtureId: "a", kind: "music", owner: "music" });
  const first = s.write(music.token, { on: true, bri: 60 }, { sampledAt: 0 });
  await entered.promise;
  const obsolete = s.write(music.token, { on: true, bri: 80 }, { sampledAt: 0 });
  const manual = s.manualWrite("a", { on: true, bri: 150 });
  const next = s.acquire({ fixtureId: "a", kind: "effect", owner: "next-effect" });
  slow.resolve();
  await first;
  await obsolete;
  await manual;
  const lease = await next;
  assert.equal(lease.baseline.bri, 150);
  assert.deepEqual(delivered, [60, 150]);
  assert.equal(peak, 1);
  await assert.rejects(
    s.write(music.token, { on: true, bri: 30 }, { sampledAt: 0 }),
    /expired_or_replaced/,
  );
  await s.release(lease.token);
  await s.shutdown();
});
test("replacement while restoration is in flight retains baseline and fences the old owner", async () => {
  const entered = deferred(),
    finish = deferred();
  let restores = 0;
  const e = environment({
      restoreState: async () => {
        restores++;
        if (restores === 1) {
          entered.resolve();
          await finish.promise;
        }
        return { sent: 1, failed: 0 };
      },
    }),
    s = e.service;
  const first = await s.acquire({ fixtureId: "a", kind: "effect", owner: "one" });
  await s.write(first.token, { on: true, bri: 80 });
  const restoring = s.release(first.token);
  await entered.promise;
  const second = await s.acquire({ fixtureId: "a", kind: "effect", owner: "two" });
  assert.deepEqual(second.baseline, { on: false, bri: 254, ct: 350 });
  const writing = s.write(second.token, { on: true, bri: 200 });
  finish.resolve();
  await restoring;
  await writing;
  await s.release(second.token);
  assert.equal(restores, 2);
  assert.equal(e.reads, 1);
});
test("expired/silent-source owners restore rather than replay stale music", async () => {
  const e = environment(),
    s = e.service;
  const music = await s.acquire({ fixtureId: "a", kind: "music", owner: "music", ttlMs: 500 });
  await s.write(music.token, { on: true, bri: 80 }, { sampledAt: 0 });
  const effect = await s.acquire({ fixtureId: "a", kind: "effect", owner: "effect", ttlMs: 1000 });
  await s.write(effect.token, { on: true, bri: 180 });
  e.set(400);
  await assert.rejects(
    s.write(music.token, { on: true, bri: 90 }, { sampledAt: 0 }),
    /stale_music/,
  );
  await s.release(effect.token);
  assert.deepEqual(e.states.get("a"), { on: false, bri: 254, ct: 350 });
  e.set(501);
  await s.expire();
  assert.equal(s.has(music.token), false);
  assert.equal(e.timers.size, 0);
});
test("expiry returns to a fresh suspended music owner; owner crash releases only its fixtures", async () => {
  const e = environment(),
    s = e.service;
  const music = await s.acquire({ fixtureId: "a", kind: "music", owner: "music", ttlMs: 2000 });
  const other = await s.acquire({ fixtureId: "b", kind: "effect", owner: "other" });
  const effect = await s.acquire({ fixtureId: "a", kind: "effect", owner: "effect", ttlMs: 500 });
  await s.write(effect.token, { on: true, bri: 180 });
  e.set(450);
  await s.write(music.token, { on: true, bri: 70 }, { sampledAt: 450 });
  e.set(501);
  await s.expire();
  assert.deepEqual(e.states.get("a"), { on: true, bri: 70 });
  await s.releaseOwner("music");
  assert.equal(s.has(other.token), true);
  assert.equal(e.writes.filter((w) => w.id === "b").length, 0);
  await s.shutdown();
  assert.deepEqual(e.states.get("b"), { on: true, dimming: 35, sceneId: 4, speed: 20 });
});
test("missing baselines, unauthorized targets and private state cannot start output", async () => {
  const e = environment({ readState: async () => ({ ok: false }) }),
    s = e.service;
  await assert.rejects(
    s.acquire({ fixtureId: "a", kind: "music", owner: "music" }),
    /baseline_unavailable/,
  );
  await assert.rejects(
    s.acquire({ fixtureId: "unknown", kind: "music", owner: "music" }),
    /not_eligible/,
  );
  assert.equal(e.writes.length, 0);
  assert.equal(e.timers.size, 0);
  assert.throws(
    () => normalizeState({ on: true, username: "secret" }),
    /invalid_fixture_output_state/,
  );
  assert.throws(
    () => normalizeState(JSON.parse('{"__proto__":{"polluted":true}}')),
    /invalid_fixture_output_state/,
  );
  assert.equal({}.polluted, undefined);
  assert.equal(s.snapshot().fixtures.length, 0);
});
test("read pending at manual takeover cannot publish a stale grant", async () => {
  const read = deferred(),
    entered = deferred();
  const e = environment({
      readState: async () => {
        entered.resolve();
        await read.promise;
        return { ok: true, state: { on: false, bri: 10 } };
      },
    }),
    s = e.service;
  const acquiring = s.acquire({ fixtureId: "a", kind: "music", owner: "music" });
  const rejected = assert.rejects(acquiring, /superseded/);
  await entered.promise;
  const manual = s.manualWrite("a", { on: true, bri: 120 });
  read.resolve();
  await rejected;
  await manual;
  assert.deepEqual(e.states.get("a"), { on: true, bri: 120 });
  assert.equal(e.timers.size, 0);
});
test("removed fixtures invalidate tokens and shutdown restores only live owned targets", async () => {
  const e = environment(),
    s = e.service;
  const a = await s.acquire({ fixtureId: "a", kind: "effect", owner: "a" });
  await s.write(a.token, { on: true, bri: 100 });
  s.removeFixture("a");
  e.eligible.delete("a");
  await assert.rejects(s.write(a.token, { on: true, bri: 200 }), /expired_or_replaced/);
  await s.shutdown();
  assert.equal(e.writes.length, 1);
  assert.equal(e.timers.size, 0);
  await assert.rejects(s.acquire({ fixtureId: "b", kind: "effect", owner: "b" }), /closed/);
});
test("lease limits, replacement authority and failed restore results are explicit", async () => {
  const e = environment({ maximum: 1, restoreState: async () => ({ sent: 0, failed: 1 }) }),
    s = e.service;
  const first = await s.acquire({ fixtureId: "a", kind: "effect", owner: "a" });
  await assert.rejects(s.acquire({ fixtureId: "b", kind: "effect", owner: "b" }), /limit/);
  await assert.rejects(
    s.acquire({ fixtureId: "a", kind: "effect", owner: "other", replaceToken: first.token }),
    /already_owned/,
  );
  const second = await s.acquire({
    fixtureId: "a",
    kind: "effect",
    owner: "a",
    replaceToken: first.token,
  });
  assert.equal(s.has(first.token), false);
  const result = await s.release(second.token);
  assert.equal(result.failed, 1);
  assert.equal(s.snapshot().lastFault.code, "fixture_delivery_unconfirmed");
  assert.equal(e.timers.size, 0);
});
test("timing out a transport never permits a second actual operation to overlap it", async () => {
  const queue = createQueue({ timeoutMs: 10 }),
    late = deferred();
  let active = 0,
    peak = 0;
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const first = queue.submit("a", async () => {
      active++;
      peak = Math.max(peak, active);
      await late.promise;
      active--;
      return 1;
    });
    await assert.rejects(first, /timeout/);
    const pending = queue.submit("a", async () => {
      active++;
      peak = Math.max(peak, active);
      active--;
      return 2;
    });
    await assert.rejects(pending, /timeout/);
    assert.equal(peak, 1);
    assert.equal(queue.snapshot().busy, 1);
    late.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await queue.submit("a", async () => 3), 3);
    assert.equal(peak, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});
