const test = require("node:test");
const assert = require("node:assert/strict");

const createLifecycleRegistry = require("../src/domains/system/lifecycle-registry");
const { MAX_ENTRIES } = createLifecycleRegistry;

test("lifecycle registry attributes bounded work and stops in reverse order", async () => {
  let clock = 100;
  const stopped = [];
  const registry = createLifecycleRegistry({ now: () => ++clock });
  registry.register({
    owner: "core",
    id: "first",
    type: "timer",
    stop: () => stopped.push("first"),
  });
  registry.register({
    owner: "feature.test",
    id: "second",
    type: "watcher",
    deadlineAt: 500,
    stop: () => stopped.push("second"),
  });
  assert.deepEqual(
    registry.snapshot().map((row) => row.owner),
    ["core", "feature.test"],
  );
  const results = await registry.stopAll();
  assert.deepEqual(stopped, ["second", "first"]);
  assert.equal(
    results.every((row) => row.ok),
    true,
  );
  assert.deepEqual(registry.snapshot(), []);
});

test("lifecycle registry rejects duplicates, invalid labels, and excess work", () => {
  const registry = createLifecycleRegistry();
  registry.register({ owner: "core", id: "same", stop() {} });
  assert.throws(
    () => registry.register({ owner: "core", id: "same", stop() {} }),
    /already registered/,
  );
  assert.throws(
    () => registry.register({ owner: "private user", id: "bad", stop() {} }),
    /bounded tokens/,
  );
  for (let index = 1; index < MAX_ENTRIES; index += 1) {
    registry.register({ owner: "core", id: `work-${index}`, stop() {} });
  }
  assert.throws(
    () => registry.register({ owner: "core", id: "overflow", stop() {} }),
    /limit reached/,
  );
});

test("concurrent shutdown callers share one reverse-order drain, including failures", async () => {
  const registry = createLifecycleRegistry();
  const calls = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  registry.register({
    owner: "core",
    id: "first",
    stop() {
      calls.push("first");
    },
  });
  registry.register({
    owner: "core",
    id: "last",
    async stop() {
      calls.push("last");
      await pending;
      throw new Error("cleanup failed");
    },
  });
  const first = registry.stopAll();
  const second = registry.stopAll();
  assert.equal(first, second);
  assert.deepEqual(calls, ["last"]);
  assert.throws(() => registry.register({ owner: "core", id: "late", stop() {} }), /stopping/);
  release();
  const results = await first;
  assert.deepEqual(calls, ["last", "first"]);
  assert.deepEqual(
    results.map((row) => row.ok),
    [false, true],
  );
  assert.equal(await registry.stopAll(), results);
  assert.deepEqual(registry.snapshot(), []);
});
