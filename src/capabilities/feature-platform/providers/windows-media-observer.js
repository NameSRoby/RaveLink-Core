// [TITLE] Module: feature-platform/providers/windows-media-observer.js
// [TITLE] Purpose: supervise the optional Windows media-session observer

const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_LINE_BYTES = 16 * 1024;
const PROVIDERS = Object.freeze(["tidal", "spotify", "apple-music"]);
const SOURCE_RULES = Object.freeze({
  tidal: /tidal/i,
  spotify: /spotify/i,
  "apple-music": /apple.*music|music.*apple/i
});

function boundedText(value, maximum) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function boundedInteger(value, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(0, Math.trunc(number))) : 0;
}

function normalizeMediaSnapshot(snapshot, selectedProvider) {
  const provider = PROVIDERS.includes(selectedProvider) ? selectedProvider : "";
  const sourceId = boundedText(snapshot?.source, 120);
  if (!provider || !snapshot || typeof snapshot !== "object" || ![1, 2].includes(snapshot.schemaVersion) || !SOURCE_RULES[provider].test(sourceId)) return null;
  const base = { provider, sourceId, available: snapshot.available === true };
  if (!base.available) return base;
  const title = boundedText(snapshot.title, 200);
  if (!title) return null;
  const rawStatus = boundedText(snapshot.status, 20).toLowerCase();
  return {
    ...base,
    title,
    artists: [boundedText(snapshot.artist, 100)].filter(Boolean),
    album: boundedText(snapshot.album, 200),
    status: rawStatus === "playing" ? "playing" : rawStatus === "paused" ? "paused" : "stopped",
    positionMs: boundedInteger(snapshot.positionMs, 86400000),
    durationMs: boundedInteger(snapshot.durationMs, 86400000),
    observedAt: boundedInteger(snapshot.observedAt, Number.MAX_SAFE_INTEGER) || Date.now()
  };
}

module.exports = function createWindowsMediaObserver(options = {}) {
  const spawnFn = typeof options.spawn === "function" ? options.spawn : spawn;
  const onSnapshot = typeof options.onSnapshot === "function" ? options.onSnapshot : async () => ({ ok: false });
  const observerPath = path.resolve(options.observerPath || path.join(process.cwd(), "scripts", "windows-media-observer.ps1"));
  const supported = options.supported === undefined ? process.platform === "win32" : options.supported === true;
  let child = null;
  let buffer = "";
  let pending = null;
  let forwarding = false;
  let stopping = false;
  const counters = { starts: 0, stops: 0, crashes: 0, observations: 0, forwarded: 0, rejected: 0, malformed: 0, overflow: 0 };
  let lastObservedAt = 0;
  let lastError = "";
  let selectedProvider = PROVIDERS.includes(options.provider) ? options.provider : "tidal";

  function status() {
    return {
      ok: true,
      supported,
      lifecycle: child ? (stopping ? "stopping" : "active") : "stopped",
      pid: Number(child?.pid || 0),
      lastObservedAt,
      lastError,
      forwarding,
      pending: Boolean(pending),
      selectedProvider,
      counters: { ...counters }
    };
  }

  async function flush() {
    if (forwarding || !pending) return;
    forwarding = true;
    const payload = pending;
    pending = null;
    try {
      const result = await onSnapshot(payload);
      if (result?.ok === true) counters.forwarded += 1;
      else { counters.rejected += 1; lastError = "media_observation_rejected"; }
    } catch {
      counters.rejected += 1;
      lastError = "media_observation_unavailable";
    } finally {
      forwarding = false;
      if (pending) void flush();
    }
  }

  function acceptChunk(chunk) {
    buffer += String(chunk || "");
    if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES * 2) {
      counters.overflow += 1;
      buffer = "";
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) { counters.malformed += 1; continue; }
      try {
        const normalized = normalizeMediaSnapshot(JSON.parse(line), selectedProvider);
        if (!normalized) { counters.malformed += 1; continue; }
        counters.observations += 1;
        lastObservedAt = Number(normalized.observedAt || Date.now());
        lastError = "";
        pending = normalized;
        void flush();
      } catch { counters.malformed += 1; }
    }
  }

  function start() {
    if (!supported) return { ...status(), ok: false, error: "windows_media_observer_unsupported" };
    if (child) return status();
    stopping = false;
    buffer = "";
    lastError = "";
    try {
      const worker = spawnFn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", observerPath, "-Provider", selectedProvider], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child = worker;
      counters.starts += 1;
      worker.stdout?.setEncoding?.("utf8");
      worker.stdout?.on?.("data", acceptChunk);
      worker.stderr?.resume?.();
      worker.once?.("error", () => { lastError = "media_observer_spawn_failed"; });
      worker.once?.("exit", code => {
        if (child !== worker) return;
        child = null;
        if (stopping) { counters.stops += 1; stopping = false; }
        else if (Number(code || 0) !== 0) { counters.crashes += 1; lastError = "media_observer_exited"; }
      });
      return status();
    } catch {
      child = null;
      lastError = "media_observer_spawn_failed";
      return { ...status(), ok: false, error: lastError };
    }
  }

  async function stop() {
    const worker = child;
    if (!worker) return status();
    stopping = true;
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, 1500);
      worker.once?.("exit", finish);
      try { worker.kill?.(); } catch { finish(); }
    });
    if (child === worker) {
      try { worker.kill?.("SIGKILL"); } catch {}
      child = null;
      counters.stops += 1;
      stopping = false;
    }
    pending = null;
    buffer = "";
    return status();
  }

  async function control(payload = {}) {
    const action = String(payload.action || "status");
    if (action === "start") return start();
    if (action === "stop") return stop();
    if (action === "status") return status();
    if (action === "select") {
      const provider = String(payload.provider || "").toLowerCase();
      if (!PROVIDERS.includes(provider)) return { ...status(), ok: false, error: "media_provider_invalid" };
      const wasActive = Boolean(child);
      if (wasActive) await stop();
      selectedProvider = provider;
      pending = null;
      return wasActive ? start() : status();
    }
    return { ...status(), ok: false, error: "media_observer_action_invalid" };
  }

  return Object.freeze({ control, start, status, stop });
};

module.exports.MAX_LINE_BYTES = MAX_LINE_BYTES;
module.exports.PROVIDERS = PROVIDERS;
module.exports.normalizeMediaSnapshot = normalizeMediaSnapshot;
