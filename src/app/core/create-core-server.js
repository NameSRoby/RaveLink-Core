/**
 * Server composition and HTTP ownership.
 * Construct services before registering their routes, then attach only the requested
 * optional extension. The returned services/lifecycle are also used by tests without
 * listening on a port. Keep core startup independent of installed feature state;
 * side effects that need shutdown must register an owner with the lifecycle.
 */
// [TITLE] Module: app/core/create-core-server.js
// [TITLE] Purpose: independently bootable clean-slate lighting HTTP server

const path = require("node:path");
const express = require("express");
const axios = require("axios");
const createLightingCore = require("./create-lighting-core");
const registerLightingCoreRoutes = require("./register-lighting-core.routes");
const registerPresentationRoutes = require("./register-presentation.routes");
const { errorHandler: clientApiErrors } = require("./register-client-api.routes");
const { installRequestSecurityMiddleware } = require("../runtime/request-security.middleware");
const {
  createSystemWidgetEventController,
} = require("../../domains/system/widget-event.controller");
const createRuntimeMetricsService = require("../../domains/system/runtime-metrics.service");
const createLifecycleRegistry = require("../../domains/system/lifecycle-registry");
const createTokenBucket = require("../runtime/token-bucket");
const { createWidgetIntakeTokenVault } = require("../../domains/system/widget-intake-token-vault");
const createEgressGovernor = require("../runtime/egress-governor");
const createHardwareOnboardingService = require("../../domains/fixtures/hardware-onboarding.service");
const { createCoreUpdateService } = require("../../domains/system/core-update.service");
const createTaughtColorPreviewService = require("../../domains/colors/taught-color-preview.service");
const createMusicToLightService = require("../../domains/music-to-light/music-to-light.service");

