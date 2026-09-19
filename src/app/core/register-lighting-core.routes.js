// [TITLE] Module: app/core/register-lighting-core.routes.js
// [TITLE] Purpose: minimal HTTP surface for the independent lighting core

const crypto = require("node:crypto");

function publicFixture(fixture = {}) {
  const storedRange = fixture.extras?.colorTemperatureMired;
  const brand = String(fixture.brand || "");
  const temperatureMinimum = brand === "hue" && Number(storedRange?.maximum) > 0
    ? Math.round(1000000 / Number(storedRange.maximum))
    : brand === "wiz" ? 2200 : 2000;
  const temperatureMaximum = brand === "hue" && Number(storedRange?.minimum) > 0
    ? Math.round(1000000 / Number(storedRange.minimum))
    : brand === "wiz" ? 6500 : 9000;
  return {
    id: String(fixture.id || ""),
    name: String(fixture.name || fixture.id || ""),
    brand,
    zone: String(fixture.zone || ""),
    enabled: fixture.enabled !== false,
    engineEnabled: fixture.engineEnabled === true,
    twitchEnabled: fixture.twitchEnabled === true,
    customEnabled: fixture.customEnabled === true,
    lightId: Number(fixture.lightId || 0),
    bridgeIpConfigured: Boolean(fixture.bridgeIp),
    deviceIpConfigured: Boolean(fixture.ip),
    entertainmentConfigured: Boolean(fixture.bridgeId || fixture.entertainmentAreaId),
    credentialsConfigured: Boolean(fixture.username || fixture.clientKey),
    temperatureRange: { minimumKelvin: temperatureMinimum, maximumKelvin: temperatureMaximum }
  };
}

function editableFixture(fixture = {}) {
  return {
    id: String(fixture.id || ""), name: String(fixture.name || fixture.id || ""), brand: String(fixture.brand || ""), zone: String(fixture.zone || ""),
    enabled: fixture.enabled !== false, engineEnabled: fixture.engineEnabled === true,
    twitchEnabled: fixture.twitchEnabled === true, customEnabled: fixture.customEnabled === true,
    bridgeIp: String(fixture.bridgeIp || ""), ip: String(fixture.ip || ""), lightId: Number(fixture.lightId || 0)
  };
}

function maskNetworkAddress(value) {
  const text = String(value || "").trim();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)) return `${text.split(".").slice(0, 2).join(".")}.x.x`;
  if (text.includes(":")) return `${text.split(":").slice(0, 2).join(":")}:*`;
  return text ? `${text.slice(0, 2)}...` : "hidden";
}

const diagnosticSecretKey = /(?:authorization|cookie|credential|password|secret|token|jwt|username|clientkey)/i;
const diagnosticNetworkKey = /(?:ip|host|url|address|bridgeid|deviceid)$/i;

function redactDiagnosticString(value) {
  return String(value || "")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, maskNetworkAddress)
    .replace(/\beyJ[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{8,}){1,2}\b/g, "[REDACTED TOKEN]")
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\b/gi, "[REDACTED]");
}

function publicDiagnostics(value, key = "", depth = 0) {
  if (diagnosticSecretKey.test(key) && !/(?:configured|present)$/i.test(key)) return "[REDACTED]";
  if (diagnosticNetworkKey.test(key) && typeof value === "string") return redactDiagnosticString(value);
  if (depth >= 7) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map(item => publicDiagnostics(item, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([childKey, child]) => [childKey, publicDiagnostics(child, childKey, depth + 1)]));
  }
  return typeof value === "string" ? redactDiagnosticString(value) : value;
}

function hasForeignOrigin(req = {}) {
  if (!req.headers?.origin) return false;
  try { return new URL(req.headers.origin).host !== req.headers.host; }
  catch { return true; }
}

const { readWidgetIntakeTokenFromRequest } = require("../../domains/system/widget-intake-token");
const { generateWidgetTemplate } = require("../../domains/system/widget-template.builder");
const { isLocalOrSameHostRequest } = require("../runtime/request-security.middleware");
const { DISPOSITIONS, validateWidgetEventRequest, withDisposition } = require("../../domains/system/widget-events-v2");

