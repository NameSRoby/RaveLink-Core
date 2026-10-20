const test = require("node:test"),
  assert = require("node:assert/strict"),
  { EventEmitter } = require("node:events");
const create = require("../shared-capture.cjs");
test("independent deadlines share one capture; the last consumer awaits confirmed exit", async () => {
  const timers = new Map();
  let starts = 0,
    stops = 0,
    finish;
  const pool = create(
    {
      capture(id, options) {
        starts++;
        assert.equal(options.seconds, 0);
        return {
          events: new EventEmitter(),
          snapshot: () => ({ generation: "a".repeat(32) }),
          done: new Promise((r) => {
            finish = r;
          }),
          stop() {
            stops++;
          },
        };
      },
    },
    {
      schedule: (fn, ms) => {
        const token = {};
        timers.set(token, { fn, ms });
        return token;
      },
      cancel: (token) => timers.delete(token),
    },
  );
  const short = pool.acquire("process:1:2", 5),
    long = pool.acquire("process:1:2", 500);
  assert.equal(starts, 1);
  assert.equal(short.events, long.events);
  timers.values().next().value.fn();
  await short.done;
  assert.equal(stops, 0);
  assert.equal(timers.size, 1);
  assert.equal(pool.active(), true);
  let ended = false;
  long.done.then(() => {
    ended = true;
  });
  long.stop();
  await new Promise(setImmediate);
  assert.equal(ended, false);
  assert.equal(stops, 1);
  assert.equal(timers.size, 0);
  assert.throws(() => pool.acquire("process:1:2", 5), /music_capture_busy/);
  finish({ reason: "parent_stop" });
  await long.done;
  assert.equal(pool.active(), false);
});

test("continuous music has no deadline and outlives a temporary consumer", async () => {
  const timers = new Map();
  let finish,
    stops = 0;
  const pool = create(
    {
      capture(id, options) {
        assert.equal(options.seconds, 0);
        return {
          events: new EventEmitter(),
          snapshot: () => ({}),
          done: new Promise((resolve) => {
            finish = resolve;
          }),
          stop() {
            stops++;
            finish({ reason: "parent_stop" });
          },
        };
      },
    },
    {
      schedule(fn, ms) {
        const token = {};
        timers.set(token, { fn, ms });
        return token;
      },
      cancel(token) {
        timers.delete(token);
      },
    },
  );
  const continuous = pool.acquire("process:1:2", null);
  assert.equal(timers.size, 0);
  const temporary = pool.acquire("process:1:2", 30);
  assert.equal(timers.size, 1);
  [...timers.values()][0].fn();
  await temporary.done;
  assert.equal(stops, 0);
  assert.equal(pool.active(), true);
  assert.equal(timers.size, 0);
  continuous.stop();
  await continuous.done;
  assert.equal(stops, 1);
  assert.equal(pool.active(), false);
});
test("source failure rejects every consumer and clears every timer", async () => {
  let fail;
  const timers = new Set();
  const pool = create(
    {
      capture() {
        return {
          events: new EventEmitter(),
          snapshot: () => ({}),
          stop() {},
          done: new Promise((r, j) => {
            fail = j;
          }),
        };
      },
    },
    {
      schedule: (fn) => {
        timers.add(fn);
        return fn;
      },
      cancel: (t) => timers.delete(t),
    },
  );
  const a = pool.acquire("process:1:2", 1),
    b = pool.acquire("process:1:2", 600);
  const results = Promise.allSettled([a.done, b.done]);
  fail(Error("source_lost"));
  assert.ok((await results).every((r) => r.status === "rejected"));
  assert.equal(timers.size, 0);
  assert.equal(pool.active(), false);
});
