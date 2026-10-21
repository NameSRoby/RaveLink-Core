/** Explicit standalone probe supervisor. Importing creates no processes/timers.
 * A fixed first-party executable is used; no PATH/sibling helper discovery.
 * Stop closes its stdin pipe, then kills only that owned child if it fails to exit.
 */
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createClock } = require("./sample-clock.cjs");
const {
  createLines,
  createProtocol,
  source: validateSelection,
  validateSource,
} = require("./protocol.cjs");
const HELPER = path.resolve(
  __dirname,
  "../../runtime/music-to-light/cargo/release/ravelink-audio-probe.exe",
);
const fault = (code) => Object.assign(new Error(code), { code });
let captureActive = false;

function launch(args, options = {}) {
  if (!options.spawn && !fs.existsSync(HELPER)) throw fault("audio_probe_not_built");
  return (options.spawn || spawn)(HELPER, args, {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function query(args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(fault("source_query_cancelled"));
      return;
    }
    if (options.signal && typeof options.signal.addEventListener !== "function") {
      reject(fault("invalid_source_query_signal"));
      return;
    }
    let child;
    try {
      child = launch(args, options);
    } catch (error) {
      reject(error);
      return;
    }
    let result, failure;
    const abort = () => {
      failure ||= fault("source_query_cancelled");
      child.kill();
    };
    const timer = setTimeout(() => {
      failure ||= fault("source_query_timeout");
      child.kill();
    }, 6000);
    const lines = createLines(
      (event) => {
        if (args[0] === "apps") {
          if (
            result ||
            event?.v !== 2 ||
            event.type !== "app_catalog" ||
            !Array.isArray(event.sources) ||
            event.sources.length > 257 ||
            !Array.isArray(event.processes) ||
            event.processes.length > 1024
          )
            throw fault("native_invalid_app_catalog");
          result = { sources: event.sources, processes: event.processes };
          return;
        }
        if (result || event?.v !== 2 || !["sources", "source"].includes(event.type))
          throw fault("native_invalid_catalog");
        const entries = event.type === "source" ? [event.source] : event.sources;
        if (!Array.isArray(entries) || entries.length > 257) throw fault("native_invalid_catalog");
        result = entries.map(validateSource);
      },
      args[0] === "apps" ? 2 * 1024 * 1024 : 512 * 1024,
    );
    child.stdout.on("data", (chunk) => {
      try {
        lines.push(chunk);
      } catch (error) {
        failure = error;
        child.kill();
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => {
      failure = fault("audio_probe_launch_failed");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      try {
        lines.finish();
      } catch (error) {
        failure ||= error;
      }
      if (failure || code !== 0 || !result) reject(failure || fault("source_query_failed"));
      else resolve(result);
    });
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end();
  });
}

function capture(
  source,
  { seconds = 15, spawn: spawnOverride, now = () => performance.now() } = {},
) {
  const scope = validateSelection(source);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) throw fault("invalid_duration");
  if (captureActive) throw fault("audio_probe_already_running");
  const generation = crypto.randomBytes(16).toString("hex");
  const child = launch(
    ["capture", "--source", source, "--seconds", String(seconds), "--generation", generation],
    { spawn: spawnOverride },
  );
  captureActive = true;
  const events = new EventEmitter();
  const validate = createProtocol({ generation, scope, seconds });
  const clock = createClock({ generation, now });
  let failure,
    ended,
    stopTimer,
    readyTimer,
    clockTimer,
    latest = { state: "starting", generation, scope, signal: "waiting", lastLevel: null },
    sampleReceivedAt = null,
    closed = false;
  const kill = () => {
    if (!closed) child.kill();
  };
  const timeout =
    seconds === 0
      ? null
      : setTimeout(
          () => {
            failure ||= fault("audio_probe_deadline");
            kill();
          },
          (seconds + 8) * 1000,
        );
  readyTimer = setTimeout(() => {
    failure ||= fault("audio_probe_not_ready");
    kill();
  }, 6500);
  const stop = () => {
    if (closed || stopTimer) return;
    latest.state = "stopping";
    child.stdin.end();
    stopTimer = setTimeout(kill, 1500);
  };
  const lines = createLines((value) => {
    const event = validate(value);
    if (event.type === "ready") clearTimeout(readyTimer);
    if (event.type === "ended") ended = event;
    if (event.type === "hello") latest.state = "activating";
    if (event.type === "ready") {
      latest.state = "ready";
      latest.format = event.format;
      clockTimer = setTimeout(() => {
        failure ||= fault("audio_clock_timeout");
        kill();
      }, 500);
      child.stdin.write(clock.request());
    }
    if (event.type === "clock") {
      clock.accept(event);
      clearTimeout(clockTimer);
    }
    if (event.type === "level") {
      latest.lastLevel = event;
      event.freshness = clock.age(event.qpcEnd100ns);
      latest.signal = event.signal;
      sampleReceivedAt = now();
    }
    if (event.type === "status" && event.signal !== "receiving") latest.signal = event.signal;
    if (event.type === "ended") latest.state = "stopped";
    latest.lastEvent = event;
    events.emit("update", structuredClone(event));
  });
  // Drain stderr without logging private native diagnostics. Native errors must
  // arrive as bounded code-only protocol events, never arbitrary exception text.
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    try {
      lines.push(chunk);
    } catch (error) {
      failure ||= error;
      kill();
    }
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", () => {
      failure ||= fault("audio_probe_launch_failed");
    });
    child.on("close", (code) => {
      if (closed) return;
      closed = true;
      captureActive = false;
      [timeout, readyTimer, clockTimer, stopTimer].forEach(clearTimeout);
      try {
        lines.finish();
      } catch (error) {
        failure ||= error;
      }
      if (failure || code !== 0 || !ended) {
        failure ||= fault("audio_probe_unconfirmed_exit");
        latest = { state: "failed", generation, scope, code: failure.code };
        reject(failure);
      } else resolve(ended);
      events.removeAllListeners();
    });
  });
  return {
    events,
    done,
    stop,
    snapshot: () => {
      const value = structuredClone(latest);
      value.lastLevelAgeMs =
        sampleReceivedAt === null ? null : Math.max(0, now() - sampleReceivedAt);
      value.freshness = clock.age(value.lastLevel?.qpcEnd100ns ?? null);
      if (value.state === "ready" && value.lastLevelAgeMs > 750) value.signal = "stale";
      return value;
    },
  };
}

module.exports = {
  supportsFullscreen: true,
  available: () => fs.existsSync(HELPER),
  capture,
  listSources: (options) => query(["sources"], options),
  fullscreenSource: (options) =>
    query(["fullscreen"], options).then((entries) => entries[0] || null),
  applicationCatalog: (options) => query(["apps"], options),
  identify: (pid, options) => {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) throw fault("invalid_pid");
    return query(["identify", String(pid)], options).then((entries) => entries[0]);
  },
};
