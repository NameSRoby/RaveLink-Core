// [TITLE] Test Module: test/lighting-core.independence.test.js
// [TITLE] Purpose: prove the preserved lighting core runs without OAuth, rave, audio, LIVE, mods, or MIDI

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const createLightingCore = require("../src/app/core/create-lighting-core");
const createCoreServer = require("../src/app/core/create-core-server");

test("lighting core parses and applies a Twitch color without retired capabilities", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-lighting-core-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const runtimeDir = path.join(rootDir, "runtime");
  const core = createLightingCore({
    rootDir,
    dryRun: true,
    paths: {
      colorsStorePath: path.join(runtimeDir, "colors", "colors.custom.json"),
      fixturesStorePath: path.join(runtimeDir, "fixtures", "fixtures.json"),
      twitchConfigPath: path.join(runtimeDir, "twitch", "twitch.color.config.json")
    }
  });

  const fixture = core.fixtureRegistry.upsertFixture({
    id: "wiz-core-1",
    brand: "wiz",
    zone: "wiz",
    ip: "192.0.2.10",
    twitchEnabled: true,
    engineEnabled: false
  });
  assert.equal(fixture.ok, true);
  core.twitchLightRouting.save({
    ...core.twitchLightRouting.snapshot(),
    mode: "assignments",
    rules: [{ id: "active-fixtures", name: "Active Fixtures", prefix: "", enabled: true, fixtureIds: ["wiz-core-1"] }]
  });

  const parsed = core.directiveService.parseTwitchColorDirective("red");
  assert.equal(parsed.ok, true);

  const applied = await core.colorCommandService.applyColorText("red");
  assert.equal(applied.ok, true);
  assert.equal(applied.target, "both");
  assert.equal(applied.hueTargets, 0);
  assert.equal(applied.wizTargets, 1);
});

test("lighting core modules have no retired-capability imports", () => {
  for (const file of ["index.js", "create-lighting-core.js", "create-core-server.js", "register-lighting-core.routes.js"]) {
    const source = fs.readFileSync(path.resolve(__dirname, "../src/app/core", file), "utf8");
    for (const forbiddenImport of [
      "domains/audio",
      "domains/engine-v2",
      "domains/live",
      "domains/midi",
      "domains/mods",
      "capabilities/mod-platform",
      "system-oauth"
    ]) {
      assert.equal(source.includes(forbiddenImport), false, `${file} imports ${forbiddenImport}`);
    }
  }
});

