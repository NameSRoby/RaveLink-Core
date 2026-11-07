/** Serialized native requests have one deadline, including time spent queued. */
const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");
const fault = (code) => Object.assign(Error(code), { code });
module.exports = function createWindowsBridge({
  rootDir = path.resolve(__dirname, "../../.."),
  spawnImpl = spawn,
  timeoutMs = 4000,
  maxPending = 16,
  scriptName = "windows-control-deck.ps1",
  maxLineBytes = 16384,
} = {}) {
  let current,
    waiting,
    sequence = 0,
    queue = Promise.resolve(),
    idle,
    closed = false;
  const jobs = new Set();
  function terminate(state, error = fault("desktop_helper_closed")) {
    if (!state || state.dead) return;
    state.dead = true;
    clearTimeout(idle);
    state.lines.close();
    if (current === state) current = null;
    state.rejectReady(error);
    if (waiting?.state === state) {
      const pending = waiting;
      waiting = null;
      pending.reject(error);
    }
    state.process.stdin.destroy();
    state.process.kill();
  }
  function start() {
    if (closed) throw fault("desktop_helper_closed");
    if (current) return current.ready;
    const child = spawnImpl(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(rootDir, "scripts", scriptName),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const state = {
      process: child,
      lines: readline.createInterface({ input: child.stdout }),
      dead: false,
    };
    state.ready = new Promise((resolve, reject) => {
      state.resolveReady = resolve;
      state.rejectReady = reject;
    });
    current = state;
    const fail = () => terminate(state, fault("desktop_helper_unavailable"));
    child.once("error", fail);
    child.once("exit", fail);
    child.stdin.on("error", fail);
    child.stderr.on("data", () => {}); // Do not expose local paths or provider details.
    state.lines.on("line", (line) => {
      if (line.length > maxLineBytes) return fail();
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return fail();
      }
      if (!message || typeof message !== "object") return fail();
      if (message.ready === true) {
        state.resolveReady();
        return;
      }
      if (waiting?.state === state && waiting.id === message.id) {
        const pending = waiting;
        waiting = null;
        message.ok
          ? pending.resolve(message.value)
          : pending.reject(
              fault(
                /^[a-z][a-z0-9_]{1,79}$/.test(message.code)
                  ? message.code
                  : "desktop_action_failed",
              ),
            );
      }
    });
    return state.ready;
  }
  function request(operation, payload, signal) {
    if (closed) return Promise.reject(fault("desktop_helper_closed"));
    if (signal?.aborted) return Promise.reject(fault("control_deck_cancelled"));
    if (jobs.size >= maxPending) return Promise.reject(fault("desktop_helper_busy"));
    let complete, timer;
    const job = { started: false, done: false };
    const result = new Promise((resolve, reject) => {
      complete = (error, value) => {
        if (job.done) return;
        job.done = true;
        jobs.delete(job);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error && job.started) terminate(current, error);
        error ? reject(error) : resolve(value);
      };
    });
    function abort() {
      complete(fault("control_deck_cancelled"));
    }
    job.cancel = abort;
    jobs.add(job);
    timer = setTimeout(() => complete(fault("desktop_action_timeout")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    queue = queue
      .catch(() => {})
      .then(async () => {
        if (job.done) return;
        job.started = true;
        clearTimeout(idle);
        try {
          await start();
          if (job.done) return;
          const state = current,
            id = String(++sequence);
          const value = await new Promise((resolve, reject) => {
            waiting = { id, state, resolve, reject };
            state.process.stdin.write(JSON.stringify({ id, operation, payload }) + "\n");
          });
          complete(null, value);
        } catch (error) {
          complete(error);
        } finally {
          if (current) {
            idle = setTimeout(() => terminate(current), 60000);
            idle.unref?.();
          }
        }
      });
    return result;
  }
  return {
    request,
    shutdown() {
      closed = true;
      for (const job of jobs) job.cancel();
      terminate(current);
    },
  };
};
