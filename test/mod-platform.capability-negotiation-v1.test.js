// [TITLE] Test Module: test/mod-platform.capability-negotiation-v1.test.js
// [TITLE] Purpose: verify deterministic optional capability discovery dispositions

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CAPABILITY_DISPOSITIONS,
  negotiateManifestCapabilities,
  resolveCapabilityDisposition,
} = require("../src/capabilities/mod-platform/contracts/capability-negotiation-v1");

test("capability resolver reports every stable disposition", () => {
  assert.deepEqual(CAPABILITY_DISPOSITIONS, [
    "available",
    "unavailable",
    "disabled",
    "incompatible",
    "unhealthy",
    "ambiguous",
  ]);
  assert.equal(resolveCapabilityDisposition("chat.send.v1", []).disposition, "unavailable");
  assert.equal(
    resolveCapabilityDisposition("chat.send.v1", [
      {
        capability: "chat.send.v1",
        providerId: "ravelink.chat",
        enabled: false,
        healthy: false,
      },
    ]).disposition,
    "disabled",
  );
  assert.equal(
    resolveCapabilityDisposition("chat.send.v1", [
      {
        capability: "chat.send.v2",
        providerId: "ravelink.chat",
        enabled: true,
        healthy: true,
      },
    ]).disposition,
    "incompatible",
  );
  assert.equal(
    resolveCapabilityDisposition("chat.send.v1", [
      {
        capability: "chat.send.v1",
        providerId: "ravelink.chat",
        enabled: true,
        healthy: false,
      },
    ]).disposition,
    "unhealthy",
  );
});

test("capability resolver requires explicit selection when providers are ambiguous", () => {
  const result = resolveCapabilityDisposition("chat.send.v1", [
    {
      capability: "chat.send.v1",
      providerId: "alpha.chat",
      enabled: true,
      healthy: true,
    },
    {
      capability: "chat.send.v1",
      providerId: "beta.chat",
      enabled: true,
      healthy: true,
    },
  ]);
  assert.equal(result.disposition, "ambiguous");
  assert.deepEqual(result.candidates, ["alpha.chat", "beta.chat"]);
});

test("optional unavailable dependencies do not block activation", () => {
  const result = negotiateManifestCapabilities(
    {
      consumes: ["chat.send.v1?", "song.queue.v1"],
    },
    [
      {
        capability: "song.queue.v1",
        providerId: "ravelink.song",
        enabled: true,
        healthy: true,
      },
    ],
  );
  assert.equal(result.ok, true);
  assert.equal(result.dependencies[0].optional, true);
  assert.equal(result.dependencies[0].disposition, "unavailable");
});

test("required disabled, unhealthy, incompatible, or ambiguous dependencies block activation", () => {
  for (const providers of [
    [
      {
        capability: "chat.send.v1",
        providerId: "ravelink.chat",
        enabled: false,
        healthy: false,
      },
    ],
    [
      {
        capability: "chat.send.v1",
        providerId: "ravelink.chat",
        enabled: true,
        healthy: false,
      },
    ],
    [
      {
        capability: "chat.send.v2",
        providerId: "ravelink.chat",
        enabled: true,
        healthy: true,
      },
    ],
    [
      {
        capability: "chat.send.v1",
        providerId: "alpha.chat",
        enabled: true,
        healthy: true,
      },
      {
        capability: "chat.send.v1",
        providerId: "beta.chat",
        enabled: true,
        healthy: true,
      },
    ],
  ]) {
    const result = negotiateManifestCapabilities({ consumes: ["chat.send.v1"] }, providers);
    assert.equal(result.ok, false);
    assert.equal(result.blocked.length, 1);
  }
});
