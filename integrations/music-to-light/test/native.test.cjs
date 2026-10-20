/** Explicit, optional OS acceptance. It captures only this silent test process,
 * never an operator's music, desktop mix or microphone. Build the helper first
 * and set RAVELINK_AUDIO_NATIVE_ACCEPTANCE=1 to admit these live Windows checks.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const path = require("node:path");
const { capture, identify } = require("../probe.cjs");
const enabled =
  process.platform === "win32" && process.env.RAVELINK_AUDIO_NATIVE_ACCEPTANCE === "1";

test(
  "continuous native capture survives its former deadline and stops on the parent pipe",
  { skip: !enabled },
  async () => {
    const own = await identify(process.pid);
    const session = capture(own.id, { seconds: 0 });
    let windows = 0;
    let logWindows = 0;
    session.events.on("update", (event) => {
      if (event.type === "level") {
        windows++;
        if (event.analysis) {
          assert(Object.hasOwn(event.analysis, "logOnset"));
          assert(Number.isFinite(event.analysis.logSpectralFlux));
          assert(Number.isFinite(event.analysis.logOnsetThreshold));
          logWindows++;
        }
      }
    });
    let ended = false;
    session.done.then(
      () => {
        ended = true;
      },
      () => {
        ended = true;
      },
    );
    try {
      const duration = process.env.RAVELINK_AUDIO_LONG_ACCEPTANCE === "1" ? 160000 : 8500;
      await new Promise((resolve) => setTimeout(resolve, duration));
      assert.equal(ended, false, "zero must not become an eight-second watchdog deadline");
      assert(windows >= 200);
      assert(logWindows >= 200);
      assert.equal(session.snapshot().freshness.verified, true);
      assert.equal(session.snapshot().freshness.stale, false);
    } finally {
      session.stop();
      assert.equal((await session.done).reason, "parent_stop");
    }
  },
);

test(
  "real process loopback measures silence in complete windows and stops",
  { skip: !enabled },
  async () => {
    const own = await identify(process.pid);
    const session = capture(own.id, { seconds: 1 });
    let windows = 0;
    session.events.on("update", (event) => {
      if (event.type === "level") {
        windows++;
        assert.equal(event.rms, 0);
        assert.equal(event.signal, "silent");
        assert.equal(event.invalidSamples, 0);
      }
    });
    const ended = await session.done;
    assert.equal(ended.reason, "duration");
    assert.ok(windows >= 20);
    assert.equal(ended.discontinuities, 0);
  },
);
test(
  "changed process identity fails instead of selecting an output fallback",
  { skip: !enabled },
  async () => {
    const own = await identify(process.pid);
    const parts = own.id.split(":");
    parts[2] = String(BigInt(parts[2]) + 1n);
    const session = capture(parts.join(":"), { seconds: 1 });
    await assert.rejects(session.done, /source_identity_changed/);
  },
);
test(
  "native helper exits promptly when its owning process disappears",
  { skip: !enabled },
  async () => {
    const owner = fork(path.join(__dirname, "support/probe-owner.cjs"), [], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const helperPid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("owner did not become ready")), 7000);
      owner.once("message", (message) => {
        clearTimeout(timer);
        resolve(message.helperPid);
      });
      owner.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      owner.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error("owner exited before ready: " + code));
      });
    }).catch((error) => {
      owner.kill();
      throw error;
    });
    assert.ok(Number.isInteger(helperPid) && helperPid > 0);
    owner.kill();
    const deadline = Date.now() + 1200;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(helperPid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      alive,
      false,
      "helper outlived its source/owner; finite native duration remains a final backstop",
    );
  },
);
