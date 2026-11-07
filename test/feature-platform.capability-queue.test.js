const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../src/capabilities/supervised-runtime/runtime/capability-call-queue");
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("feature background work shares bounded broker slots without replaying commands", async () => {
  const queue = create({ limit: 2, capacity: 2 }),
    releases = [],
    calls = [];
  const run = (id) =>
    queue.run((remaining) => {
      assert(remaining > 0 && remaining <= 1000);
      calls.push(id);
      return new Promise((resolve) => releases.push(() => resolve(id)));
    }, 1000);
  const jobs = [run(1), run(2), run(3), run(4)];
  await tick();
  assert.deepEqual(calls, [1, 2]);
  await assert.rejects(run(5), /broker_busy/);
  releases.shift()();
  assert.equal(await jobs[0], 1);
  await tick();
  assert.deepEqual(calls, [1, 2, 3]);
  releases.shift()();
  await jobs[1];
  await tick();
  assert.deepEqual(calls, [1, 2, 3, 4]);
  for (const release of releases) release();
  assert.deepEqual(await Promise.all(jobs), [1, 2, 3, 4]);
  queue.close();
});
test("expired or shutdown queued commands are never dispatched", async () => {
  const queue = create({ limit: 1, capacity: 2 });
  let release,
    calls = 0;
  const first = queue.run(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    1000,
  );
  await tick();
  await assert.rejects(
    queue.run(() => {
      calls++;
    }, 15),
    /deadline_exceeded/,
  );
  const waiting = queue.run(() => {
      calls++;
    }, 1000),
    rejected = assert.rejects(waiting, /workload_shutdown/);
  queue.close();
  await rejected;
  release();
  await first;
  assert.equal(calls, 0);
});