test("core HTTP server declares absent capabilities and applies color independently", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-core-http-"));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const { app, services } = createCoreServer({ runtimeDir, dryRun: true });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/health`).then(response => response.json());
  assert.equal(health.profile, "clean-slate-core");
  assert.equal("raveEngine" in health.capabilities, false);
  assert.equal("twitchOauth" in health.capabilities, false);
  assert.equal(health.capabilities.mods, false);
  assert.deepEqual(Object.keys(services), ["lightingCore", "hardwareOnboarding", "coreUpdates", "widgetController", "widgetIntakeLimiter", "widgetTokenVault", "runtimeMetrics", "egressGovernor", "lifecycle"]);
  const loadedModules = Object.keys(require.cache).join("\n").replaceAll("\\", "/");
  for (const forbiddenModule of ["/domains/audio/", "/domains/engine-v2/", "/domains/live/", "/domains/midi/", "/domains/mods/"]) {
  assert.equal(loadedModules.includes(forbiddenModule), false, `core loaded ${forbiddenModule}`);
  }

  const initialStatusResponse = await fetch(`${base}/system/status`);
  const initialStatus = await initialStatusResponse.json();
  assert.equal(initialStatus.schemaVersion, 1);
  assert.match(initialStatus.revision, /^[a-f0-9]{16}$/);
  assert.equal(initialStatus.fixtures.items.length, 0);
  assert.equal(initialStatus.widgetSecurity.scopedTokenConfigured, false);
  assert.equal(initialStatus.widgetSecurity.crossOriginEnabled, false);
  assert.equal(JSON.stringify(initialStatus).includes("jwt"), false);
  assert.equal(JSON.stringify(initialStatus).includes("secret"), false);
  const unchangedStatus = await fetch(`${base}/system/status`, {
    headers: { "if-none-match": initialStatusResponse.headers.get("etag") }
  });
  assert.equal(unchangedStatus.status, 304);

  const fixtureResponse = await fetch(`${base}/fixtures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "wiz-core-http", brand: "wiz", ip: "127.0.0.2", twitchEnabled: true })
  });
  assert.equal(fixtureResponse.status, 200);
  services.lightingCore.twitchLightRouting.save({
    ...services.lightingCore.twitchLightRouting.snapshot(),
    mode: "assignments",
    rules: [{ id: "active-fixtures", name: "Active Fixtures", prefix: "", enabled: true, fixtureIds: ["wiz-core-http"] }]
  });
  const colorResponse = await fetch(`${base}/color`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "wiz red" })
  });
  assert.equal(colorResponse.status, 200);
  assert.equal((await colorResponse.json()).wizTargets, 1);

  const retiredAnnouncement = await fetch(`${base}/mods/music-request-engine/now_playing_announce`, { method: "POST" });
  assert.equal(retiredAnnouncement.status, 204);
  assert.equal(retiredAnnouncement.headers.get("deprecation"), "true");
  assert.equal(await retiredAnnouncement.text(), "");
  const blockedRetiredAnnouncement = await fetch(`${base}/mods/music-request-engine/now_playing_announce`, {
    method: "POST",
    headers: { origin: "https://attacker.invalid" }
  });
  assert.equal(blockedRetiredAnnouncement.status, 403);

  for (let index = 0; index < 30; index += 1) {
    const irrelevant = await fetch(`${base}/widget/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contract: "widget.events.v2", source: "streamelements", eventEnvelope: { detail: { listener: "message", event: { text: `message-${index}` } } } })
    }).then(response => response.json());
    assert.equal(irrelevant.disposition, "irrelevant");
  }
  const validAfterNoise = await fetch(`${base}/widget/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contract: "widget.events.v2",
      source: "streamelements",
      widgetConfig: { colorRewardId: "reward-color" },
      eventEnvelope: { detail: { listener: "redemption-latest", event: { redemption: { id: "after-noise", user_input: "red", reward: { id: "reward-color" } } } } }
    })
  }).then(response => response.json());
  assert.equal(validAfterNoise.disposition, "handled");

  const shell = await fetch(`${base}/`).then(response => response.text());
  assert.match(shell, /RAVELINK/);
  assert.doesNotMatch(shell, /AUDIO|MIDI|OAUTH/);

  const retiredSettingsResponse = await fetch(`${base}/system/config`);
  assert.equal(retiredSettingsResponse.status, 404);

  const diagnosticsResponse = await fetch(`${base}/system/diagnostics`);
  const diagnostics = await diagnosticsResponse.json();
  assert.equal(diagnosticsResponse.status, 200);
  assert.equal(diagnostics.owner, "core");
  assert.equal(diagnostics.process.rssMiB > 0, true);
  assert.deepEqual(diagnostics.process.ownedWork.map(row => `${row.owner}:${row.id}`), ["core:runtime-metrics", "core:egress-governor", "lighting.transports:hue-wiz-adapters"]);
  assert.equal(diagnostics.routes.some(row => row.route === "POST /color"), true);
  assert.equal(JSON.stringify(diagnostics).includes("wiz-core-http"), false);
  assert.equal(diagnostics.instrumentation.recurringTimers, 0);
  assert.equal(diagnostics.instrumentation.retainedLatencySamples <= 250, true);
  assert.equal(diagnostics.domains.egress.maximumConcurrent, 4);
  assert.equal(diagnostics.domains.egress.maximumQueued, 32);
  assert.equal(diagnostics.domains.egress.active, 0);
  assert.equal(diagnostics.domains.egress.queued, 0);
  assert.equal(diagnostics.domains.lightingTransports.owner, "lighting.transports");
  assert.equal(diagnostics.domains.lightingTransports.hueEntertainment.maximumDnsOverrides, 768);
  assert.equal(JSON.stringify(diagnostics).includes("signify.pem"), false);

  const oversizedResponse = await fetch(`${base}/teach`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "oversized", hex: "#ffffff", padding: "x".repeat(70 * 1024) })
  });
  assert.equal(oversizedResponse.status, 413);

  const widgetResponse = await fetch(`${base}/system/widget-template-get`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ colorRewardId: "reward-color", baseUrl: base })
  });
  const widget = await widgetResponse.json();
  assert.equal(widgetResponse.status, 200);
  assert.match(widget.script, /minimal event forwarder/);
  assert.doesNotMatch(widget.script, /BotJwt|UserAccessToken|oauth/i);
});

test("capability snapshots follow live Song Request feature lifecycle", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-live-capabilities-"));
  let lifecycle = "installed-disabled";
  const created = createCoreServer({
    runtimeDir,
    dryRun: true,
    capabilities: { features: true },
    extend: () => ({ registry: { list: () => ({ features: [{ id: "song-request", lifecycle }] }) } })
  });
  const server = await new Promise(resolve => {
    const listening = created.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(async () => {
    await created.services.lifecycle.stopAll();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/health`).then(response => response.json())).capabilities.songRequest, false);
  lifecycle = "active";
  assert.equal((await fetch(`${base}/health`).then(response => response.json())).capabilities.songRequest, true);
  assert.equal((await fetch(`${base}/system/status`).then(response => response.json())).capabilities.songRequest, true);
});
