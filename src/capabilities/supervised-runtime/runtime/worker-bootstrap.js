#!/usr/bin/env node
// [TITLE] Module: capabilities/supervised-runtime/runtime/worker-bootstrap.js
// [TITLE] Purpose: execute one validated workload behind the broker v1 IPC contract
// [TITLE] Functionality Index:
// [TITLE] - perform host/workload handshake before loading workload code
// [TITLE] - dispatch bounded capability requests with cancellation and deadlines
// [TITLE] - deactivate and exit within a bounded shutdown window

const path = require("node:path");
const {
  parseBrokerFrameV1
} = require("../contracts/broker-envelope-v1");

function readBootConfig() {
  const prefix = "--ravelink-workload-config=";
  const argument = process.argv.slice(2).find(value => value.startsWith(prefix));
  if (!argument) throw new Error("workload_boot_config_missing");
  const parsed = JSON.parse(Buffer.from(argument.slice(prefix.length), "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("workload_boot_config_invalid");
  return parsed;
}

const config = readBootConfig();
const identityField = typeof config.identityField === "string" && /^[a-z][A-Za-z0-9]{1,30}$/.test(config.identityField)
  ? config.identityField
  : "workloadId";
const workloadId = String(config[identityField] || "");
const entryPath = path.resolve(String(config.entryPath || ""));
const providedCapabilities = new Set(Array.isArray(config.provides) ? config.provides : []);
const consumedCapabilities = new Set((Array.isArray(config.consumes) ? config.consumes : []).map(value => String(value).replace(/\?$/, "")));
const maxFrameBytes = Number(config.maxFrameBytes || 65536);
let workload = null;
let active = false;
let shuttingDown = false;
const pending = new Map();
const outbound = new Map();
let outboundSequence = 0;

function send(envelope) {
  const validation = parseBrokerFrameV1(JSON.stringify(envelope), { maxFrameBytes });
  if (!validation.ok) throw new Error(`worker_invalid_outbound_envelope:${validation.errors[0]?.code || "unknown"}`);
  process.send?.(envelope);
}

function response(replyTo, ok, payload, error) {
  const envelope = {
    protocolVersion: 1,
    type: "response",
    sentAt: Date.now(),
    replyTo,
    ok
  };
  if (ok) envelope.payload = payload === undefined ? null : payload;
  else envelope.error = error;
  send(envelope);
}

function callCapability(capability, method, payload = null, options = {}) {
  if (!workload) return Promise.reject(new Error("workload_unavailable"));
  if (!consumedCapabilities.has(capability)) return Promise.reject(new Error("capability_not_declared"));
  const timeoutMs = Math.min(60000, Math.max(10, Number(options.timeoutMs) || 5000));
  outboundSequence += 1;
  const id = `w_${outboundSequence}_${Date.now().toString(36)}`;
  const envelope = {
    protocolVersion: 1,
    type: "request",
    sentAt: Date.now(),
    id,
    capability,
    method,
    deadlineAt: Date.now() + timeoutMs,
    payload
  };
  if (options.providerId) envelope.providerId = String(options.providerId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      outbound.delete(id);
      reject(new Error("broker_timeout"));
    }, timeoutMs);
    outbound.set(id, { resolve, reject, timer });
    try { send(envelope); } catch (error) { clearTimeout(timer); outbound.delete(id); reject(error); }
  });
}

function publishEvent(capability, event, payload = null) {
  if (!active || shuttingDown) throw new Error("mod_unavailable");
  if (!providedCapabilities.has(capability)) throw new Error("event_publish_denied");
  send({ protocolVersion: 1, type: "event", sentAt: Date.now(), capability, method: event, payload });
}

async function activate() {
  try {
    const loaded = require(entryPath);
    if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) throw new Error("workload_entry_must_export_object");
    workload = loaded;
    if (typeof workload.activate === "function") {
      await Promise.resolve(workload.activate(Object.freeze({
        workloadId,
        [identityField]: workloadId,
        capabilities: Object.freeze([...providedCapabilities]),
        consumedCapabilities: Object.freeze([...consumedCapabilities]),
        callCapability,
        publishEvent
      })));
    }
    active = true;
    send({
      protocolVersion: 1,
      type: "ready",
      sentAt: Date.now(),
      payload: { phase: "active", ok: true, [identityField]: workloadId }
    });
  } catch (error) {
    send({
      protocolVersion: 1,
      type: "ready",
      sentAt: Date.now(),
      payload: { phase: "active", ok: false, [identityField]: workloadId, error: String(error?.message || error).slice(0, 300) }
    });
  }
}

