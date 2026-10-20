const test = require("node:test");
const assert = require("node:assert/strict");
const { createClock } = require("../sample-clock.cjs");
function setup() {
  let at = 100;
  const clock = createClock({ generation: "a".repeat(32), now: () => at });
  const request = JSON.parse(clock.request());
  return {
    clock,
    request,
    set: (v) => {
      at = v;
    },
  };
}
test("clock exchange conservatively includes pipe round trip in feature age", () => {
  const { clock, request, set } = setup();
  assert.equal(clock.age("10000000").verified, false);
  set(110);
  clock.accept({ nonce: request.nonce, qpc100ns: "10000000" });
  set(120);
  assert.deepEqual(clock.age("8000000"), {
    verified: true,
    maxAgeMs: 220,
    uncertaintyMs: 10,
    stale: false,
  });
  set(180);
  assert.equal(clock.age("8000000").stale, true);
  assert.equal(clock.age(null).verified, false);
});
test("unmatched, replayed or high-uncertainty clock replies cannot make samples fresh", () => {
  const first = setup();
  assert.throws(() => first.clock.accept({ nonce: "b".repeat(32), qpc100ns: "1" }), /unmatched/);
  const slow = setup();
  slow.set(201);
  assert.throws(() => slow.clock.accept({ nonce: slow.request.nonce, qpc100ns: "1" }), /uncertain/);
  const good = setup();
  good.set(110);
  good.clock.accept({ nonce: good.request.nonce, qpc100ns: "10000000" });
  assert.throws(
    () => good.clock.accept({ nonce: good.request.nonce, qpc100ns: "10000000" }),
    /unmatched/,
  );
  assert.throws(() => good.clock.age("20000000"), /future/);
  assert.throws(() => good.clock.age("100000000000000"), /epoch_mismatch/);
});

test("continuous audio stays fresh beyond 150 seconds and after hours of playback", () => {
  const { clock, request, set } = setup();
  set(110);
  clock.accept({ nonce: request.nonce, qpc100ns: "10000000" });
  for (const elapsed of [149999, 150001, 180000, 3600000, 24 * 3600000]) {
    set(100 + elapsed);
    const sample = String(10000000n + BigInt(elapsed - 20) * 10000n);
    assert.equal(clock.age(sample).maxAgeMs, 20);
    assert.equal(clock.age(sample).stale, false);
    assert.equal(clock.age(String(BigInt(sample) - 3000000n)).stale, true);
    assert.throws(() => clock.age(String(BigInt(sample) + 1000000n)), /future/);
    if (elapsed > 150000) assert.throws(() => clock.age("10000000"), /epoch_mismatch/);
  }
});
