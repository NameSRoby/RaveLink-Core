// [TITLE] Test Module: test/mod-platform.broker-envelope-v1.test.js
// [TITLE] Purpose: verify bounded and typed third-party mod IPC envelopes

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseBrokerFrameV1,
  validateBrokerEnvelopeV1,
} = require("../src/capabilities/mod-platform/contracts/broker-envelope-v1");

const NOW = 1_800_000_000_000;

function request(overrides = {}) {
  return {
    protocolVersion: 1,
    type: "request",
    sentAt: NOW,
    id: "request_1",
    capability: "song.queue.v1",
    method: "queue.add",
    deadlineAt: NOW + 5000,
    payload: { text: "test" },
    ...overrides,
  };
}

function codes(result) {
  return result.errors.map((error) => error.code);
}

test("broker v1 accepts a bounded request", () => {
  const result = validateBrokerEnvelopeV1(request(), { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.value.id, "request_1");
});

test("broker v1 accepts typed success and failure responses", () => {
  const success = validateBrokerEnvelopeV1({
    protocolVersion: 1,
    type: "response",
    sentAt: NOW,
    replyTo: "request_1",
    ok: true,
    payload: { queued: true },
  });
  assert.equal(success.ok, true);

  const failure = validateBrokerEnvelopeV1({
    protocolVersion: 1,
    type: "response",
    sentAt: NOW,
    replyTo: "request_1",
    ok: false,
    error: {
      code: "provider_unavailable",
      message: "Provider unavailable",
      retryable: true,
    },
  });
  assert.equal(failure.ok, true);
});

test("broker v1 rejects malformed and oversized JSON before dispatch", () => {
  let result = parseBrokerFrameV1("{not json", { now: NOW });
  assert.equal(codes(result).includes("invalid_json"), true);

  result = parseBrokerFrameV1(JSON.stringify(request({ payload: { text: "x".repeat(300) } })), {
    now: NOW,
    maxFrameBytes: 128,
  });
  assert.equal(codes(result).includes("frame_too_large"), true);
});

test("broker v1 rejects expired and unreasonably distant deadlines", () => {
  let result = validateBrokerEnvelopeV1(request({ deadlineAt: NOW }), {
    now: NOW,
  });
  assert.equal(codes(result).includes("invalid_deadline"), true);

  result = validateBrokerEnvelopeV1(request({ deadlineAt: NOW + 60001 }), {
    now: NOW,
  });
  assert.equal(codes(result).includes("invalid_deadline"), true);
});

test("broker v1 rejects fields that do not belong to the message type", () => {
  const result = validateBrokerEnvelopeV1({
    protocolVersion: 1,
    type: "heartbeat",
    sentAt: NOW,
    payload: { smuggled: true },
  });
  assert.equal(result.ok, false);
  assert.equal(codes(result).includes("field_not_allowed"), true);
});

test("broker v1 rejects prototype-sensitive payload keys", () => {
  const frame = `{"protocolVersion":1,"type":"event","sentAt":${NOW},"capability":"song.queue.v1","method":"queue.changed","payload":{"__proto__":{"admin":true}}}`;
  const result = parseBrokerFrameV1(frame, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(codes(result).includes("forbidden_key"), true);
  assert.equal({}.admin, undefined);
});

test("broker v1 rejects excessive payload depth and node count", () => {
  let payload = { leaf: true };
  for (let index = 0; index < 20; index += 1) payload = { child: payload };
  let result = validateBrokerEnvelopeV1(request({ payload }), {
    now: NOW,
    maxDepth: 8,
  });
  assert.equal(codes(result).includes("payload_too_deep"), true);

  result = validateBrokerEnvelopeV1(
    request({ payload: Array.from({ length: 20 }, (_, value) => value) }),
    {
      now: NOW,
      maxNodes: 10,
    },
  );
  assert.equal(codes(result).includes("payload_too_complex"), true);
});

test("broker v1 rejects ambiguous response errors", () => {
  let result = validateBrokerEnvelopeV1({
    protocolVersion: 1,
    type: "response",
    sentAt: NOW,
    replyTo: "request_1",
    ok: false,
  });
  assert.equal(codes(result).includes("invalid_error"), true);

  result = validateBrokerEnvelopeV1({
    protocolVersion: 1,
    type: "response",
    sentAt: NOW,
    replyTo: "request_1",
    ok: true,
    error: { code: "bad", message: "not allowed" },
  });
  assert.equal(codes(result).includes("field_not_allowed"), true);
});
