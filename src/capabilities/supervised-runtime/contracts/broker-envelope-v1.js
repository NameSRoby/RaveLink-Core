// [TITLE] Module: capabilities/supervised-runtime/contracts/broker-envelope-v1.js
// [TITLE] Purpose: parse and validate bounded supervised-workload IPC messages
// [TITLE] Functionality Index:
// [TITLE] - reject oversized, malformed, deep, or prototype-sensitive JSON
// [TITLE] - enforce closed envelope shapes for broker protocol v1
// [TITLE] - validate request deadlines and typed error dispositions

const BROKER_PROTOCOL_VERSION = 1;
const DEFAULT_MAX_FRAME_BYTES = 65536;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_NODES = 5000;
const DEFAULT_MAX_DEADLINE_MS = 60000;
const MESSAGE_TYPES = Object.freeze([
  "hello", "ready", "request", "response", "event", "cancel", "shutdown", "heartbeat"
]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\.v[1-9][0-9]*$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,31}$/;
const METHOD_RE = /^[a-z][a-zA-Z0-9.:-]{0,79}$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const BASE_KEYS = new Set([
  "protocolVersion", "type", "sentAt", "id", "replyTo", "capability",
  "method", "providerId", "deadlineAt", "payload", "ok", "error"
]);
const TYPE_KEYS = Object.freeze({
  hello: new Set(["protocolVersion", "type", "sentAt", "payload"]),
  ready: new Set(["protocolVersion", "type", "sentAt", "payload"]),
  request: new Set(["protocolVersion", "type", "sentAt", "id", "capability", "method", "providerId", "deadlineAt", "payload"]),
  response: new Set(["protocolVersion", "type", "sentAt", "replyTo", "ok", "payload", "error"]),
  event: new Set(["protocolVersion", "type", "sentAt", "capability", "method", "payload"]),
  cancel: new Set(["protocolVersion", "type", "sentAt", "replyTo"]),
  shutdown: new Set(["protocolVersion", "type", "sentAt", "deadlineAt"]),
  heartbeat: new Set(["protocolVersion", "type", "sentAt"])
});

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function addError(errors, pathName, code, message) {
  errors.push({ path: pathName, code, message });
}

function inspectJsonValue(value, errors, limits, pathName = "$.payload", depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) {
    if (!errors.some(error => error.code === "payload_too_complex")) addError(errors, pathName, "payload_too_complex", `contains more than ${limits.maxNodes} values`);
    return;
  }
  if (depth > limits.maxDepth) {
    addError(errors, pathName, "payload_too_deep", `exceeds maximum depth ${limits.maxDepth}`);
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) addError(errors, pathName, "non_json_number", "must be a finite JSON number");
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) inspectJsonValue(value[index], errors, limits, `${pathName}[${index}]`, depth + 1, state);
    return;
  }
  if (!isRecord(value)) {
    addError(errors, pathName, "non_json_value", "must contain only JSON values");
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) addError(errors, `${pathName}.${key}`, "forbidden_key", "prototype-sensitive keys are not allowed");
    inspectJsonValue(child, errors, limits, `${pathName}.${key}`, depth + 1, state);
  }
}

function validateTimestamp(value, pathName, errors) {
  if (!Number.isSafeInteger(value) || value < 0) addError(errors, pathName, "invalid_timestamp", "must be a non-negative safe integer timestamp");
}

function validateId(value, pathName, errors) {
  if (typeof value !== "string" || !ID_RE.test(value)) addError(errors, pathName, "invalid_id", "must be 1-64 URL-safe identifier characters");
}