module.exports = function registerLightingCoreRoutes(app, options = {}) {
  const core = options.core;
  const widgetController = options.widgetController;
  const widgetIntakeLimiter = options.widgetIntakeLimiter;
  const widgetTokenVault = options.widgetTokenVault;
  const runtimeMetrics = options.runtimeMetrics;
  const egressGovernor = options.egressGovernor;
  const profile = String(options.profile || "clean-slate-core");
  const widgetOrigins = [...new Set((options.widgetOrigins || []).map(value => String(value || "").trim()).filter(Boolean))].slice(0, 8);
  const hardwareOnboarding = options.hardwareOnboarding;
  const coreUpdates = options.coreUpdates;
  if (!app || typeof app.get !== "function" || !core) {
    throw new Error("registerLightingCoreRoutes requires app and core");
  }

  const optionalCapabilities = options.capabilities && typeof options.capabilities === "object"
    ? options.capabilities
    : {};
  function capabilitySnapshot() {
    const dynamic = typeof options.getCapabilities === "function" ? options.getCapabilities() : {};
    return Object.freeze({
      lightingCore: true,
      colorParser: true,
      twitchColors: true,
      hue: true,
      wiz: true,
      govee: "alpha",
      widget: Boolean(widgetController),
      features: optionalCapabilities.features === true,
      mods: optionalCapabilities.mods === true,
      songRequest: dynamic?.songRequest === true
    });
  }

  function statusSnapshot() {
    const capabilities = capabilitySnapshot();
    const widgetTokenStatus = widgetTokenVault.getStatus();
    const fixtureVersion = core.fixtureRegistry.getRuntimeVersion();
    const payload = {
      ok: true,
      schemaVersion: 1,
      profile,
      capabilities,
      twitchLightRouting: core.twitchLightRouting.snapshot(),
      twitchLightEffects: core.twitchLightEffects.snapshot(),
      lightingLayout: core.lightingLayout.snapshot(),
      fixtures: {
        version: fixtureVersion,
        limits: core.fixtureRegistry.getLimits(),
        items: core.fixtureRegistry.getFixtures().map(publicFixture),
        connectivity: core.fixtureRegistry.getConnectivitySnapshot()
      },
      widgetSecurity: {
        contract: "widget.events.v2",
        ...widgetTokenStatus,
        scopedTokenConfigured: widgetTokenStatus.configured,
        crossOriginEnabled: Boolean(widgetTokenStatus.configured && widgetOrigins.length),
        allowedOrigins: widgetOrigins
      }
    };
    const revision = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
    return { ...payload, revision };
  }

  app.get("/health", (req, res) => res.json({ ok: true, version: coreUpdates?.status?.().currentVersion || "unknown", profile, capabilities: capabilitySnapshot() }));
  app.get("/system/update/status", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    res.setHeader("Cache-Control", "no-store");
    return res.json(coreUpdates?.status?.() || { ok: false, error: "updates_unavailable" });
  });
  app.post("/system/update/configure", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    return res.json(coreUpdates.configure(req.body || {}));
  });
  app.post("/system/update/check", async (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    try { return res.json(await coreUpdates.check()); } catch (error) { return next(error); }
  });
  app.post("/system/update/download", async (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    try { return res.json(await coreUpdates.download()); } catch (error) { return next(error); }
  });
  app.post("/system/update/apply", (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    try { return res.status(202).json(coreUpdates.apply()); } catch (error) { return next(error); }
  });
  app.post("/system/update/rollback", (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    try { return res.status(202).json(coreUpdates.rollback()); } catch (error) { return next(error); }
  });
  app.get("/system/capabilities", (req, res) => {
    res.json({ ok: true, profile, capabilities: capabilitySnapshot() });
  });
  app.get("/system/status", (req, res) => {
    const snapshot = statusSnapshot();
    const etag = `\"${snapshot.revision}\"`;
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("ETag", etag);
    if (String(req.headers?.["if-none-match"] || "") === etag) return res.status(304).end();
    return res.json(snapshot);
  });
  app.get("/system/diagnostics", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    res.setHeader("Cache-Control", "no-store");
    const snapshot = runtimeMetrics?.snapshot?.();
    const hueTelemetry = core.hueBridge?.getTelemetry?.() || {};
    const hueEntertainment = hueTelemetry.entertainmentRuntime || {};
    const wizTelemetry = core.wizBridge?.getTelemetry?.() || {};
    const goveeTelemetry = core.goveeBridge?.getTelemetry?.() || {};
    return res.json(publicDiagnostics(snapshot
      ? { ...snapshot, domains: {
        widget: widgetController?.getDiagnostics?.() || null,
        widgetIntake: widgetIntakeLimiter?.getDiagnostics?.() || null,
        egress: egressGovernor?.getDiagnostics?.() || null,
        hardwareOnboarding: hardwareOnboarding?.getDiagnostics?.() || null,
        lightingTransports: {
          owner: "lighting.transports",
          hue: hueTelemetry.resources || null,
          hueEntertainment: {
            available: hueEntertainment.available === true,
            crossFetchEnabled: hueEntertainment.crossFetchEnabled === true,
            caTrustInstalled: hueEntertainment.caTrust?.installed === true,
            dnsOverrideCount: Number(hueEntertainment.dnsOverrideCount || 0),
            maximumDnsOverrides: Number(hueEntertainment.maximumDnsOverrides || 0),
            dnsOverrideEvictions: Number(hueEntertainment.dnsOverrideEvictions || 0),
            activeSessions: Number(hueEntertainment.activeSessions || 0)
          },
          wiz: wizTelemetry.resources || null,
          goveeAlpha: goveeTelemetry
        }
      } }
      : { ok: false, error: "diagnostics_unavailable" }));
  });
  app.get("/colors", (req, res) => {
    res.json({ ok: true, colors: core.colorLibrary.getColorMapSnapshot() });
  });
  app.post("/teach", (req, res) => {
    const result = core.colorLibrary.teachColor(req.body?.name, req.body?.hex);
    res.status(result.ok === false ? 400 : 200).json(result);
  });
  app.post("/color", async (req, res, next) => {
    try {
      const group = req.body?.groupId ? core.twitchLightRouting.resolveGroup(req.body.groupId) : null;
      if (req.body?.groupId && !group) return res.status(400).json({ ok: false, error: 'fixture_group_not_found' });
      if (group && ['fixtureId', 'fixtureIds', 'target', 'zone', 'hueZone', 'wizZone', 'goveeZone'].some(key => req.body[key] !== undefined)) return res.status(400).json({ ok: false, error: 'ambiguous_light_group_target' });
      const result = await core.colorCommandService.applyColorText(req.body?.text, {
        target: group ? 'both' : req.body?.target,
        targetExplicit: Boolean(group || req.body?.target),
        fixtureId: req.body?.fixtureId,
        fixtureIds: group ? group.fixtureIds : req.body?.fixtureIds,
        mode: "direct",
        zone: req.body?.zone,
        hueZone: req.body?.hueZone,
        wizZone: req.body?.wizZone,
        goveeZone: req.body?.goveeZone
      });
      res.status(result.ok === false ? 400 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });
  app.get("/lighting-profiles", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(core.lightingProfiles.snapshot());
  });
  app.get("/lighting-layout", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(core.lightingLayout.snapshot());
  });
  app.post("/lighting-layout", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    if (hasForeignOrigin(req)) return res.status(403).json({ ok: false, error: "same_origin_required" });
    const result = core.lightingLayout.save(req.body || {});
    res.status(result.ok ? 200 : result.error === "lighting_layout_conflict" ? 409 : 400).json(result);
  });
  app.get("/lighting-lab", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    if (hasForeignOrigin(req)) return res.status(403).json({ ok: false, error: "same_origin_required" });
    res.setHeader("Cache-Control", "no-store");
    const fixtures = core.fixtureRegistry.getFixtures().map(publicFixture);
    const connectivity = new Map(core.fixtureRegistry.getConnectivitySnapshot().rows.map(row => [row.id, row]));
    const settings = core.lightingLab.snapshot();
    const capabilities = fixtures.map(row => ({ id: row.id, name: row.name, brand: row.brand, enabled: row.enabled,
      connectivity: connectivity.get(row.id)?.status || "unknown", latencyOffsetMs: Number(settings.latencyOffsets?.[row.id] || 0),
      excluded: settings.excludedFixtureIds.includes(row.id), rgb: ["hue", "wiz", "govee"].includes(row.brand),
      tunableWhite: ["hue", "wiz"].includes(row.brand), spatial: Boolean(core.lightingLayout.placement(row.id)),
      segments: false, segmentReason: row.brand === "hue" ? "Hue API v2 Gradient transport required" : row.brand === "govee" ? "Govee cloud segment capability required" : "No independent segment transport" }));
    res.json({ ...settings, capabilities });
  });
  app.post("/lighting-lab", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    if (hasForeignOrigin(req)) return res.status(403).json({ ok: false, error: "same_origin_required" });
    const result = core.lightingLab.save(req.body || {});
    res.status(result.ok ? 200 : result.error === "lighting_lab_conflict" ? 409 : 400).json(result);
  });
  app.delete("/lighting-lab/history", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    if (hasForeignOrigin(req)) return res.status(403).json({ ok: false, error: "same_origin_required" });
    res.json(core.lightingLab.clearHistory());
  });
  app.post("/lighting-profiles", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    const result = core.lightingProfiles.save(req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  });
  app.delete("/lighting-profiles/:id", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    const result = core.lightingProfiles.remove(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  });
  app.post("/lighting-profiles/default/apply", async (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    try {
      const result = await core.lightingProfiles.applyDefault();
      res.status(result.ok ? 200 : 409).json(result);
    } catch (error) { next(error); }
  });
  app.post("/lighting-profiles/:id/apply", async (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    try {
      const result = await core.lightingProfiles.apply(req.params.id);
      res.status(result.ok ? 200 : result.error === "lighting_profile_not_found" ? 404 : 409).json(result);
    } catch (error) { next(error); }
  });
  app.get('/twitch/lights', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const result = core.twitchLightRouting.snapshot();
    res.status(result.ok ? 200 : 503).json(result);
  });
  app.post('/twitch/lights', (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: 'local_request_required' });
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) throw new Error(); }
      catch { return res.status(403).json({ ok: false, error: 'same_origin_required' }); }
    }
    res.setHeader('Cache-Control', 'no-store');
    const result = core.twitchLightRouting.save(req.body || {});
    res.status(result.ok ? 200 : result.error === 'twitch_routing_conflict' ? 409 : 400).json(result);
  });
  app.post('/twitch/lights/preview', async (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: 'local_request_required' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await core.colorCommandService.applyColorText(req.body?.text, { preview: true });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (error) { next(error); }
  });
  app.post('/twitch/lights/test', async (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: 'local_request_required' });
    if (hasForeignOrigin(req)) return res.status(403).json({ ok: false, error: 'same_origin_required' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await core.colorCommandService.applyColorText(req.body?.text);
      res.status(result.ok ? 200 : 400).json(result);
    } catch (error) { next(error); }
  });
  app.get('/twitch/light-effects', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const result = core.twitchLightEffects.snapshot();
    res.status(result.ok ? 200 : 503).json(result);
  });
  app.post('/twitch/light-effects', (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: 'local_request_required' });
    if (hasForeignOrigin(req)) return res.status(403).json({ ok: false, error: 'same_origin_required' });
    res.setHeader('Cache-Control', 'no-store');
    const result = core.twitchLightEffects.save(req.body || {});
    res.status(result.ok ? 200 : result.error === 'twitch_effects_conflict' ? 409 : 400).json(result);
  });
  app.get("/fixtures", (req, res) => {
    res.json({
      ok: true,
      version: core.fixtureRegistry.getRuntimeVersion(),
      fixtures: core.fixtureRegistry.getFixtures().map(publicFixture),
      connectivity: core.fixtureRegistry.getConnectivitySnapshot()
    });
  });
  app.get("/fixtures/:id/edit", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    const fixture = core.fixtureRegistry.getFixtures().find(row => String(row.id) === String(req.params.id));
    if (!fixture) return res.status(404).json({ ok: false, error: "fixture_not_found" });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, fixture: editableFixture(fixture), oneTimeReveal: true });
  });
  app.post("/fixtures", (req, res) => {
    const result = core.fixtureRegistry.upsertFixture(req.body || {});
    res.status(result.ok === false ? 400 : 200).json(
      result.ok === true ? { ...result, fixture: publicFixture(result.fixture) } : result
    );
  });
  app.delete("/fixtures/:id", (req, res) => {
    const result = core.fixtureRegistry.deleteFixture(req.params.id);
    res.status(result.ok === false ? 404 : 200).json(result);
  });
  app.post("/fixtures/:id/test", async (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    try {
      res.setHeader("Cache-Control", "no-store");
      const result = await hardwareOnboarding.testFixture(req.params.id, req.body || {});
      return res.status(result.ok === false ? 503 : 200).json(result);
    } catch (error) { return next(error); }
  });
  app.get("/hue/discover", async (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    if (hasForeignOrigin(req)) return res.status(403).json({ ok: false, error: "same_origin_required" });
    try {
      const result = await hardwareOnboarding.discover("hue", { timeoutMs: req.query?.timeoutMs });
      res.setHeader("Cache-Control", "no-store");
      return res.status(result.ok === false ? 503 : 200).json(result.ok === false
        ? { ok: false, error: String(result.error || "hue_discovery_failed"), targets: [] }
        : { ok: true, kind: "hue", count: result.bridges.length, targets: hardwareOnboarding.recordDiscovery("hue", result.bridges) });
    } catch (error) { return next(error); }
  });
  app.post("/hue/pair", async (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    try {
      const result = await hardwareOnboarding.pairHue(req.body || {});
      res.setHeader("Cache-Control", "no-store");
      const status = result.ok ? 200 : result.error === "link_button_timeout" ? 408 : result.error === "hue_pairing_in_progress" ? 409 : 400;
      res.status(status).json(result);
    } catch (error) { next(error); }
  });
  app.post("/hue/pair/prepare", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    res.setHeader("Cache-Control", "no-store");
    const result = hardwareOnboarding.prepareHue(req.body || {});
    return res.status(result.ok ? 200 : 400).json(result);
  });
  app.post("/hue/onboarding/commit", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    res.setHeader("Cache-Control", "no-store");
    const result = hardwareOnboarding.commitHue(req.body || {});
    return res.status(result.ok === false ? 400 : 200).json(result);
  });
  app.get("/wiz/discover", async (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    if (hasForeignOrigin(req)) return res.status(403).json({ ok: false, error: "same_origin_required" });
    try {
      const result = await hardwareOnboarding.discover("wiz", { timeoutMs: req.query?.timeoutMs });
      res.setHeader("Cache-Control", "no-store");
      return res.status(result.ok === false ? 503 : 200).json(result.ok === false
        ? { ok: false, error: String(result.error || "wiz_discovery_failed"), targets: [] }
        : { ok: true, kind: "wiz", count: result.devices.length, targets: hardwareOnboarding.recordDiscovery("wiz", result.devices) });
    } catch (error) { return next(error); }
  });
  app.post("/wiz/onboarding/commit", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    res.setHeader("Cache-Control", "no-store");
    const result = hardwareOnboarding.commitWiz(req.body || {});
    return res.status(result.ok === false ? 400 : 200).json(result);
  });
  app.get("/govee/discover", async (req, res, next) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    if (hasForeignOrigin(req)) return res.status(403).json({ ok: false, error: "same_origin_required" });
    try {
      const result = await hardwareOnboarding.discover("govee", { timeoutMs: req.query?.timeoutMs });
      res.setHeader("Cache-Control", "no-store");
      return res.status(result.ok === false ? 503 : 200).json(result.ok === false
        ? { ok: false, error: String(result.error || "govee_discovery_failed"), targets: [], alpha: true }
        : { ok: true, kind: "govee", alpha: true, count: result.devices.length, targets: hardwareOnboarding.recordDiscovery("govee", result.devices) });
    } catch (error) { return next(error); }
  });
  app.post("/govee/onboarding/commit", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    res.setHeader("Cache-Control", "no-store");
    const result = hardwareOnboarding.commitGovee(req.body || {});
    return res.status(result.ok === false ? 400 : 200).json(result);
  });
  app.post("/hardware/discovery/select", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    const result = hardwareOnboarding.selectDiscovery(req.body?.selectionToken);
    if (!result.ok) return res.status(404).json(result);
    res.setHeader("Cache-Control", "no-store");
    return res.json(result);
  });
  app.post("/system/widget-template-get", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    res.setHeader("Cache-Control", "no-store");
    if (!widgetTokenVault.verify(req.body?.widgetIntakeToken).ok) {
      return res.status(401).json({ ok: false, error: "widget_intake_token_invalid" });
    }
    const admission = widgetIntakeLimiter?.take("widget-template", 5);
    if (admission?.ok === false) {
      res.setHeader("Retry-After", String(admission.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: "widget_template_rate_limited" });
    }
    return res.json(generateWidgetTemplate(req.body || {}));
  });
  app.post("/system/widget-template-rebuild", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    res.setHeader("Cache-Control", "no-store");
    const rotated = widgetTokenVault.rotate();
    if (!rotated.ok) return res.status(rotated.status || 500).json(rotated);
    const generated = generateWidgetTemplate({ ...(req.body || {}), widgetIntakeToken: rotated.token });
    return res.json({ ...generated, oneTimeReveal: true, widgetSecurity: rotated.widgetSecurity });
  });
  app.post("/system/widget-token/rotate", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    const result = widgetTokenVault.rotate();
    res.setHeader("Cache-Control", "no-store");
    return res.status(result.status || (result.ok ? 200 : 500)).json(result);
  });
  app.post("/system/widget-token/clear", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    const result = widgetTokenVault.clear();
    res.setHeader("Cache-Control", "no-store");
    return res.status(result.status || (result.ok ? 200 : 500)).json(result);
  });
  app.post("/widget/events", async (req, res, next) => {
    try {
      const received = readWidgetIntakeTokenFromRequest(req, req.body || {});
      const authorization = widgetTokenVault.verify(received);
      if (!authorization.ok) {
        widgetController.recordRejected?.("unauthorized");
        return res.status(401).json({ ok: false, contract: "widget.events.v2", disposition: DISPOSITIONS.REJECTED, error: "widget_intake_unauthorized" });
      }
      const admission = widgetIntakeLimiter?.take(authorization.required ? "authenticated" : "local-unscoped");
      if (admission?.ok === false) {
        widgetController.recordRejected?.("rate_limited");
        res.setHeader("Retry-After", String(admission.retryAfterSeconds));
        return res.status(429).json({ ok: false, contract: "widget.events.v2", disposition: DISPOSITIONS.RATE_LIMITED, error: "widget_intake_rate_limited" });
      }
      const validation = validateWidgetEventRequest(req.body || {});
      if (!validation.ok) {
        widgetController.recordRejected?.("invalid");
        return res.status(400).json({ ok: false, contract: "widget.events.v2", disposition: DISPOSITIONS.REJECTED, error: validation.error });
      }
      if (validation.value.target && validation.value.target !== "core") {
        return res.status(503).json({
          ok: false,
          handled: false,
          contract: "widget.events.v2",
          disposition: DISPOSITIONS.DEGRADED,
          error: "widget_target_unavailable",
          target: validation.value.target
        });
      }
      const result = await widgetController.handleWidgetEvent(validation.value);
      res.status(result.status || 200).json(withDisposition(result.body || result));
    } catch (error) { next(error); }
  });
  app.post("/system/stop", (req, res) => {
    if (!isLocalOrSameHostRequest(req)) return res.status(403).json({ ok: false, error: "local_request_required" });
    if (typeof options.requestShutdown !== "function") return res.status(503).json({ ok: false, error: "shutdown_unavailable" });
    res.status(202).json({ ok: true, stopping: true });
    setImmediate(() => options.requestShutdown("http"));
  });
};

module.exports.publicFixture = publicFixture;
module.exports.publicDiagnostics = publicDiagnostics;
