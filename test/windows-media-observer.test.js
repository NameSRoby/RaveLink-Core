const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const createWindowsMediaObserver = require("../src/capabilities/feature-platform/providers/windows-media-observer");

function fakeProcess(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit("exit", 0));
    return true;
  };
  return child;
}

test("Windows media observer preserves Unicode and can switch providers without restarting RaveLink", async () => {
  const children = [];
  const calls = [];
  const observed = [];
  const observer = createWindowsMediaObserver({
    supported: true,
    provider: "tidal",
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = fakeProcess(1000 + children.length);
      children.push(child);
      return child;
    },
    async onSnapshot(snapshot) {
      observed.push(snapshot);
      return { ok: true };
    }
  });

  assert.equal(observer.start().lifecycle, "active");
  assert.deepEqual(calls[0].args.slice(-2), ["-Provider", "tidal"]);
  assert.equal(calls[0].options.windowsHide, true);
  children[0].stdout.write(`${JSON.stringify({ schemaVersion: 2, available: true, source: "TIDAL.Desktop", title: "美波 - カワキヲアメク", artist: "美波", album: "カワキヲアメク", status: "Playing", positionMs: 1234, durationMs: 250000, observedAt: 123456 })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed[0].title, "美波 - カワキヲアメク");
  assert.deepEqual(observed[0].artists, ["美波"]);

  const switched = await observer.control({ action: "select", provider: "spotify" });
  assert.equal(switched.lifecycle, "active");
  assert.equal(switched.selectedProvider, "spotify");
  assert.deepEqual(calls[1].args.slice(-2), ["-Provider", "spotify"]);
  await observer.stop();
  assert.equal(observer.status().lifecycle, "stopped");
});

test("Windows media observer rejects mismatched source applications and unsupported providers", async () => {
  const child = fakeProcess(2000);
  const observed = [];
  const observer = createWindowsMediaObserver({
    supported: true,
    provider: "spotify",
    spawn: () => child,
    onSnapshot: async snapshot => { observed.push(snapshot); return { ok: true }; }
  });
  observer.start();
  child.stdout.write(`${JSON.stringify({ schemaVersion: 2, available: true, source: "Unrelated.Player", title: "Wrong source" })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.length, 0);
  assert.equal(observer.status().counters.malformed, 1);
  assert.equal((await observer.control({ action: "select", provider: "unknown" })).error, "media_provider_invalid");
  await observer.stop();
});
