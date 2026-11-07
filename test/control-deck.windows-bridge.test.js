const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const createBridge = require("../src/domains/control-deck/windows-bridge");
function fixture(options = {}) {
  const children = [],
    sent = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("exit", 1));
    };
    child.stdin.on("data", (data) => sent.push({ child, ...JSON.parse(String(data)) }));
    children.push(child);
    setImmediate(() => child.stdout.write('{"ready":true}\n'));
    return child;
  };
  return { children, sent, bridge: createBridge({ spawnImpl, timeoutMs: 100, ...options }) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("native helper failures kill the owned process and an old exit cannot reject its replacement", async (t) => {
  const { bridge, children, sent } = fixture();
  t.after(() => bridge.shutdown());
  const first = bridge.request("discord.toggle", {}),
    failed = assert.rejects(first, /desktop_helper_unavailable/);
  await tick();
  await tick();
  children[0].stdout.write("invalid JSON\n");
  await failed;
  assert.equal(children[0].killed, true);
  const next = bridge.request("discord.status", {});
  await tick();
  await tick();
  const last = sent.at(-1);
  assert.equal(children.length, 2);
  children[0].emit("exit", 1);
  children[1].stdout.write(
    JSON.stringify({ id: last.id, ok: true, value: { muted: false } }) + "\n",
  );
  assert.deepEqual(await next, { muted: false });
});
test("queued native requests expire without later dispatch", async (t) => {
  const { bridge, sent } = fixture({ timeoutMs: 40 });
  t.after(() => bridge.shutdown());
  const first = bridge.request("slow", {}),
    queued = bridge.request("must-not-run", {});
  const results = await Promise.allSettled([first, queued]);
  await tick();
  await tick();
  assert.equal(
    results.every((r) => r.status === "rejected" && r.reason.code === "desktop_action_timeout"),
    true,
  );
  assert.deepEqual(
    sent.map((item) => item.operation),
    ["slow"],
  );
});
test("aborting a queued request leaves the running helper alone and never sends the cancelled action", async (t) => {
  const { bridge, children, sent } = fixture();
  t.after(() => bridge.shutdown());
  const first = bridge.request("status", {}),
    controller = new AbortController();
  const second = bridge.request("toggle", {}, controller.signal),
    cancelled = assert.rejects(second, /control_deck_cancelled/);
  controller.abort();
  await cancelled;
  await tick();
  await tick();
  assert.equal(children[0].killed, undefined);
  children[0].stdout.write(JSON.stringify({ id: sent[0].id, ok: true, value: true }) + "\n");
  assert.equal(await first, true);
  await tick();
  assert.equal(sent.length, 1);
});
test("native queue is bounded and aborting an active request terminates its helper", async (t) => {
  const { bridge, children } = fixture({ maxPending: 1 });
  t.after(() => bridge.shutdown());
  const controller = new AbortController(),
    first = bridge.request("toggle", {}, controller.signal);
  const cancelled = assert.rejects(first, /control_deck_cancelled/);
  await assert.rejects(bridge.request("excess", {}), /desktop_helper_busy/);
  await tick();
  controller.abort();
  await cancelled;
  assert.equal(children[0].killed, true);
});