async function handleRequest(envelope) {
  if (!active || shuttingDown) {
    response(envelope.id, false, null, { code: "workload_unavailable", message: "Workload is not active", retryable: true });
    return;
  }
  if (!providedCapabilities.has(envelope.capability)) {
    response(envelope.id, false, null, { code: "capability_not_provided", message: "Capability is not provided by this workload", retryable: false });
    return;
  }
  if (typeof workload.handleRequest !== "function") {
    response(envelope.id, false, null, { code: "method_unavailable", message: "Workload has no request handler", retryable: false });
    return;
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(1, envelope.deadlineAt - Date.now());
  const timer = setTimeout(() => controller.abort(new Error("request_deadline_exceeded")), timeoutMs);
  pending.set(envelope.id, { controller, timer });
  try {
    const result = await Promise.race([
      Promise.resolve(workload.handleRequest({
        capability: envelope.capability,
        method: envelope.method,
        payload: envelope.payload,
        signal: controller.signal,
        deadlineAt: envelope.deadlineAt
      })),
      new Promise((resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }))
    ]);
    response(envelope.id, true, result, null);
  } catch (error) {
    const timedOut = controller.signal.aborted;
    response(envelope.id, false, null, {
      code: timedOut ? "request_cancelled" : "workload_request_failed",
      message: timedOut ? "Request was cancelled or expired" : String(error?.message || error).slice(0, 300),
      retryable: timedOut
    });
  } finally {
    clearTimeout(timer);
    pending.delete(envelope.id);
  }
}

async function shutdown(deadlineAt) {
  if (shuttingDown) return;
  shuttingDown = true;
  active = false;
  for (const entry of pending.values()) entry.controller.abort(new Error("workload_shutdown"));
  for (const entry of outbound.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("workload_shutdown"));
  }
  outbound.clear();
  const remainingMs = Math.max(1, Number(deadlineAt || 0) - Date.now());
  try {
    if (typeof workload?.deactivate === "function") {
      await Promise.race([
        Promise.resolve(workload.deactivate()),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error("deactivate_timeout")), remainingMs))
      ]);
    }
  } catch {}
  process.exit(0);
}

function handleResponse(envelope) {
  const request = outbound.get(envelope.replyTo);
  if (!request) return;
  outbound.delete(envelope.replyTo);
  clearTimeout(request.timer);
  if (envelope.ok) request.resolve(envelope.payload);
  else request.reject(Object.assign(new Error(envelope.error.message), {
    code: envelope.error.code,
    retryable: envelope.error.retryable === true
  }));
}

function handleEvent(envelope) {
  if (!active || !consumedCapabilities.has(envelope.capability) || typeof workload?.handleEvent !== "function") return;
  Promise.resolve(workload.handleEvent({
    capability: envelope.capability,
    event: envelope.method,
    payload: envelope.payload
  })).catch(() => {});
}

function dispatch(envelope) {
  switch (envelope.type) {
    case "ready":
      if (envelope.payload?.phase === "authorize" && !active) void activate();
      break;
    case "request":
      void handleRequest(envelope);
      break;
    case "response":
      handleResponse(envelope);
      break;
    case "event":
      handleEvent(envelope);
      break;
    case "cancel":
      pending.get(envelope.replyTo)?.controller.abort(new Error("host_cancelled"));
      break;
    case "shutdown":
      void shutdown(envelope.deadlineAt);
      break;
    default:
      break;
  }
}

process.on("message", message => {
  let serialized;
  try { serialized = JSON.stringify(message); } catch { process.exitCode = 3; process.disconnect?.(); return; }
  const validation = parseBrokerFrameV1(serialized, { maxFrameBytes });
  if (!validation.ok) {
    process.exitCode = 3;
    process.disconnect?.();
    return;
  }
  dispatch(validation.value);
});

process.on("disconnect", () => void shutdown(Date.now() + 250));

send({
  protocolVersion: 1,
  type: "hello",
  sentAt: Date.now(),
  payload: { [identityField]: workloadId, pid: process.pid, apiMajor: 1 }
});
