// [TITLE] Module: capabilities/supervised-runtime/host/process-supervisor.js
// [TITLE] Purpose: supervise one optional workload process without owning its policy
// [TITLE] Functionality Index:
// [TITLE] - validate manifest, isolation support, entry path, and startup handshake
// [TITLE] - enforce bounded request concurrency, queue depth, deadlines, and IPC frames
// [TITLE] - drain shutdown and quarantine repeated crashes or protocol violations
// [DEV] Adapters provide manifest validation, permissions, identity, and bootstrap policy.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");
const { parseBrokerFrameV1 } = require("../contracts/broker-envelope-v1");
const { buildProcessPermissions } = require("./process-permissions");

const DEFAULT_STARTUP_TIMEOUT_MS = 3000;
const DEFAULT_CRASH_WINDOW_MS = 60000;
const DEFAULT_CRASH_LIMIT = 3;
const DEFAULT_PROTOCOL_LIMIT = 3;

function boundedInt(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function safeError(error, fallback = "mod_process_error") {
  return String(error?.message || error || fallback).replace(/[\r\n]+/g, " ").slice(0, 300);
}

function sanitizedChildEnvironment(source = process.env) {
  const allowed = ["SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec", "PATHEXT", "LANG", "LC_ALL"];
  const out = {};
  for (const key of allowed) if (typeof source[key] === "string" && source[key]) out[key] = source[key];
  return out;
}

function resolveContainedEntry(modRoot, entry) {
  const root = fs.realpathSync(path.resolve(modRoot));
  const candidate = path.resolve(root, entry);
  const resolved = fs.realpathSync(candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("mod_entry_escaped_root");
  if (!fs.statSync(resolved).isFile()) throw new Error("mod_entry_not_file");
  if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error("mod_entry_symlink_not_allowed");
  return { root, entry: resolved };
}

module.exports = function createProcessSupervisor(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const forkFn = typeof options.forkFn === "function" ? options.forkFn : fork;
  const validateManifest = options.validateManifest;
  if (typeof validateManifest !== "function") throw new TypeError("validateManifest is required");
  const manifestResult = validateManifest(options.manifest);
  const manifest = manifestResult.value;
  const workloadKind = String(options.workloadKind || "workload");
  const displayName = String(options.displayName || "Workload");
  const identityField = String(options.identityField || "workloadId");
  const statusIdentityField = String(options.statusIdentityField || identityField);
  const configArgument = String(options.configArgument || "--ravelink-workload-config=");
  const apiMajor = boundedInt(options.apiMajor, 1, 99, 1);
  const modRoot = path.resolve(String(options.modRoot || ""));
  const storageRoot = path.resolve(String(options.storageRoot || path.join(modRoot, ".data")));
  const platformRoot = path.resolve(String(options.platformRoot || path.join(__dirname, "..")));
  const bootstrapPath = path.resolve(String(options.bootstrapPath || path.join(__dirname, "..", "runtime", "worker-bootstrap.js")));
  const startupTimeoutMs = boundedInt(options.startupTimeoutMs, 100, 30000, DEFAULT_STARTUP_TIMEOUT_MS);
  const crashWindowMs = boundedInt(options.crashWindowMs, 1000, 300000, DEFAULT_CRASH_WINDOW_MS);
  const crashLimit = boundedInt(options.crashLimit, 1, 10, DEFAULT_CRASH_LIMIT);
  const protocolLimit = boundedInt(options.protocolViolationLimit, 1, 10, DEFAULT_PROTOCOL_LIMIT);
  const onBrokerRequest = typeof options.onBrokerRequest === "function" ? options.onBrokerRequest : null;
  const onBrokerEvent = typeof options.onBrokerEvent === "function" ? options.onBrokerEvent : null;
  const onExit = typeof options.onExit === "function" ? options.onExit : null;
  const permissionBuilder = typeof options.buildPermissions === "function" ? options.buildPermissions : buildProcessPermissions;
  const permissionOptions = {
    allowUnsafeRuntime: options.allowUnsafeRuntime === true,
    support: options.permissionSupport
  };

  let child = null;
  let startupTimer = null;
  let startupResolve = null;
  let expectedStop = false;
  let stopPromise = null;
  let stopResolve = null;
  let stopTimer = null;
  let requestSequence = 0;
  let handshakeAuthorized = false;
  const pending = new Map();
  const queue = [];
  const inbound = new Map();
  const crashTimes = [];
  const state = {
    lifecycle: manifestResult.ok ? "installed-disabled" : "incompatible",
    pid: 0,
    starts: 0,
    stops: 0,
    crashes: 0,
    forcedStops: 0,
    providerTimeouts: 0,
    protocolViolations: 0,
    unsafeRuntime: false,
    isolationCode: "",
    lastError: manifestResult.ok ? "" : "manifest_invalid",
    lastStartedAt: 0,
    lastStoppedAt: 0
  };
  const inboundRate = { windowAt: Number(now()), messages: 0, bytes: 0 };

  function getStatus() {
    return {
      ok: state.lifecycle !== "incompatible" && state.lifecycle !== "quarantined",
      [statusIdentityField]: manifest?.id || String(options.manifest?.id || ""),
      lifecycle: state.lifecycle,
      pid: state.pid,
      starts: state.starts,
      stops: state.stops,
      crashes: state.crashes,
      forcedStops: state.forcedStops,
      providerTimeouts: state.providerTimeouts,
      protocolViolations: state.protocolViolations,
      pendingCount: pending.size,
      queuedCount: queue.length,
      inboundCount: inbound.size,
      unsafeRuntime: state.unsafeRuntime,
      isolationCode: state.isolationCode,
      lastError: state.lastError,
      lastStartedAt: state.lastStartedAt,
      lastStoppedAt: state.lastStoppedAt,
      manifestErrors: manifestResult.ok ? [] : manifestResult.errors.map(error => ({ ...error }))
    };
  }

  function settleStartup() {
    if (!startupResolve) return;
    const resolve = startupResolve;
    startupResolve = null;
    clearTimeout(startupTimer);
    startupTimer = null;
    resolve(getStatus());
  }

  function settleAllRequests(code, message) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: { code, message, retryable: true } });
    }
    pending.clear();
    while (queue.length) queue.shift().resolve({ ok: false, error: { code, message, retryable: true } });
  }

  function cancelInbound(code, message) {
    for (const entry of inbound.values()) {
      clearTimeout(entry.timer);
      entry.controller.abort(Object.assign(new Error(message), { code }));
    }
    inbound.clear();
  }

  function sendEnvelope(envelope) {
    if (!child || typeof child.send !== "function" || child.connected === false) return false;
    const frame = JSON.stringify(envelope);
    const validation = parseBrokerFrameV1(frame, {
      now: Number(now()),
      maxFrameBytes: manifest.resources.ipcFrameBytes,
      maxDeadlineMs: 60000
    });
    if (!validation.ok) return false;
    try {
      child.send(envelope);
      return true;
    } catch {
      return false;
    }
  }

  function quarantine(code, message) {
    state.lifecycle = "quarantined";
    state.lastError = code;
    settleAllRequests(code, message);
    cancelInbound(code, message);
    settleStartup();
    try { child?.kill?.("SIGTERM"); } catch {}
  }

  function recordProtocolViolation(detail) {
    state.protocolViolations += 1;
    state.lastError = `protocol_violation:${detail}`;
    if (state.protocolViolations >= protocolLimit) quarantine("protocol_quarantined", `${displayName} exceeded the protocol violation limit`);
  }

  function pumpQueue() {
    if (state.lifecycle !== "active" || !child) return;
    while (queue.length && pending.size < manifest.resources.inFlightCalls) {
      const task = queue.shift();
      const deadlineAt = Number(now()) + task.timeoutMs;
      const envelope = {
        protocolVersion: 1,
        type: "request",
        sentAt: Number(now()),
        id: task.id,
        capability: task.capability,
        method: task.method,
        deadlineAt,
        payload: task.payload
      };
      const timer = setTimeout(() => {
        if (!pending.has(task.id)) return;
        pending.delete(task.id);
        sendEnvelope({ protocolVersion: 1, type: "cancel", sentAt: Number(now()), replyTo: task.id });
        task.resolve({ ok: false, error: { code: "request_timeout", message: `${displayName} request exceeded its deadline`, retryable: true } });
        pumpQueue();
      }, task.timeoutMs);
      pending.set(task.id, { ...task, timer });
      if (!sendEnvelope(envelope)) {
        clearTimeout(timer);
        pending.delete(task.id);
        task.resolve({ ok: false, error: { code: "ipc_send_failed", message: `Unable to send request to ${workloadKind}`, retryable: true } });
      }
    }
  }

  function handleMessage(message) {
    let frame;
    try { frame = JSON.stringify(message); } catch { recordProtocolViolation("non_json"); return; }
    const at = Number(now());
    if (at - inboundRate.windowAt >= 1000) {
      inboundRate.windowAt = at;
      inboundRate.messages = 0;
      inboundRate.bytes = 0;
    }
    inboundRate.messages += 1;
    inboundRate.bytes += Buffer.byteLength(frame, "utf8");
    if (inboundRate.messages > 120 || inboundRate.bytes > manifest.resources.ipcFrameBytes * 32) {
      recordProtocolViolation("ipc_rate_limit");
      return;
    }
    const validation = parseBrokerFrameV1(frame, {
      now: Number(now()),
      maxFrameBytes: manifest.resources.ipcFrameBytes,
      maxDeadlineMs: 60000
    });
    if (!validation.ok) {
      recordProtocolViolation(validation.errors[0]?.code || "invalid_envelope");
      return;
    }
    const envelope = validation.value;
    if (envelope.type === "hello" && state.lifecycle === "enabling") {
      if (envelope.payload?.[identityField] !== manifest.id || Number(envelope.payload?.apiMajor) !== apiMajor) {
        quarantine("handshake_mismatch", `${displayName} handshake identity or API did not match its manifest`);
        return;
      }
      if (!sendEnvelope({
        protocolVersion: 1,
        type: "ready",
        sentAt: Number(now()),
        payload: { phase: "authorize", [identityField]: manifest.id }
      })) quarantine("handshake_send_failed", `Unable to authorize ${workloadKind} activation`);
      else handshakeAuthorized = true;
      return;
    }
    if (envelope.type === "ready" && state.lifecycle === "enabling" && envelope.payload?.phase === "active") {
      if (envelope.payload?.ok === true && envelope.payload?.[identityField] === manifest.id) {
        state.lifecycle = "active";
        state.lastError = "";
        settleStartup();
        pumpQueue();
      } else {
        state.lifecycle = "crashed";
        state.lastError = `activation_failed:${safeError(envelope.payload?.error, "unknown")}`;
        settleStartup();
        try { child?.kill?.("SIGTERM"); } catch {}
      }
      return;
    }
    if (envelope.type === "response") {
      const task = pending.get(envelope.replyTo);
      if (!task) return;
      pending.delete(envelope.replyTo);
      clearTimeout(task.timer);
      task.resolve(envelope.ok
        ? { ok: true, value: envelope.payload }
        : { ok: false, error: { ...envelope.error } });
      pumpQueue();
      return;
    }
    if (envelope.type === "request" && (["active", "draining"].includes(state.lifecycle) || (state.lifecycle === "enabling" && handshakeAuthorized)) && onBrokerRequest) {
      if (inbound.has(envelope.id) || inbound.size >= manifest.resources.inFlightCalls) {
        sendEnvelope({
          protocolVersion: 1, type: "response", sentAt: Number(now()), replyTo: envelope.id, ok: false,
          error: { code: "broker_busy", message: `${displayName} capability request limit reached`, retryable: true }
        });
        return;
      }
      const controller = new AbortController();
      const timeoutMs = Math.max(1, envelope.deadlineAt - Number(now()));
      const timer = setTimeout(() => {
        if (!inbound.has(envelope.id)) return;
        state.providerTimeouts += 1;
        controller.abort(Object.assign(new Error(`${displayName} provider request exceeded its deadline`), { code: "broker_timeout" }));
      }, timeoutMs);
      inbound.set(envelope.id, { controller, timer });
      Promise.race([Promise.resolve(onBrokerRequest(envelope.capability, envelope.method, envelope.payload, {
        providerId: envelope.providerId,
        timeoutMs,
        deadlineAt: envelope.deadlineAt,
        signal: controller.signal
      })), new Promise((resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      })]).then(result => {
        if (result?.ok) {
          sendEnvelope({ protocolVersion: 1, type: "response", sentAt: Number(now()), replyTo: envelope.id, ok: true, payload: result.value });
        } else {
          sendEnvelope({
            protocolVersion: 1, type: "response", sentAt: Number(now()), replyTo: envelope.id, ok: false,
            error: result?.error || { code: "broker_failed", message: "Capability broker rejected the request", retryable: false }
          });
        }
      }).catch(error => {
        const timedOut = error?.code === "broker_timeout";
        sendEnvelope({
          protocolVersion: 1, type: "response", sentAt: Number(now()), replyTo: envelope.id, ok: false,
          error: timedOut
            ? { code: "broker_timeout", message: `${displayName} provider request exceeded its deadline`, retryable: true }
            : { code: "broker_failed", message: "Capability broker failed", retryable: true }
        });
      }).finally(() => {
        const entry = inbound.get(envelope.id);
        if (entry) clearTimeout(entry.timer);
        inbound.delete(envelope.id);
      });
      return;
    }
    if (envelope.type === "event" && state.lifecycle === "active" && onBrokerEvent) {
      Promise.resolve(onBrokerEvent(envelope.capability, envelope.method, envelope.payload)).catch(() => {});
      return;
    }
    recordProtocolViolation(`unexpected_${envelope.type}`);
  }

  function handleExit(code, signal) {
    if (!child && state.pid === 0) return;
    clearTimeout(stopTimer);
    stopTimer = null;
    child = null;
    state.pid = 0;
    clearTimeout(startupTimer);
    startupTimer = null;
    settleAllRequests(`${workloadKind}_process_exited`, `${displayName} process exited`);
    cancelInbound(`${workloadKind}_process_exited`, `${displayName} process exited`);
    if (expectedStop) {
      state.lifecycle = "installed-disabled";
      state.lastStoppedAt = Number(now());
      state.lastError = signal === "forced" ? "shutdown_timeout" : "";
    } else if (state.lifecycle !== "quarantined") {
      state.crashes += 1;
      const at = Number(now());
      crashTimes.push(at);
      while (crashTimes.length && crashTimes[0] < at - crashWindowMs) crashTimes.shift();
      state.lastError = `${workloadKind}_exit_${String(code ?? "null")}_${String(signal || "none")}`;
      state.lifecycle = crashTimes.length >= crashLimit ? "quarantined" : "crashed";
    }
    settleStartup();
    if (stopResolve) {
      const resolve = stopResolve;
      stopResolve = null;
      resolve(getStatus());
    }
    try { onExit?.(getStatus()); } catch {}
  }

  async function start() {
    if (!manifestResult.ok || ["active", "enabling", "quarantined"].includes(state.lifecycle)) return getStatus();
    let paths;
    try {
      paths = resolveContainedEntry(modRoot, manifest.entry);
      if (!fs.statSync(bootstrapPath).isFile()) throw new Error("mod_bootstrap_missing");
    } catch (error) {
      state.lifecycle = "incompatible";
      state.lastError = safeError(error);
      return getStatus();
    }
    const isolation = permissionBuilder({
      manifest,
      modRoot: paths.root,
      storageRoot,
      platformRoot,
      allowUnsafeRuntime: permissionOptions.allowUnsafeRuntime,
      support: permissionOptions.support
    });
    state.unsafeRuntime = isolation.unsafe === true;
    state.isolationCode = isolation.code;
    if (!isolation.ok) {
      state.lifecycle = "permission-required";
      state.lastError = isolation.code;
      return getStatus();
    }
    const bootConfig = Buffer.from(JSON.stringify({
      [identityField]: manifest.id,
      identityField,
      entryPath: paths.entry,
      provides: manifest.provides,
      consumes: manifest.consumes,
      maxFrameBytes: manifest.resources.ipcFrameBytes
    }), "utf8").toString("base64url");
    expectedStop = false;
    handshakeAuthorized = false;
    state.lifecycle = "enabling";
    state.starts += 1;
    state.lastStartedAt = Number(now());
    state.lastError = "";
    try {
      child = forkFn(bootstrapPath, [`${configArgument}${bootConfig}`], {
        cwd: paths.root,
        env: sanitizedChildEnvironment(options.environment),
        execArgv: isolation.execArgv,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"]
      });
      state.pid = Number(child.pid || 0);
      const worker = child;
      child.on("message", message => { if (child === worker) handleMessage(message); });
      child.once("exit", (code, signal) => { if (child === worker) handleExit(code, signal); });
      child.once("error", error => {
        if (child !== worker) return;
        state.lastError = safeError(error, "mod_spawn_error");
      });
    } catch (error) {
      child = null;
      state.pid = 0;
      state.lifecycle = "crashed";
      state.lastError = safeError(error, "mod_spawn_failed");
      return getStatus();
    }
    return await new Promise(resolve => {
      startupResolve = resolve;
      startupTimer = setTimeout(() => {
        state.lifecycle = "crashed";
        state.lastError = "activation_timeout";
        settleStartup();
        try { child?.kill?.("SIGTERM"); } catch {}
      }, startupTimeoutMs);
    });
  }

  function request(capability, method, payload = null, requestOptions = {}) {
    if (state.lifecycle !== "active") return Promise.resolve({ ok: false, error: { code: `${workloadKind}_unavailable`, message: `${displayName} is not active`, retryable: true } });
    if (!manifest.provides.includes(capability)) return Promise.resolve({ ok: false, error: { code: "capability_not_provided", message: `Capability is not declared by this ${workloadKind}`, retryable: false } });
    if (pending.size + queue.length >= manifest.resources.inFlightCalls + manifest.resources.queuedCalls) {
      return Promise.resolve({ ok: false, error: { code: "queue_full", message: `${displayName} request queue is full`, retryable: true } });
    }
    const timeoutMs = boundedInt(requestOptions.timeoutMs, 10, 60000, 5000);
    requestSequence += 1;
    const id = `m_${requestSequence}_${crypto.randomBytes(4).toString("hex")}`;
    let requestFrame;
    try {
      requestFrame = JSON.stringify({
        protocolVersion: 1,
        type: "request",
        sentAt: Number(now()),
        id,
        capability,
        method,
        deadlineAt: Number(now()) + timeoutMs,
        payload
      });
    } catch {
      return Promise.resolve({ ok: false, error: { code: "invalid_request", message: "Request payload must be JSON", retryable: false } });
    }
    const requestValidation = parseBrokerFrameV1(requestFrame, {
      now: Number(now()),
      maxFrameBytes: manifest.resources.ipcFrameBytes,
      maxDeadlineMs: 60000
    });
    if (!requestValidation.ok) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "invalid_request",
          message: `Request failed broker validation: ${requestValidation.errors[0]?.code || "unknown"}`,
          retryable: false
        }
      });
    }
    return new Promise(resolve => {
      queue.push({ id, capability, method, payload, timeoutMs, resolve });
      pumpQueue();
    });
  }

  function sendEvent(capability, method, payload = null) {
    if (state.lifecycle !== "active") return false;
    return sendEnvelope({ protocolVersion: 1, type: "event", sentAt: Number(now()), capability, method, payload });
  }

  async function stop() {
    if (!child) {
      if (state.lifecycle !== "quarantined" && state.lifecycle !== "incompatible") state.lifecycle = "installed-disabled";
      return getStatus();
    }
    if (stopPromise) return stopPromise;
    expectedStop = true;
    state.lifecycle = "draining";
    state.stops += 1;
    settleAllRequests(`${workloadKind}_stopping`, `${displayName} is stopping`);
    const graceMs = manifest.resources.shutdownGraceMs;
    const worker = child;
    stopPromise = new Promise(resolve => {
      stopResolve = resolve;
      stopTimer = setTimeout(() => {
        if (child !== worker) return;
        state.lastError = "shutdown_timeout";
        state.forcedStops += 1;
        try { worker.kill?.("SIGKILL"); } catch {}
        if (child === worker) handleExit(null, "forced");
      }, graceMs);
      sendEnvelope({ protocolVersion: 1, type: "shutdown", sentAt: Number(now()), deadlineAt: Number(now()) + graceMs });
    }).finally(() => { stopPromise = null; });
    return stopPromise;
  }

  function resetQuarantine() {
    if (state.lifecycle !== "quarantined") return getStatus();
    crashTimes.length = 0;
    state.protocolViolations = 0;
    state.lifecycle = "installed-disabled";
    state.lastError = "";
    return getStatus();
  }

  return Object.freeze({ getStatus, request, resetQuarantine, sendEvent, start, stop });
};

module.exports.resolveContainedEntry = resolveContainedEntry;
module.exports.sanitizedChildEnvironment = sanitizedChildEnvironment;
