// [TITLE] Test Module: test/mod-platform.resource-monitor.test.js
// [TITLE] Purpose: verify batched host-observed resource enforcement and zero disabled work

const test = require("node:test");
const assert = require("node:assert/strict");
const createMonitor = require("../src/capabilities/mod-platform/host/mod-resource-monitor");

test("resource monitor batches active PIDs and trips only sustained RSS breaches", async () => {
  let calls = 0;
  const violations = [];
  const monitor = createMonitor({
    breachLimit: 2,
    sample: async (pids) => {
      calls += 1;
      assert.deepEqual(pids, [42]);
      return new Map([[42, { memoryBytes: 80 * 1024 * 1024, cpuTimeMs: calls }]]);
    },
    onViolation: async (modId, violation) => violations.push({ modId, violation }),
  });
  const manifest = { resources: { activeRssMiB: 64, idleCpuPercent: 0.25 } };
  monitor.register("example.heavy", 42, manifest);
  assert.equal(monitor.getStatus().scheduled, true);
  await monitor.sampleOnce();
  assert.equal(violations.length, 0);
  await monitor.sampleOnce();
  assert.equal(violations[0].violation.code, "active_rss_limit");
  monitor.unregister("example.heavy");
  assert.equal(monitor.getStatus().scheduled, false);
  assert.equal((await monitor.sampleOnce()).skipped, true);
  monitor.shutdown();
});

test("resource monitor tolerates sampler failure without disabling mods", async () => {
  const monitor = createMonitor({
    sample: async () => {
      throw new Error("sampler unavailable");
    },
  });
  monitor.register("example.mod", 12, { resources: {} });
  assert.equal((await monitor.sampleOnce()).error, "resource_sample_failed");
  assert.equal(monitor.getStatus().sampleErrors, 1);
  monitor.shutdown();
});
