// [TITLE] Test Module: test/mod-platform.sdk.test.js
// [TITLE] Purpose: verify standalone SDK definition, client, deterministic harness, and import independence

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { defineMod, createCapabilityClient, summarizeManifest } = require("../packages/mod-sdk");
const { createModTestHarness } = require("../packages/mod-sdk/testing");

test("SDK defines a frozen mod and runs deterministic fake capabilities", async () => {
  let client;
  let saved;
  const mod = defineMod({
    activate(context) {
      client = createCapabilityClient(context);
    },
    async handleRequest(request) {
      saved = await client.call("ravelink.storage.v1", "set", request.payload);
      client.publish("example.status.v1", "changed", { saved: true });
      return { saved, at: 1700000000100 };
    },
  });
  const harness = createModTestHarness(mod, {
    modId: "example.test",
    startAt: 1700000000000,
    providers: {
      "ravelink.storage.v1/set": async (payload) => ({ key: payload.key }),
    },
  });
  await harness.start();
  harness.advance(100);
  const response = await harness.request("example.status.v1", "save", {
    key: "prefs",
    value: true,
  });
  assert.deepEqual(response, { saved: { key: "prefs" }, at: 1700000000100 });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.events.length, 1);
  assert.equal(Object.isFrozen(mod), true);
  await harness.stop();
});

test("SDK rejects unknown handlers and summarizes permissions without mutation", () => {
  assert.throws(() => defineMod({ activate() {}, surprise() {} }), /unknown_mod_handler/);
  const summary = summarizeManifest({
    id: "example.mod",
    version: "1.0.0",
    permissions: { storage: true },
    resources: { timers: 1 },
  });
  assert.equal(summary.permissions.storage, true);
  assert.equal(summary.resources.timers, 1);
  assert.equal(Object.isFrozen(summary), true);
});

test("SDK clock accepts epoch zero and rejects invalid start times", async () => {
  const mod = defineMod({ activate() {} });
  const harness = createModTestHarness(mod, { startAt: 0 });
  await harness.start();
  assert.equal(harness.now(), 0);
  assert.equal(harness.advance(25), 25);
  assert.equal(typeof harness.createClient().call, "function");
  await harness.stop();
  assert.throws(() => createModTestHarness(mod, { startAt: NaN }), /clock_start_invalid/);
});

test("documented button starter reports only its own state and respects cancellation", async () => {
  const mod = require("../packages/mod-sdk/starter/main");
  const harness = createModTestHarness(mod, {
    modId: "example.button",
    provides: ["example.button.v1"],
  });
  await harness.start();
  assert.equal((await harness.request("example.button.v1", "status", {})).enabled, false);
  assert.equal((await harness.request("example.button.v1", "toggle", {})).enabled, true);
  assert.equal((await harness.request("example.button.v1", "status", {})).enabled, true);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    harness.request("example.button.v1", "toggle", {}, cancelled.signal),
    /request_cancelled/,
  );
  assert.equal((await harness.request("example.button.v1", "status", {})).enabled, true);
  assert.equal(harness.calls.length, 0);
  await harness.stop();
});

test("SDK package has no server imports or runtime dependencies", () => {
  const root = path.join(__dirname, "..", "packages", "mod-sdk");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies, undefined);
  for (const file of ["index.js", "testing.js"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.equal(source.includes("src/"), false);
    assert.equal(source.includes("src\\"), false);
  }
  for (const schema of ["mod-manifest-v1.schema.json", "broker-envelope-v1.schema.json"]) {
    const publicSchema = fs.readFileSync(path.join(root, "schemas", schema), "utf8");
    const hostSchema = fs.readFileSync(
      path.join(__dirname, "..", "src", "capabilities", "mod-platform", "contracts", schema),
      "utf8",
    );
    assert.equal(publicSchema, hostSchema, `${schema} must not drift from the host contract`);
  }
});
