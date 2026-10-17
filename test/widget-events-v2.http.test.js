const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createCoreServer = require("../src/app/core/create-core-server");
const createFeaturePlatformExtension = require("../src/app/optional/create-feature-platform-extension");

function body(id) {
  return {
    contract: "widget.events.v2",
    source: "streamelements",
    eventEnvelope: { detail: { listener: "message", event: { id } } },
  };
}

test("widget intake authenticates before its independent rate bucket and emits Retry-After", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-widget-v2-http-"));
  const { app, services } = createCoreServer({
    runtimeDir,
    dryRun: true,
    widgetIntakeToken: "scoped-token",
    widgetIntakeLimiterOptions: { capacity: 2, refillPerSecond: 0.1 },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await services.lifecycle.stopAll();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (token, id) =>
    fetch(`${base}/widget/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body(id)),
    });

  const status = await fetch(`${base}/system/status`).then((response) => response.json());
  assert.equal(status.widgetSecurity.scopedTokenConfigured, true);
  assert.equal(status.widgetSecurity.crossOriginEnabled, true);
  assert.equal(JSON.stringify(status).includes("scoped-token"), false);

  const unauthorized = await send("wrong", "unauthorized");
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).disposition, "rejected");
  assert.equal(services.widgetIntakeLimiter.getDiagnostics().accepted, 0);

  assert.equal((await send("scoped-token", "one")).status, 200);
  assert.equal((await send("scoped-token", "two")).status, 200);
  const limited = await send("scoped-token", "three");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "10");
  assert.equal((await limited.json()).disposition, "rate_limited");
});

test("managed widget token enables hosted CORS immediately and preserves a rotation overlap", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-widget-managed-http-"));
  const generated = ["m".repeat(43), "n".repeat(43), "o".repeat(43)];
  const { app, services } = createCoreServer({
    runtimeDir,
    dryRun: true,
    widgetTokenVaultOptions: {
      persistent: false,
      generateToken: () => generated.shift(),
    },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await services.lifecycle.stopAll();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const hostedHeaders = {
    Origin: "https://streamelements.com",
    "content-type": "application/json",
  };
  const preflight = () =>
    fetch(`${base}/widget/events`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://streamelements.com",
        "Access-Control-Request-Method": "POST",
      },
    });
  assert.equal((await preflight()).status, 403);

  const first = await fetch(`${base}/system/widget-token/rotate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.json());
  assert.equal(first.token, "m".repeat(43));
  const allowed = await preflight();
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://streamelements.com");

  const second = await fetch(`${base}/system/widget-token/rotate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.json());
  const oldTokenResponse = await fetch(`${base}/widget/events`, {
    method: "POST",
    headers: { ...hostedHeaders, authorization: `Bearer ${first.token}` },
    body: JSON.stringify(body("old-overlap")),
  });
  assert.equal(oldTokenResponse.status, 200);
  assert.equal(second.widgetSecurity.overlapActive, true);

  const rejectedTemplate = await fetch(`${base}/system/widget-template-get`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      widgetIntakeToken: "wrong",
      colorRewardId: "lights",
    }),
  });
  assert.equal(rejectedTemplate.status, 401);
  const rebuilt = await fetch(`${base}/system/widget-template-rebuild`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ colorRewardId: "lights", baseUrl: base }),
  }).then((response) => response.json());
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.token, undefined);
  assert.equal(rebuilt.script.includes("o".repeat(43)), true);

  const cleared = await fetch(`${base}/system/widget-token/clear`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.json());
  assert.equal(cleared.widgetSecurity.configured, false);
  assert.equal((await preflight()).status, 403);
});

test("environment-owned widget token cannot be rotated through HTTP", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-widget-env-http-"));
  const { app, services } = createCoreServer({
    runtimeDir,
    dryRun: true,
    widgetIntakeToken: "environment-token",
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await services.lifecycle.stopAll();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/system/widget-token/rotate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "widget_token_environment_managed");
});

test("core reports a missing targeted capability without falling through to light handling", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-widget-target-http-"));
  const { app, services } = createCoreServer({ runtimeDir, dryRun: true });
  let handled = 0;
  const original = services.widgetController.handleWidgetEvent;
  services.widgetController.handleWidgetEvent = async (payload) => {
    handled += 1;
    return original(payload);
  };
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await services.lifecycle.stopAll();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/widget/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...body("targeted-mod"),
      target: "song-request",
      widgetConfig: { colorRewardId: "reward-color" },
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 503);
  assert.equal(result.disposition, "degraded");
  assert.equal(result.error, "widget_target_unavailable");
  assert.equal(handled, 0);
});

test("StreamElements Song Request intake reaches the supervised YouTube queue without Helix", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-widget-song-http-"));
  const featuresRoot = path.join(root, "installed");
  fs.mkdirSync(featuresRoot, { recursive: true });
  fs.cpSync(
    path.join(__dirname, "..", "features", "song-request"),
    path.join(featuresRoot, "song-request"),
    { recursive: true },
  );
  const created = createCoreServer({
    rootDir: path.join(__dirname, ".."),
    runtimeDir: path.join(root, "runtime"),
    dryRun: true,
    capabilities: { features: true },
    extend: createFeaturePlatformExtension({
      featuresRoot,
      runtimeRoot: path.join(root, "runtime", "features"),
      allowUnsafeRuntime: true,
      providers: {
        "youtube.catalog.host.v1/resolve": async (payload) => ({
          ok: true,
          candidate: {
            provider: "youtube",
            providerItemId: payload.videoId,
            title: "Conveyor fixture track",
            artists: [],
            durationMs: 180000,
          },
        }),
      },
    }),
  });
  await created.extension.startup;
  await created.extension.registry.enable("song-request");
  const server = await new Promise((resolve) => {
    const instance = created.app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await created.services.lifecycle.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/widget/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contract: "widget.events.v2",
      source: "streamelements",
      widgetConfig: { songRewardId: "viewer-created-song-reward" },
      eventEnvelope: eventBody(
        "song-http-1",
        "viewer-created-song-reward",
        "https://youtu.be/dQw4w9WgXcQ",
      ),
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.action, "song_request");
  assert.equal(result.status, "NOT_APPLICABLE");
  assert.equal(result.settlement.reason, "transport_conveyor_only");

  const queued = await created.extension.registry.request(
    "song-request",
    "song.queue.read.v1",
    "status",
    {},
    { timeoutMs: 12000 },
  );
  assert.equal(queued.ok, true);
  assert.equal(queued.value.counts.queued, 1);
  assert.equal(queued.value.queue[0].candidate.providerItemId, "dQw4w9WgXcQ");
});

function eventBody(id, rewardId, userInput) {
  return {
    detail: {
      listener: "redemption-latest",
      event: {
        redemption: {
          id,
          user_id: "viewer-1",
          user_name: "viewer",
          user_input: userInput,
          reward: { id: rewardId },
        },
      },
    },
  };
}
