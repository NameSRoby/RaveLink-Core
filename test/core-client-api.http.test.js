const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const createCoreServer = require("../src/app/core/create-core-server");
const registerClientApiRoutes = require("../src/app/core/register-client-api.routes");
const { document } = require("../src/domains/system/core-client-contracts");
const { validateValue } = require("../src/shared/contracts/bounded-json-schema");
const fixtures = require("./fixtures/core-client-v1.json");

test("published Core contracts and cross-language examples cover every operation and stay in sync", () => {
  const published = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../docs/contracts/core-client-api-v1.json")),
  );
  const { revision } = require("../src/domains/system/core-client-contracts");
  assert.deepEqual(published, { ...document, contractRevision: revision });
  assert.deepEqual(
    fixtures.fixtures.map((row) => row.operation),
    document.operations.map((row) => row.id),
  );
  for (const fixture of fixtures.fixtures) {
    const operation = document.operations.find((row) => row.id === fixture.operation);
    assert.equal(
      validateValue(operation.request, fixture.request),
      true,
      fixture.operation + " request",
    );
    assert.equal(
      validateValue(operation.response, fixture.response),
      true,
      fixture.operation + " response",
    );
  }
  for (const error of fixtures.errors) assert.equal(validateValue(document.error, error), true);
});

async function listen(t, app) {
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body, headers = {}) => {
    const response = await fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
    };
  };
  request.base = base;
  return request;
}
async function core(t) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-core-contract-"));
  const created = createCoreServer({
    runtimeDir,
    dryRun: true,
    fixtureSecretVaultOptions: require("./support/fixture-vault-codec.cjs"),
    widgetIntakeToken: "contract-test-scoped-token",
  });
  t.after(async () => {
    await created.services.lifecycle.stopAll();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { ...created, request: await listen(t, created.app) };
}
function schemaFor(id, body) {
  const operation = document.operations.find((row) => row.id === id);
  assert.ok(
    validateValue(body.ok === false ? document.error : operation.response, body),
    id + ": " + JSON.stringify(body),
  );
}
test("Core client handshake negotiates versions and required operations without starting optional features", async (t) => {
  const { request } = await core(t);
  const first = await request("/system/client-api");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.body.server.capabilities.features, false);
  assert.equal(first.body.server.capabilities.mods, false);
  assert.deepEqual(first.body.apiVersion, { major: 1, minor: 0 });
  assert.equal(validateValue(document.handshake.get.response, first.body), true);
  assert.equal(
    (await request("/system/client-api")).body.serverInstanceId,
    first.body.serverInstanceId,
  );
  const other = await core(t);
  assert.notEqual(
    (await other.request("/system/client-api")).body.serverInstanceId,
    first.body.serverInstanceId,
  );
  const schemas = await request("/system/client-api/contracts");
  assert.equal(schemas.body.contractRevision, first.body.contractRevision);
  assert.equal(schemas.body.operations.length, 17);
  assert.equal(JSON.stringify(schemas.body).includes("contract-test-scoped-token"), false);
  assert.equal(
    (
      await request("/system/client-api/negotiate", {
        apiMajor: 1,
        requiredOperations: ["health", "lights.apply", "fixtures.list"],
      })
    ).body.compatible,
    true,
  );
  for (const body of [
    { apiMajor: 0 },
    { apiMajor: 2 },
    { apiMajor: 1, minimumMinor: 1 },
    { apiMajor: 1, requiredOperations: ["future.operation"] },
  ]) {
    const result = await request("/system/client-api/negotiate", body);
    assert.equal(result.status, 409);
    assert.equal(result.body.compatible, false);
    assert.equal(validateValue(document.handshake.negotiate.response, result.body), true);
  }
  assert.equal((await request("/system/client-api/negotiate", { apiMajor: "1" })).status, 400);
  assert.equal(
    (
      await request("/system/client-api/negotiate", {
        apiMajor: 1,
        requiredOperations: Array(65).fill("health"),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/system/client-api", undefined, {
        Origin: "https://untrusted.example",
      })
    ).status,
    403,
  );
  assert.equal((await request("/api/core/v1/unknown")).status, 404);
});
test("typed Core workflows reuse real fixture, lighting, widget and update owners with validation before effects", async (t) => {
  const { request, services } = await core(t);
  const command = async (id, body) => {
    const result = await request("/api/core/v1/" + id, body);
    schemaFor(id, result.body);
    return result;
  };
  assert.equal((await command("health")).body.ok, true);
  assert.equal(
    (
      await command("fixtures.upsert", {
        id: "desk",
        brand: "wiz",
        ip: "192.0.2.10",
        enabled: "true",
      })
    ).status,
    400,
  );
  assert.equal(services.lightingCore.fixtureRegistry.getFixtures().length, 0);
  const malformed = await fetch(request.base + "/api/core/v1/fixtures.upsert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, "invalid json payload");
  assert.equal(services.lightingCore.fixtureRegistry.getFixtures().length, 0);
  const inserted = await command("fixtures.upsert", {
    id: "desk",
    name: "Desk",
    brand: "wiz",
    ip: "192.0.2.10",
    enabled: true,
  });
  assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
  assert.equal(inserted.body.fixture.deviceIpConfigured, true);
  assert.equal("ip" in inserted.body.fixture, false);
  const fixtures = await command("fixtures.list");
  assert.equal(fixtures.body.fixtures.length, 1);
  const edit = await command("fixtures.edit", { id: "desk" });
  assert.equal(edit.body.fixture.ip, "192.0.2.10");
  assert.equal(edit.body.oneTimeReveal, true);
  const applied = await command("lights.apply", {
    text: "red",
    fixtureId: "desk",
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.sent, 1);
  assert.equal(
    (
      await command("lights.apply", {
        text: "red",
        fixtureIds: Array(65).fill("desk"),
      })
    ).status,
    400,
  );
  assert.equal((await command("lights.apply", { text: "x".repeat(1025) })).status, 400);
  assert.equal((await command("fixtures.delete", { id: "../health" })).status, 404);
  const widgetState = await command("widget.status");
  assert.equal(widgetState.body.widgetSecurity.configured, true);
  assert.deepEqual(Object.keys(widgetState.body), ["ok", "widgetSecurity"]);
  const widget = await command("widget.get", {
    baseUrl: "http://127.0.0.1:5050",
    widgetIntakeToken: "contract-test-scoped-token",
  });
  assert.equal(widget.status, 200);
  assert.match(widget.body.script, /widget\/events/);
  assert.equal((await command("widget.get", { widgetIntakeToken: "wrong" })).status, 401);
  assert.equal(
    (await command("updates.configure", { checkOnLaunch: true })).body.checkOnLaunch,
    true,
  );
  assert.equal((await command("updates.configure", { checkOnLaunch: "false" })).status, 400);
  assert.equal((await command("updates.status")).body.checkOnLaunch, true);
  const removed = await command("fixtures.delete", { id: "desk" });
  assert.equal(removed.status, 200);
  assert.equal((await command("fixtures.edit", { id: "desk" })).status, 404);
  assert.equal((await command("fixtures.list")).body.fixtures.length, 0);
  assert.equal(
    (await request("/health")).body.ok,
    true,
    "legacy recovery HUD routes remain usable",
  );
});
test("invalid owner replies and update exceptions give bounded errors without replaying writes or exposing internal messages", async (t) => {
  const app = express();
  app.use(express.json());
  registerClientApiRoutes(app, {
    getHealth: () => ({
      ok: true,
      version: "test",
      profile: "core",
      capabilities: { lightingCore: true },
    }),
  });
  let applied = 0;
  app.post("/color", (_req, res) => {
    applied++;
    res.json({ ok: true, sent: "invalid count" });
  });
  app.get("/fixtures", (_req, res) =>
    res.json({
      ok: true,
      version: 0,
      connectivity: {},
      fixtures: Array(257).fill({
        id: "desk",
        name: "Desk",
        brand: "wiz",
        enabled: true,
        credentialsConfigured: false,
      }),
    }),
  );
  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      version: "test",
      profile: "core",
      capabilities: { lightingCore: true },
      extra: "x".repeat(document.limits.responseBytes),
    }),
  );
  app.post("/system/update/apply", (_req, _res, next) => next(new Error("windows_host_required")));
  app.post("/system/update/rollback", (_req, _res, next) =>
    next(new Error("private-path-and-credential")),
  );
  app.use(registerClientApiRoutes.errorHandler);
  const request = await listen(t, app);
  const result = await request("/api/core/v1/lights.apply", { text: "red" });
  assert.equal(result.status, 502);
  assert.equal(result.body.outcome, "unknown");
  assert.equal(applied, 1);
  assert.equal((await request("/api/core/v1/fixtures.list")).status, 502);
  assert.equal((await request("/api/core/v1/health")).status, 502);
  assert.equal(
    (await request("/api/core/v1/updates.apply", {})).body.error,
    "windows_host_required",
  );
  const failure = await request("/api/core/v1/updates.rollback", {});
  assert.equal(failure.status, 500);
  assert.equal(JSON.stringify(failure.body).includes("private-path-and-credential"), false);
  assert.equal(
    (
      await request("/api/core/v1/lights.apply", {
        text: "red",
        surprise: true,
      })
    ).status,
    400,
  );
  assert.equal(applied, 1);
});
