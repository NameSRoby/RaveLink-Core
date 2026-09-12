// [TITLE] Module: app/core/create-core-server.js
// [TITLE] Purpose: independently bootable clean-slate lighting HTTP server

const path = require("node:path");
const express = require("express");
const axios = require("axios");
const createLightingCore = require("./create-lighting-core");
const registerLightingCoreRoutes = require("./register-lighting-core.routes");
const { installRequestSecurityMiddleware } = require("../runtime/request-security.middleware");
const { createSystemWidgetEventController } = require("../../domains/system/widget-event.controller");
const createRuntimeMetricsService = require("../../domains/system/runtime-metrics.service");
const createLifecycleRegistry = require("../../domains/system/lifecycle-registry");
const createTokenBucket = require("../runtime/token-bucket");
const { createWidgetIntakeTokenVault } = require("../../domains/system/widget-intake-token-vault");
const createEgressGovernor = require("../runtime/egress-governor");
const createHardwareOnboardingService = require("../../domains/fixtures/hardware-onboarding.service");

module.exports = function createCoreServer(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "../../.."));
  const runtimeDir = path.resolve(options.runtimeDir || path.join(rootDir, "runtime"));
  const widgetIntakeToken = String(options.widgetIntakeToken ?? process.env.RAVELINK_WIDGET_INTAKE_TOKEN ?? "").trim();
  const widgetOrigins = Array.isArray(options.widgetOrigins)
    ? options.widgetOrigins
    : String(process.env.RAVELINK_WIDGET_ALLOWED_ORIGINS || "https://streamelements.com").split(",");
  const egressGovernor = createEgressGovernor(options.egressGovernorOptions);
  const profile = options.profile || (options.capabilities?.mods && options.capabilities?.features
    ? "clean-slate-core+features+mods"
    : options.capabilities?.features
      ? "clean-slate-core+features"
      : options.capabilities?.mods
        ? "clean-slate-core+mods"
        : "clean-slate-core");
  const core = createLightingCore({
    rootDir,
    axios: options.axios || axios,
    dryRun: options.dryRun === true,
    log: options.log || console,
    egressGovernor,
    fixtureSecretVaultOptions: options.fixtureSecretVaultOptions,
    paths: {
      colorsStorePath: path.join(runtimeDir, "colors", "colors.custom.json"),
      fixturesStorePath: path.join(runtimeDir, "fixtures", "fixtures.json"),
      fixtureSecretsVaultPath: path.join(runtimeDir, "fixtures", "fixtures.vault.json"),
      twitchConfigPath: path.join(runtimeDir, "twitch", "twitch.color.config.json")
    }
  });
  let twitchIntakeMode = "streamelements";
  const twitchIntakeGate = Object.freeze({
    getMode: () => twitchIntakeMode,
    setMode: value => {
      twitchIntakeMode = value === "native" ? "native" : "streamelements";
      return twitchIntakeMode;
    }
  });
  const hardwareOnboarding = createHardwareOnboardingService({ core });
  const widgetTokenVault = createWidgetIntakeTokenVault({
    vaultPath: path.join(runtimeDir, "system", "widget-intake.vault.json"),
    environmentToken: widgetIntakeToken,
    ...(options.widgetTokenVaultOptions || {})
  });
  const lifecycle = createLifecycleRegistry();
  const runtimeMetrics = createRuntimeMetricsService({
    ...(options.runtimeMetricsOptions || {}),
    ownedWork: () => lifecycle.snapshot()
  });
  lifecycle.register({ owner: "core", id: "runtime-metrics", type: "monitor", stop: runtimeMetrics.shutdown });
  lifecycle.register({ owner: "core", id: "egress-governor", type: "network", stop: egressGovernor.shutdown });
  lifecycle.register({ owner: "lighting.transports", id: "hue-wiz-adapters", type: "network", stop: core.shutdown });
  const widgetController = createSystemWidgetEventController({
    colorApply: async body => {
      const result = await core.colorCommandService.applyColorText(body?.text || body?.colorText || "", body || {});
      return { status: result.ok === false ? 400 : 200, body: result };
    },
    teachColor: async body => {
      const result = core.colorLibrary.teachColor(body?.name, body?.hex);
      return { status: result.ok === false ? 400 : 200, body: result };
    },
    submitSongRequest: async payload => {
      const registry = extension?.registry || extension?.features?.registry;
      if (!registry?.request) return { ok: false, error: "song_request_unavailable" };
      return registry.request("song-request", "song.queue.submit.v1", "submit", payload, { timeoutMs: 12000 });
    },
    settleRedemption: async payload => {
      const registry = extension?.registry || extension?.features?.registry;
      if (!registry?.request) return { ok: false, error: "twitch_settlement_unavailable" };
      const result = await registry.request("twitch-integration", "twitch.redemptions.v1", "settle", payload, { timeoutMs: 7000 });
      return result?.ok === true ? result.value : { ok: false, error: String(result?.error?.code || "twitch_settlement_unavailable") };
    },
    getTwitchIntakeMode: twitchIntakeGate.getMode
  });
  const widgetIntakeLimiter = createTokenBucket(options.widgetIntakeLimiterOptions);
  const app = express();
  installRequestSecurityMiddleware(app, {
    express,
    allowRemoteWrite: options.allowRemoteWrite === true,
    isWidgetCrossOriginEnabled: () => widgetTokenVault.getStatus().configured,
    widgetOrigins,
    port: Number(options.port || process.env.PORT || 5050)
  });
  app.use(runtimeMetrics.requestMiddleware());
  // Prevent stale widgets from posting an HTML 404 into chat. This compatibility
  // sink stays behind normal write security and never invokes retired behavior.
  app.post("/mods/music-request-engine/now_playing_announce", (_req, res) => {
    res.setHeader("Deprecation", "true");
    res.status(204).end();
  });
  app.use(express.static(path.join(rootDir, "public", "core")));
  let extension = null;
  registerLightingCoreRoutes(app, {
    core,
    widgetController,
    widgetIntakeLimiter,
    widgetTokenVault,
    widgetOrigins,
    runtimeMetrics,
    egressGovernor,
    hardwareOnboarding,
    capabilities: options.capabilities,
    getCapabilities: () => {
      const registry = extension?.registry || extension?.features?.registry;
      const features = registry?.list?.().features || [];
      return { songRequest: features.some(row => row.id === "song-request" && row.lifecycle === "active") };
    },
    profile,
    requestShutdown: options.requestShutdown
  });
  extension = typeof options.extend === "function"
    ? options.extend({ app, express, rootDir, runtimeDir, egressGovernor, widgetController, twitchIntakeGate })
    : null;
  if (typeof extension?.shutdown === "function") {
    lifecycle.register({ owner: extension.owner || "optional-platform", id: "extension", type: "capability", stop: extension.shutdown });
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(500).json({ ok: false, error: "internal_error" });
  });
  return {
    app,
    services: Object.freeze({ lightingCore: core, hardwareOnboarding, widgetController, widgetIntakeLimiter, widgetTokenVault, runtimeMetrics, egressGovernor, lifecycle }),
    extension,
    profile
  };
};
