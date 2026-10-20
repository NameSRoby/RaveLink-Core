const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { capture, listSources } = require("../probe.cjs");

class Child extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }
  send(event) {
    this.stdout.write(JSON.stringify(event) + "\n");
  }
  close(code = 0) {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }
  kill() {
    if (!this.killed) {
      this.killed = true;
      queueMicrotask(() => this.close(1));
    }
  }
}
function ready(child, args) {
  const generation = args[6];
  child.send({ v: 2, type: "hello", generation, scope: "process_tree", max_seconds: 1 });
  child.send({
    v: 2,
    type: "ready",
    generation,
    signal: "waiting",
    format: {
      encoding: "f32le",
      sample_rate: 48000,
      channels: 2,
      frame_bytes: 8,
      window_frames: 960,
      analysis: {
        fft_size: 2048,
        hop_frames: 960,
        band_edges_hz: [20, 250, 4000, 20000],
        window: "hann",
        flux: "positive_magnitude_difference",
        onset_refractory_frames: 5760,
      },
    },
  });
  return generation;
}
test("invalid source or duration starts no process", () => {
  let calls = 0;
  const spawn = () => {
    calls++;
  };
  assert.throws(() => capture("auto", { spawn }), /invalid_source/);
  assert.throws(() => capture("process:1:2", { seconds: 3601, spawn }), /invalid_duration/);
  assert.equal(calls, 0);
});

test("one active capture per owner; snapshots retain measured silence separately from lifecycle", async () => {
  const child = new Child();
  let args;
  let at = 0;
  const session = capture("process:10:20", {
    seconds: 1,
    now: () => at,
    spawn: (_file, a) => {
      args = a;
      return child;
    },
  });
  assert.throws(
    () =>
      capture("process:10:20", {
        seconds: 1,
        spawn: () => {
          throw Error("must not launch");
        },
      }),
    /already_running/,
  );
  const generation = ready(child, args);
  session.events.on("update", (event) => {
    event.signal = "tampered";
  });
  child.send({
    v: 2,
    type: "level",
    generation,
    sample_rate: 48000,
    level: {
      first_frame: 0,
      end_frame: 960,
      rms: 0,
      peak: 0,
      dbfs: null,
      channel_rms: [0, 0],
      invalid_samples: 0,
      clipped_samples: 0,
      signal: "silent",
      analysis: null,
    },
    qpc_end_100ns: "12345",
    discontinuities: 0,
  });
  child.send({ v: 2, type: "status", generation, signal: "receiving", last_sample_age_ms: 2 });
  assert.equal(session.snapshot().state, "ready");
  assert.equal(session.snapshot().signal, "silent");
  assert.equal(session.snapshot().lastLevel.rms, 0);
  at = 900;
  assert.equal(session.snapshot().signal, "stale");
  assert.equal(session.snapshot().lastLevel.rms, 0);
  child.send({
    v: 2,
    type: "ended",
    generation,
    reason: "duration",
    packets: 2,
    frames: 960,
    discontinuities: 0,
  });
  child.close();
  await session.done;
});
test("stop closes only the owned helper pipe and confirms native completion", async () => {
  const child = new Child();
  let args, launchOptions;
  const session = capture("process:10:20", {
    seconds: 1,
    spawn: (_file, a, options) => {
      args = a;
      launchOptions = options;
      return child;
    },
  });
  const generation = ready(child, args);
  assert.equal(session.snapshot().lastEvent.signal, "waiting");
  assert.equal(launchOptions.shell, false);
  assert.equal(launchOptions.windowsHide, true);
  child.stdin.once("finish", () => {
    child.send({
      v: 2,
      type: "ended",
      generation,
      reason: "parent_stop",
      packets: 0,
      frames: 0,
      discontinuities: 0,
    });
    child.close();
  });
  session.stop();
  session.stop();
  assert.equal((await session.done).reason, "parent_stop");
  assert.equal(child.killed, false);
  assert.equal(session.snapshot().state, "stopped");
});
test("corrupt or old-generation native data kills the owned child without retries", async () => {
  const child = new Child();
  let calls = 0;
  const session = capture("process:10:20", {
    seconds: 1,
    spawn: () => {
      calls++;
      return child;
    },
  });
  const rejected = assert.rejects(session.done, /stale_generation/);
  child.send({
    v: 2,
    type: "hello",
    generation: "0".repeat(32),
    scope: "process_tree",
    max_seconds: 1,
  });
  await rejected;
  assert.equal(calls, 1);
  assert.equal(child.killed, true);
  assert.equal(session.snapshot().state, "failed");
});
test("a successful process exit without ended is not reported as a successful session", async () => {
  const child = new Child();
  const session = capture("process:10:20", { seconds: 1, spawn: () => child });
  const rejected = assert.rejects(session.done, /unconfirmed_exit/);
  child.close();
  await rejected;
});
test("source query strips private fields and does not start capture", async () => {
  const child = new Child();
  let launchArgs;
  const query = listSources({
    spawn: (_file, args) => {
      launchArgs = args;
      queueMicrotask(() => {
        child.send({
          v: 2,
          type: "sources",
          sources: [
            {
              id: "process:10:20",
              label: "Player.exe",
              kind: "application",
              scope: "process_tree",
              executablePath: "private",
            },
          ],
        });
        child.close();
      });
      return child;
    },
  });
  const sources = await query;
  assert.deepEqual(launchArgs, ["sources"]);
  assert.equal(sources[0].executablePath, undefined);
});

test("cancelled source query launches nothing when already aborted", async () => {
  const abort = new AbortController();
  abort.abort();
  let launches = 0;
  await assert.rejects(
    listSources({ signal: abort.signal, spawn: () => launches++ }),
    /source_query_cancelled/,
  );
  assert.equal(launches, 0);
});

test("revoking an in-flight source query kills only its owned child", async () => {
  const abort = new AbortController(),
    child = new Child();
  const query = listSources({ signal: abort.signal, spawn: () => child });
  const rejected = assert.rejects(query, /source_query_cancelled/);
  abort.abort();
  await rejected;
  assert.equal(child.killed, true);
});

test("finished source query removes its abort listener", async () => {
  const abort = new AbortController(),
    child = new Child();
  const query = listSources({ signal: abort.signal, spawn: () => child });
  child.send({ v: 2, type: "sources", sources: [] });
  child.close();
  assert.deepEqual(await query, []);
  abort.abort();
  assert.equal(child.killed, false);
});
