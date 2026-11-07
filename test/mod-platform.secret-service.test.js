// [TITLE] Test Module: test/mod-platform.secret-service.test.js
// [TITLE] Purpose: verify opaque operation-only secret handles and redacted audit

const test = require("node:test");
const assert = require("node:assert/strict");
const createSecrets = require("../src/capabilities/mod-platform/host/mod-secret-service");

test("secret service authorizes declared handles without exposing credential values", async () => {
  const service = createSecrets();
  const credential = "jwt-super-secret";
  service.register({
    handle: "streamelements.chat",
    available: () => true,
    operations: {
      send: {
        perform: async (payload) => ({
          accepted: Boolean(credential && payload.text),
        }),
        validateResult: (value) => value?.accepted === true,
      },
    },
  });
  const manifest = {
    id: "example.chat",
    permissions: { secrets: ["streamelements.chat"] },
  };
  assert.deepEqual(
    await service.invoke(manifest, "streamelements.chat", "send", {
      text: "hello",
    }),
    { ok: true, result: { accepted: true } },
  );
  const serialized = JSON.stringify(service.getStatus(manifest));
  assert.equal(serialized.includes(credential), false);
  assert.equal(serialized.includes("hello"), false);
});

test("secret service denies undeclared, raw-value, unavailable, and failed operations", async () => {
  const service = createSecrets();
  assert.throws(
    () =>
      service.register({
        handle: "bad.handle",
        operations: {
          "token.get": { perform: () => "bad", validateResult: () => true },
        },
      }),
    /invalid_secret_operation/,
  );
  service.register({
    handle: "provider.auth",
    available: () => false,
    operations: {
      refresh: {
        perform: () => null,
        validateResult: (value) => value === null,
      },
      sign: {
        perform: () => {
          throw new Error("sensitive");
        },
        validateResult: () => false,
      },
    },
  });
  assert.equal(
    (
      await service.invoke(
        { id: "example.mod", permissions: { secrets: [] } },
        "provider.auth",
        "refresh",
        null,
      )
    ).error,
    "secret_permission_denied",
  );
  const manifest = {
    id: "example.mod",
    permissions: { secrets: ["provider.auth"] },
  };
  assert.equal(
    (await service.invoke(manifest, "provider.auth", "refresh", null)).error,
    "secret_not_configured",
  );
  const rejecting = createSecrets();
  rejecting.register({
    handle: "provider.auth",
    operations: {
      sign: { perform: () => "raw-secret", validateResult: () => false },
    },
  });
  assert.equal(
    (await rejecting.invoke(manifest, "provider.auth", "sign", null)).error,
    "secret_response_rejected",
  );
});