function validateError(value, errors) {
  if (!isRecord(value)) {
    addError(errors, "$.error", "invalid_error", "must be an error object");
    return;
  }
  const allowed = new Set(["code", "message", "retryable"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) addError(errors, `$.error.${key}`, "unknown_field", "field is not supported");
  if (typeof value.code !== "string" || !ERROR_CODE_RE.test(value.code)) addError(errors, "$.error.code", "invalid_error_code", "must be a lowercase stable error code");
  if (typeof value.message !== "string" || value.message.length > 300) addError(errors, "$.error.message", "invalid_error_message", "must be a string of at most 300 characters");
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") addError(errors, "$.error.retryable", "invalid_type", "must be boolean");
}

function validateBrokerEnvelopeV1(input, options = {}) {
  const errors = [];
  const now = Number.isSafeInteger(options.now) ? options.now : Date.now();
  const maxDeadlineMs = Number.isSafeInteger(options.maxDeadlineMs) ? options.maxDeadlineMs : DEFAULT_MAX_DEADLINE_MS;
  const limits = {
    maxDepth: Number.isSafeInteger(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH,
    maxNodes: Number.isSafeInteger(options.maxNodes) ? options.maxNodes : DEFAULT_MAX_NODES
  };
  if (!isRecord(input)) return { ok: false, errors: [{ path: "$", code: "invalid_envelope", message: "must be a JSON object" }], value: null };
  for (const key of Object.keys(input)) if (!BASE_KEYS.has(key)) addError(errors, `$.${key}`, "unknown_field", "field is not supported");
  if (input.protocolVersion !== BROKER_PROTOCOL_VERSION) addError(errors, "$.protocolVersion", "unsupported_protocol", "only broker protocol version 1 is supported");
  if (!MESSAGE_TYPES.includes(input.type)) addError(errors, "$.type", "unsupported_message_type", "message type is not supported");
  validateTimestamp(input.sentAt, "$.sentAt", errors);

  const allowedForType = TYPE_KEYS[input.type];
  if (allowedForType) {
    for (const key of Object.keys(input)) if (!allowedForType.has(key)) addError(errors, `$.${key}`, "field_not_allowed", `field is not allowed on ${input.type} messages`);
  }

  if (input.type === "request") {
    validateId(input.id, "$.id", errors);
    if (typeof input.capability !== "string" || !CAPABILITY_RE.test(input.capability)) addError(errors, "$.capability", "invalid_capability", "must name a versioned capability");
    if (typeof input.method !== "string" || !METHOD_RE.test(input.method)) addError(errors, "$.method", "invalid_method", "must be a stable method identifier");
    if (input.providerId !== undefined && (typeof input.providerId !== "string" || !PROVIDER_ID_RE.test(input.providerId))) {
      addError(errors, "$.providerId", "invalid_provider_id", "must be a lowercase namespaced provider identifier");
    }
    validateTimestamp(input.deadlineAt, "$.deadlineAt", errors);
    if (Number.isSafeInteger(input.deadlineAt) && (input.deadlineAt <= now || input.deadlineAt > now + maxDeadlineMs)) {
      addError(errors, "$.deadlineAt", "invalid_deadline", `must be in the future and no more than ${maxDeadlineMs}ms away`);
    }
  } else if (input.type === "response") {
    validateId(input.replyTo, "$.replyTo", errors);
    if (typeof input.ok !== "boolean") addError(errors, "$.ok", "invalid_type", "must be boolean");
    if (input.ok === false) validateError(input.error, errors);
    if (input.ok === true && input.error !== undefined) addError(errors, "$.error", "field_not_allowed", "successful responses cannot contain an error");
  } else if (input.type === "event") {
    if (typeof input.capability !== "string" || !CAPABILITY_RE.test(input.capability)) addError(errors, "$.capability", "invalid_capability", "must name a versioned capability");
    if (typeof input.method !== "string" || !METHOD_RE.test(input.method)) addError(errors, "$.method", "invalid_method", "must be a stable event identifier");
  } else if (input.type === "cancel") {
    validateId(input.replyTo, "$.replyTo", errors);
  } else if (input.type === "shutdown") {
    validateTimestamp(input.deadlineAt, "$.deadlineAt", errors);
    if (Number.isSafeInteger(input.deadlineAt) && input.deadlineAt <= now) addError(errors, "$.deadlineAt", "invalid_deadline", "must be in the future");
  }

  if (["hello", "ready"].includes(input.type) && !isRecord(input.payload)) addError(errors, "$.payload", "invalid_handshake", "handshake payload must be an object");
  if (Object.prototype.hasOwnProperty.call(input, "payload")) inspectJsonValue(input.payload, errors, limits);
  if (errors.length) return { ok: false, errors, value: null };
  return { ok: true, errors: [], value: input };
}

function parseBrokerFrameV1(frame, options = {}) {
  const maxFrameBytes = Number.isSafeInteger(options.maxFrameBytes) ? options.maxFrameBytes : DEFAULT_MAX_FRAME_BYTES;
  const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(typeof frame === "string" ? frame : "", "utf8");
  if (bytes.length < 2) return { ok: false, errors: [{ path: "$", code: "empty_frame", message: "frame is empty" }], value: null };
  if (bytes.length > maxFrameBytes) return { ok: false, errors: [{ path: "$", code: "frame_too_large", message: `frame exceeds ${maxFrameBytes} bytes` }], value: null };
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, errors: [{ path: "$", code: "invalid_json", message: "frame is not valid JSON" }], value: null };
  }
  return validateBrokerEnvelopeV1(parsed, options);
}

module.exports = {
  BROKER_PROTOCOL_VERSION,
  DEFAULT_MAX_FRAME_BYTES,
  MESSAGE_TYPES,
  parseBrokerFrameV1,
  validateBrokerEnvelopeV1
};