module.exports = function createCoreServer(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "../../.."));
  const runtimeDir = path.resolve(options.runtimeDir || path.join(rootDir, "runtime"));
  const widgetIntakeToken = String(
    options.widgetIntakeToken ?? process.env.RAVELINK_WIDGET_INTAKE_TOKEN ?? "",
  ).trim();
  const widgetOrigins = Array.isArray(options.widgetOrigins)
    ? options.widgetOrigins
    : String(process.env.RAVELINK_WIDGET_ALLOWED_ORIGINS || "https://streamelements.com").split(
        ",",
      );
  const egressGovernor = createEgressGovernor(options.egressGovernorOptions);
  const profile =
    options.profile ||
    (options.capabilities?.mods && options.capabilities?.features
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
      twitchConfigPath: path.join(runtimeDir, "twitch", "twitch.color.config.json"),
    },
  });
  let twitchIntakeMode = "streamelements";
  const twitchIntakeGate = Object.freeze({
    getMode: () => twitchIntakeMode,
    setMode: (value) => {
      twitchIntakeMode = value === "native" ? "native" : "streamelements";
      return twitchIntakeMode;
    },
  });
  const hardwareOnboarding = createHardwareOnboardingService({ core });
  const coreUpdates = createCoreUpdateService({
    rootDir,
    runtimeDir,
    requestShutdown: options.requestShutdown,
    ...(options.coreUpdateOptions || {}),
  });
  const widgetTokenVault = createWidgetIntakeTokenVault({
    vaultPath: path.join(runtimeDir, "system", "widget-intake.vault.json"),
    environmentToken: widgetIntakeToken,
    ...(options.widgetTokenVaultOptions || {}),
  });
  const lifecycle = createLifecycleRegistry();
  let extension = null;
  const musicToLight = createMusicToLightService({
    installed: !require("node:fs").existsSync(
      path.join(rootDir, "config", "music-to-light.disabled"),
    ),
    core,
    controllerOptions: options.musicControllerOptions,
    designPath: path.join(runtimeDir, "music-to-light", "design.json"),
    operatorPath: path.join(runtimeDir, "music-to-light", "operator.json"),
    readPlayback: async () => {
      const registry = extension?.registry || extension?.features?.registry;
      if (
        !registry
          ?.list()
          .features.some((row) => row.id === "song-request" && row.lifecycle === "active")
      )
        return null;
      const result = await registry.request(
        "song-request",
        "song.playback.read.v1",
        "status",
        null,
        { timeoutMs: 750 },
      );
      return result?.ok ? result.value : null;
    },
  });
  const runtimeMetrics = createRuntimeMetricsService({
    ...(options.runtimeMetricsOptions || {}),
    ownedWork: () => lifecycle.snapshot(),
  });
  lifecycle.register({
    owner: "core",
    id: "runtime-metrics",
    type: "monitor",
    stop: runtimeMetrics.shutdown,
  });
  lifecycle.register({
    owner: "core",
    id: "egress-governor",
    type: "network",
    stop: egressGovernor.shutdown,
  });
  lifecycle.register({
    owner: "lighting.transports",
    id: "hue-wiz-adapters",
    type: "network",
    stop: core.shutdown,
  });
  const taughtColorPreview = createTaughtColorPreviewService({
    outputOwnership: core.fixtureOutput.ownership,
    directiveService: core.directiveService,
    colorCommandService: core.colorCommandService,
    fixtureRegistry: core.fixtureRegistry,
    lightingLab: core.lightingLab,
    hueBridge: core.hueBridge,
    wizBridge: core.wizBridge,
    goveeBridge: core.goveeBridge,
  });
  lifecycle.register({
    owner: "core",
    id: "taught-color-preview",
    type: "timer",
    stop: taughtColorPreview.shutdown,
  });
  lifecycle.register({
    owner: "core",
    id: "music-to-light",
    type: "audio",
    stop: musicToLight.shutdown,
  });
  core.twitchLightEffects.setMusicHandler({
    start: musicToLight.rave,
    check: musicToLight.checkRave,
    stop: musicToLight.stopRave,
    ids: musicToLight.raveIds,
    routedIds: musicToLight.raveRouteIds,
    save: musicToLight.viewerSave,
  });
  const widgetController = createSystemWidgetEventController({
    colorApply: async (body) => {
      const result = await core.colorCommandService.applyColorText(
        body?.text || body?.colorText || "",
        body || {},
      );
      return { status: result.ok === false ? 400 : 200, body: result };
    },
    teachColor: async (body) => {
      const result = core.colorLibrary.teachColor(
        body?.text || body?.userInput || [body?.name, body?.hex].filter(Boolean).join(" "),
      );
      return { status: result.ok === false ? 400 : 200, body: result };
    },
    previewTaughtColor: (hex) => taughtColorPreview.preview(hex),
    getTeachSettings: () => core.twitchLightRouting.snapshot().teaching,
    sendChat: async (payload) => {
      const registry = extension?.registry || extension?.features?.registry;
      if (!registry?.request) return { ok: false, error: "twitch_chat_unavailable" };
      const result = await registry.request(
        "twitch-integration",
        "twitch.chat.send.v1",
        "send",
        payload,
        { timeoutMs: 5000 },
      );
      return result?.ok === true
        ? result.value
        : {
            ok: false,
            error: String(result?.error?.code || "twitch_chat_unavailable"),
          };
    },
    submitSongRequest: async (payload) => {
      const registry = extension?.registry || extension?.features?.registry;
      if (!registry?.request) return { ok: false, error: "song_request_unavailable" };
      if (
        payload.rewardRedemption === true &&
        require("../../capabilities/feature-platform/packages/feature-package-manager").compareVersions(
          registry.list().features.find((row) => row.id === "song-request")?.version || "0.0.0",
          "0.45.4",
        ) < 0
      )
        return { status: 409, body: { ok: false, error: "song_request_update_required" } };
      return registry.request("song-request", "song.queue.submit.v1", "submit", payload, {
        timeoutMs: 30000,
      });
    },
    settleRedemption: async (payload) => {
      const registry = extension?.registry || extension?.features?.registry;
      if (!registry?.request) return { ok: false, error: "twitch_settlement_unavailable" };
      const result = await registry.request(
        "twitch-integration",
        "twitch.redemptions.v1",
        "settle",
        payload,
        { timeoutMs: 7000 },
      );
      return result?.ok === true
        ? result.value
        : {
            ok: false,
            error: String(result?.error?.code || "twitch_settlement_unavailable"),
          };
    },
    getTwitchIntakeMode: twitchIntakeGate.getMode,
  });
  const widgetIntakeLimiter = createTokenBucket(options.widgetIntakeLimiterOptions);
  const app = express();
  installRequestSecurityMiddleware(app, {
    express,
    allowRemoteWrite: options.allowRemoteWrite === true,
    isWidgetCrossOriginEnabled: () => widgetTokenVault.getStatus().configured,
    widgetOrigins,
    port: Number(options.port || process.env.PORT || 5050),
  });
  app.use(runtimeMetrics.requestMiddleware());
  registerPresentationRoutes(app, { runtimeDir });
  require("./register-music-to-light.routes")(app, { host: musicToLight });
  require("./register-navigation.routes")(app, { runtimeDir });
  require("./register-dashboard-layout.routes")(app, { runtimeDir });
  require("./register-dashboard.routes")(app, {
    core,
    music: musicToLight,
    getRegistry: () => extension?.registry || extension?.features?.registry,
  });
  // Prevent stale widgets from posting an HTML 404 into chat. This compatibility
  // sink stays behind normal write security and never invokes retired behavior.
  app.post("/mods/music-request-engine/now_playing_announce", (_req, res) => {
    res.setHeader("Deprecation", "true");
    res.status(204).end();
  });
  app.use(express.static(path.join(rootDir, "public", "core")));
  registerLightingCoreRoutes(app, {
    core,
    widgetController,
    widgetIntakeLimiter,
    widgetTokenVault,
    widgetOrigins,
    runtimeMetrics,
    egressGovernor,
    hardwareOnboarding,
    coreUpdates,
    capabilities: options.capabilities,
    getCapabilities: () => {
      const registry = extension?.registry || extension?.features?.registry;
      const features = registry?.list?.().features || [];
      return {
        songRequest: features.some(
          (row) => row.id === "song-request" && row.lifecycle === "active",
        ),
      };
    },
    profile,
    requestShutdown: options.requestShutdown,
  });
  extension =
    typeof options.extend === "function"
      ? options.extend({
          app,
          express,
          rootDir,
          runtimeDir,
          egressGovernor,
          widgetController,
          twitchIntakeGate,
          lightingCore: core,
        })
      : null;
  coreUpdates.startLaunchCheck();
  if (typeof extension?.shutdown === "function") {
    lifecycle.register({
      owner: extension.owner || "optional-platform",
      id: "extension",
      type: "capability",
      stop: extension.shutdown,
    });
  }
  app.use(clientApiErrors);
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(500).json({ ok: false, error: "internal_error" });
  });
  return {
    app,
    services: Object.freeze({
      lightingCore: core,
      musicToLight,
      hardwareOnboarding,
      coreUpdates,
      widgetController,
      widgetIntakeLimiter,
      widgetTokenVault,
      runtimeMetrics,
      egressGovernor,
      lifecycle,
    }),
    extension,
    profile,
  };
};
