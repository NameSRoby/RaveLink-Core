const path = require("node:path");
const crypto = require("node:crypto");
const createFeatureHostRegistry = require("../../capabilities/feature-platform/host/feature-host-registry");
const registerFeaturePlatformRoutes = require("../../capabilities/feature-platform/http/register-feature-platform.routes");
const createWindowsMediaObserver = require("../../capabilities/feature-platform/providers/windows-media-observer");
const createTwitchChatCommandRouter = require("../../capabilities/feature-platform/providers/twitch-chat-command-router");
const { TWITCH_PUBLIC_CLIENT_ID } = require("../../capabilities/feature-platform/providers/twitch-public-client");
const { OFFICIAL_FEATURE_SOURCES } = require("../../capabilities/feature-platform/packages/official-feature-sources");
const { OFFICIAL_TTS_PAYLOADS } = require("../../capabilities/feature-platform/packages/official-tts-payloads");
const createTtsPayloadManager = require("../../capabilities/feature-platform/packages/tts-payload-manager");
const { hexToRgb, createHueStateFromRgb, createWizStateFromRgb } = require("../../domains/colors/color-space");

function providerError(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function twitchEventAmount(type, event = {}) {
  const field = { "channel.subscription.gift": "total", "channel.cheer": "bits", "channel.raid": "viewers" }[type];
  const value = type === "channel.follow" ? 1 : field ? Number(event[field]) : NaN;
  return Number.isFinite(value) ? Math.max(0, Math.min(1000000, Math.round(value))) : undefined;
}

function createTtsPackageProvider(registry, sources = OFFICIAL_FEATURE_SOURCES, payloadManager = null) {
  const allowed = new Set(sources.map(row => row.id).filter(id => /^tts-[a-z0-9-]{1,58}$/.test(id)));
  const project = row => ({
    id: String(row.id), name: String(row.name || row.id).slice(0, 80), version: String(row.version || "").slice(0, 40),
    description: String(row.description || "").slice(0, 500), installed: row.installed === true,
    installedVersion: String(row.installedVersion || "").slice(0, 40), updateAvailable: row.updateAvailable === true,
    bytes: Math.max(0, Math.min(2147483648, Math.round(Number(row.bytes) || 0))), source: "github", downloadRequired: true
  });
  function admit(payload) {
    const id = String(payload?.featureId || "");
    if (allowed.has(id)) return { id, kind: "feature" };
    if (/^tts-(?:runtime|voice)-[a-z0-9-]{1,52}$/.test(id) && payloadManager) return { id, kind: "payload" };
    throw providerError("tts_package_not_allowed", "The requested TTS package is not in the official RaveLink catalog");
  }
  return Object.freeze({
    async status() {
      const result = await registry.listAvailable();
      const payloads = payloadManager ? await payloadManager.status() : { packages: [] };
      const featureRows = (result.features || []).filter(row => allowed.has(row.id)).map(project);
      const payloadRows = (payloads.packages || []).map(project);
      return { ok: true, packages: [...featureRows, ...payloadRows].slice(0, 16), warnings: (result.warnings || []).filter(row => allowed.has(row.featureId)).length };
    },
    async install(payload) {
      const admitted = admit(payload), featureId = admitted.id;
      const result = admitted.kind === "payload" ? await payloadManager.install(featureId) : await registry.install(featureId);
      return { ok: result?.ok === true, featureId, code: result?.ok ? "tts_package_installed" : String(result?.error || "tts_package_install_failed").slice(0, 80) };
    },
    async update(payload) {
      const admitted = admit(payload), featureId = admitted.id;
      const result = admitted.kind === "payload" ? await payloadManager.install(featureId) : await registry.update(featureId);
      return { ok: result?.ok === true, featureId, code: result?.ok ? "tts_package_updated" : String(result?.error || "tts_package_update_failed").slice(0, 80) };
    },
    async remove(payload) {
      const admitted = admit(payload), featureId = admitted.id;
      const result = admitted.kind === "payload" ? await payloadManager.remove(featureId) : await registry.uninstall(featureId, { deleteData: payload?.deleteData === true });
      return { ok: result?.ok === true, featureId, code: result?.ok ? "tts_package_removed" : String(result?.error || "tts_package_remove_failed").slice(0, 80) };
    }
  });
}

function createLightingOutputProvider(context = {}) {
  const captures = new Map();
  const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
  function fixtureIds(raw) {
    return Array.isArray(raw) ? [...new Set(raw.map(value => String(value || "").trim()).filter(value => idPattern.test(value)))].slice(0, 64) : [];
  }
  function colorOptions(payload, preview = false) {
    const selected = fixtureIds(payload?.fixtureIds);
    return selected.length ? { fixtureIds: selected, target: "both", targetExplicit: true, mode: "direct", ...(preview ? { preview: true } : {}) }
      : { mode: "direct", ...(preview ? { preview: true } : {}) };
  }
  function pruneCaptures(now = Date.now()) {
    for (const [id, row] of captures) if (row.expiresAt <= now) captures.delete(id);
    while (captures.size >= 16) captures.delete(captures.keys().next().value);
  }
  function normalizedState(raw = {}) {
    const brightness = Math.round(Number(raw.brightness));
    if (!Number.isFinite(brightness) || brightness < 1 || brightness > 100) throw providerError("lighting_state_invalid", "Lighting brightness is invalid");
    if (raw.mode === "rgb") {
      const rgb = hexToRgb(raw.color);
      if (!rgb) throw providerError("lighting_state_invalid", "Lighting RGB color is invalid");
      return { mode: "rgb", rgb, brightness };
    }
    if (raw.mode === "white") {
      const kelvin = Math.round(Number(raw.kelvin));
      if (!Number.isFinite(kelvin) || kelvin < 2200 || kelvin > 6500) throw providerError("lighting_state_invalid", "Lighting white temperature is invalid");
      return { mode: "white", kelvin, brightness };
    }
    throw providerError("lighting_state_invalid", "Lighting state mode is invalid");
  }
  function advanceCapture(captureId, callOptions, lighting, targetIds) {
    if (!captureId) return;
    const captured = captures.get(String(captureId));
    if (!captured || captured.owner !== String(callOptions?.featureId || "")) throw providerError("lighting_capture_not_found", "Lighting capture is unavailable");
    const targets = new Set(targetIds);
    for (const row of captured.states) {
      if (!targets.has(row.fixtureId)) continue;
      row.expectedGeneration = Number(lighting.lightingLab.previousState(row.fixtureId)?.generation || row.expectedGeneration || 0);
    }
  }
  function captureEligibleTargets(captureId, callOptions, lighting, targetIds) {
    if (!captureId) return { eligible: [...targetIds], superseded: [] };
    const captured = captures.get(String(captureId));
    if (!captured || captured.owner !== String(callOptions?.featureId || "")) throw providerError("lighting_capture_not_found", "Lighting capture is unavailable");
    const rows = new Map(captured.states.map(row => [row.fixtureId, row]));
    const eligible = [], superseded = [];
    for (const id of targetIds) {
      const row = rows.get(id);
      const current = Number(lighting.lightingLab.previousState(id)?.generation || 0);
      if (row && current === Number(row.expectedGeneration || 0)) eligible.push(id);
      else superseded.push(id);
    }
    return { eligible, superseded };
  }
  async function resolveTargets(lighting, operation) {
    if (operation.action === "color") {
      const command = String(operation.command || "").trim();
      if (!command || command.length > 160) throw providerError("lighting_command_invalid", "Lighting command is invalid");
      const preview = await lighting.colorCommandService.applyColorText(command, colorOptions(operation, true));
      if (!preview?.ok) throw providerError(String(preview?.error || "lighting_target_unavailable"), "Lighting targets could not be resolved");
      return fixtureIds(preview.targets);
    }
    if (operation.action === "profile") {
      const profileId = String(operation.profileId || "").trim();
      if (!idPattern.test(profileId)) throw providerError("lighting_profile_invalid", "Lighting profile is invalid");
      const profile = lighting.lightingProfiles.snapshot().profiles.find(row => row.id === profileId);
      if (!profile) throw providerError("lighting_profile_not_found", "Lighting profile was not found");
      const available = new Set(lighting.fixtureRegistry.listEngineBy("", "all").map(row => row.id));
      return fixtureIds(Object.keys(profile.fixtureTargets || {})).filter(id => available.has(id));
    }
    if (operation.action === "state") {
      const selected = fixtureIds(operation.fixtureIds);
      if (!selected.length) throw providerError("lighting_target_unavailable", "No lighting fixtures were selected");
      const available = new Set(lighting.fixtureRegistry.listEngineBy("", "all").map(row => row.id));
      return selected.filter(id => available.has(id));
    }
    throw providerError("lighting_action_invalid", "Unsupported lighting action");
  }
  async function capture(lighting, payload, callOptions) {
    const actions = Array.isArray(payload.actions) ? payload.actions.slice(0, 4) : [];
    if (!actions.length) throw providerError("lighting_capture_empty", "No lighting actions were provided");
    const targets = new Set();
    for (const operation of actions) for (const id of await resolveTargets(lighting, operation)) targets.add(id);
    if (!targets.size) throw providerError("lighting_capture_empty", "No lighting fixtures were resolved");
    const states = [...targets].map(id => {
      const previous = lighting.lightingLab.previousState(id);
      return { fixtureId: id, previous, expectedGeneration: Number(previous?.generation || 0) };
    });
    pruneCaptures();
    const captureId = crypto.randomUUID();
    captures.set(captureId, { owner: String(callOptions?.featureId || ""), expiresAt: Date.now() + 10 * 60 * 1000, states });
    const captured = states.filter(row => row.previous?.value).length;
    return { ok: true, captureId, captured, unavailable: states.length - captured, expiresInMs: 10 * 60 * 1000 };
  }
  async function restore(lighting, payload, callOptions) {
    pruneCaptures();
    const captureId = String(payload.captureId || "");
    const captured = captures.get(captureId);
    if (!captured || captured.owner !== String(callOptions?.featureId || "")) throw providerError("lighting_capture_not_found", "Lighting capture is unavailable");
    captures.delete(captureId);
    const available = new Map(lighting.fixtureRegistry.listEngineBy("", "all").map(row => [row.id, row]));
    lighting.twitchLightEffects?.cancelForStaticTargets?.(captured.states.map(row => row.fixtureId));
    const restorable = captured.states.filter(row => row.previous?.value);
    const eligible = restorable.filter(row => Number(lighting.lightingLab.previousState(row.fixtureId)?.generation || 0) === Number(row.expectedGeneration || 0));
    const superseded = restorable.length - eligible.length;
    const unavailable = captured.states.length - restorable.length;
    const deliveries = await Promise.all(eligible.map(async row => {
      const fixture = available.get(row.fixtureId), brand = String(row.previous.brand || "").toLowerCase();
      const adapter = brand === "hue" ? lighting.hueBridge : brand === "wiz" ? lighting.wizBridge : brand === "govee" ? lighting.goveeBridge : null;
      if (!fixture || !adapter?.sendState) return { fixtureId: row.fixtureId, ok: false };
      try {
        const result = await adapter.sendState([fixture], row.previous.value);
        if (Number(result?.sent || 0) < 1) return { fixtureId: row.fixtureId, ok: false };
        lighting.lightingLab.rememberState(fixture.id, brand, row.previous.value);
        return { fixtureId: row.fixtureId, ok: true };
      } catch { return { fixtureId: row.fixtureId, ok: false }; }
    }));
    const restored = deliveries.filter(row => row.ok).length;
    return { ok: restored === deliveries.length, restored, failed: deliveries.length - restored, superseded, unavailable,
      ...(restored === deliveries.length ? {} : { error: "lighting_restore_incomplete" }) };
  }
  async function applyNeutralState(lighting, payload, callOptions) {
    const selected = fixtureIds(payload.fixtureIds);
    if (!selected.length) throw providerError("lighting_target_unavailable", "No lighting fixtures were selected");
    const ownership = captureEligibleTargets(payload.captureId, callOptions, lighting, selected);
    const requested = new Set(ownership.eligible);
    if (!requested.size && ownership.superseded.length) return { ok: true, sent: 0, failed: 0, partial: false, superseded: ownership.superseded.length };
    const fixtures = lighting.fixtureRegistry.listEngineBy("", "all").filter(row => requested.has(row.id));
    if (!fixtures.length) throw providerError("lighting_target_unavailable", "No selected lighting fixtures are available");
    const state = normalizedState(payload.state);
    const transitiontime = Math.max(0, Math.min(30, Math.round(Number(payload.transitionMs || 0) / 100)));
    const hueBrightness = Math.max(1, Math.round(state.brightness * 254 / 100));
    const hueState = state.mode === "white"
      ? { on: true, ct: Math.max(153, Math.min(500, Math.round(1000000 / state.kelvin))), bri: hueBrightness, transitiontime }
      : { ...createHueStateFromRgb(state.rgb, { brightness: hueBrightness, transitiontime }), __rgb: state.rgb };
    const commonState = state.mode === "white"
      ? { on: true, temp: state.kelvin, dimming: state.brightness }
      : createWizStateFromRgb(state.rgb, { dimming: state.brightness });
    const brands = [["hue", lighting.hueBridge, hueState], ["wiz", lighting.wizBridge, commonState], ["govee", lighting.goveeBridge, commonState]];
    const deliveries = await Promise.all(brands.map(async ([brand, adapter, brandState]) => {
      const targets = fixtures.filter(row => String(row.brand).toLowerCase() === brand);
      if (!targets.length) return { brand, targets: [], sent: 0, failed: 0 };
      if (typeof adapter?.sendState !== "function") return { brand, targets, sent: 0, failed: targets.length };
      try {
        const result = await adapter.sendState(targets, brandState);
        const sent = Math.max(0, Number(result?.sent || 0)), failed = Math.max(0, Number(result?.failed || Math.max(0, targets.length - sent)));
        if (sent > 0) for (const fixture of targets) lighting.lightingLab.rememberState(fixture.id, brand, brandState);
        return { brand, targets, sent, failed };
      } catch { return { brand, targets, sent: 0, failed: targets.length }; }
    }));
    const sent = deliveries.reduce((sum, row) => sum + row.sent, 0);
    const failed = deliveries.reduce((sum, row) => sum + row.failed, 0) + Math.max(0, ownership.eligible.length - fixtures.length);
    if (sent > 0) {
      const deliveredIds = deliveries.filter(row => row.sent > 0).flatMap(row => row.targets.map(target => target.id));
      lighting.twitchLightEffects?.cancelForStaticTargets?.(deliveredIds);
      advanceCapture(payload.captureId, callOptions, lighting, deliveredIds);
    }
    return { ok: (sent > 0 || ownership.superseded.length > 0) && failed === 0, sent, failed, superseded: ownership.superseded.length,
      partial: sent > 0 && (failed > 0 || ownership.superseded.length > 0), ...((sent > 0 || ownership.superseded.length > 0) && failed === 0 ? {} : { error: sent > 0 ? "lighting_delivery_partial" : "hardware_delivery_failed" }) };
  }
  return async function applyLightingOutput(payload = {}, callOptions = {}) {
    const lighting = context.lightingCore;
    if (!lighting) throw providerError("lighting_unavailable", "Lighting is unavailable", true);
    const action = String(payload?.action || "");
    if (action === "capture") return capture(lighting, payload, callOptions);
    if (action === "restore") return restore(lighting, payload, callOptions);
    if (action === "catalog") return { ok: true, fixtures: lighting.fixtureRegistry.listEngineBy("", "all").slice(0, 64).map(row => ({ id: String(row.id), name: String(row.name || row.id).slice(0, 80), brand: String(row.brand || "").toLowerCase(), zone: String(row.zone || "").slice(0, 64) })) };
    if (action === "state") return applyNeutralState(lighting, payload, callOptions);
    if (action === "profile") {
      const profileId = String(payload?.profileId || "").trim();
      if (!idPattern.test(profileId)) throw providerError("lighting_profile_invalid", "Lighting profile is invalid");
      const targets = payload.captureId ? await resolveTargets(lighting, { action: "profile", profileId }) : [];
      const result = await lighting.lightingProfiles.apply(profileId);
      if (result?.ok !== false) advanceCapture(payload.captureId, callOptions, lighting, targets);
      return result;
    }
    if (action !== "color") throw providerError("lighting_action_invalid", "Unsupported lighting action");
    const command = String(payload?.command || "").trim();
    if (!command || command.length > 160) throw providerError("lighting_command_invalid", "Lighting command is invalid");
    const result = await lighting.colorCommandService.applyColorText(command, colorOptions(payload));
    if (result?.ok !== false) advanceCapture(payload.captureId, callOptions, lighting, result?.targets || []);
    return result;
  };
}

function createFeaturePlatformExtension(options = {}) {
  return function attachFeaturePlatform(context) {
    const rootDir = path.resolve(options.rootDir || context.rootDir);
    let registry;
    let twitchOAuth;
    let youtubeCatalog;
    const chatCommands = createTwitchChatCommandRouter({
      submitSongRequest: payload => registry.request("song-request", "song.queue.submit.v1", "submit", payload, { timeoutMs: 12000 }),
      selfManageSongRequest: payload => registry.request("song-request", "song.queue.submit.v1", "self", payload, { timeoutMs: 1500 }),
      moderateSongRequest: payload => registry.request("song-request", "song.queue.admin.v1", "moderate", payload, { timeoutMs: 1500 })
    });
    function twitchProvider() {
      if (!twitchOAuth) {
        const createTwitchOAuthProvider = require("../../capabilities/feature-platform/providers/twitch-oauth-provider");
        twitchOAuth = createTwitchOAuthProvider({
          vaultPath: path.join(context.runtimeDir, "features", "twitch-integration.vault.json"),
          defaultClientId: TWITCH_PUBLIC_CLIENT_ID,
          automationEventsEnabled: () => registry?.list().features.some(row => row.id === "automation" && row.lifecycle === "active") === true,
          onIntakeModeChange: mode => context.twitchIntakeGate?.setMode?.(mode),
          onRedemption: async (event, managedRewards) => {
            try {
              const routed = await registry.request("automation", "automation.twitch.events.v1", "receive", {
                triggerId: `reward:${String(event?.reward?.id || "").slice(0, 160)}`,
                eventId: String(event?.id || "").slice(0, 160),
                userId: String(event?.user_id || "").slice(0, 80),
                userName: String(event?.user_name || event?.user_login || "").slice(0, 80),
                amount: Math.max(0, Math.min(1000000, Math.round(Number(event?.reward?.cost) || 0)))
              }, { timeoutMs: 1500 });
              const automation = routed?.ok ? routed.value : null;
              if (automation?.handled) {
                const managed = Object.values(managedRewards || {}).some(row => row?.rewardId === event?.reward?.id);
                if (managed && event?.id) await twitchProvider().settle({
                  broadcasterId: event?.broadcaster_user_id,
                  rewardId: event?.reward?.id,
                  redemptionId: event.id,
                  status: automation.ok ? "FULFILLED" : "CANCELED"
                });
                return automation;
              }
            } catch {}
            let requester = chatCommands.profileFor(event?.user_id);
            if (requester.role === "viewer") {
              const resolved = await twitchProvider().resolveRequesterRole(event?.user_id);
              if (resolved?.ok) requester = { ...requester, role: resolved.role };
            }
            return context.widgetController?.handleWidgetEvent?.({
              transport: "native",
              eventEnvelope: { event: { ...event, requester_role: requester.role } },
              widgetConfig: {
                colorRewardId: managedRewards?.lights?.rewardId || "",
                teachRewardId: managedRewards?.teach?.rewardId || "",
                songRewardId: twitchProvider().status().monitorConfig.songRequestChatEnabled ? "" : (managedRewards?.song_request?.rewardId || "")
              }
            });
          },
          onEvent: async (type, event, metadata) => {
            if (type === "channel.subscribe" && event?.is_gift === true) return { ok: true, handled: false, code: "automation_twitch_gift_subscription_separated" };
            const amount = twitchEventAmount(type, event);
            const routed = await registry.request("automation", "automation.twitch.events.v1", "receive", {
              triggerId: `event:${String(type || "").slice(0, 120)}`,
              eventId: String(metadata?.message_id || event?.id || event?.event_id || "").slice(0, 160),
              userId: String(event?.user_id || event?.from_broadcaster_user_id || "").slice(0, 80),
              userName: String(event?.user_name || event?.from_broadcaster_user_name || "").slice(0, 80),
              ...(amount === undefined ? {} : { amount }),
              tier: String(event?.tier || "").slice(0, 20),
              streamId: String(type === "stream.online" ? event?.id || "" : "").slice(0, 160),
              occurredAt: String(metadata?.message_timestamp || event?.started_at || "").slice(0, 40)
            }, { timeoutMs: 1500 });
            return routed?.ok ? routed.value : routed;
          },
          onChat: (event, monitorConfig) => {
            const handled = chatCommands.handle(event, monitorConfig);
            const requester = chatCommands.profileFor(event?.chatter_user_id);
            twitchProvider().observeRequesterRole(requester.userId, requester.role);
            return handled;
          }
        });
      }
      return twitchOAuth;
    }
    function youtubeProvider() {
      if (!youtubeCatalog) {
        const { createYoutubeCatalogProvider } = require("../../capabilities/feature-platform/providers/youtube-catalog-provider");
        youtubeCatalog = createYoutubeCatalogProvider({
          vaultPath: path.join(context.runtimeDir, "features", "youtube-catalog.vault.json"),
          egressGovernor: context.egressGovernor,
          defaultMode: "keyless"
        });
      }
      return youtubeCatalog;
    }
    const mediaObserver = createWindowsMediaObserver({
      observerPath: path.join(rootDir, "scripts", "windows-media-observer.ps1"),
      onSnapshot: payload => registry.request("song-request", "song.playback.observe.v1", "observe", payload, { timeoutMs: 1000 })
    });
    const applyLightingOutput = createLightingOutputProvider(context);
    const featureRuntimeRoot = options.runtimeRoot || path.join(context.runtimeDir, "features");
    const ttsPayloadManager = createTtsPayloadManager({
      root: path.join(featureRuntimeRoot, "tts-payloads"),
      catalog: options.ttsPayloadCatalog || OFFICIAL_TTS_PAYLOADS,
      fetchImpl: options.featureFetch
    });
    registry = createFeatureHostRegistry({
      featuresRoot: options.featuresRoot || path.join(rootDir, "features", "installed"),
      packageRoots: options.packageRoots || [path.join(rootDir, "feature-packages"), path.join(rootDir, "features")],
      remoteSources: options.remoteSources || (options.packageRoots ? [] : OFFICIAL_FEATURE_SOURCES),
      fetchImpl: options.featureFetch,
      runtimeRoot: featureRuntimeRoot,
      providers: {
        "lighting.output.v1/apply": applyLightingOutput,
        "media.windows.now-playing.v1/control": payload => mediaObserver.control(payload),
        "twitch.host.v1/status": () => twitchProvider().ensureStatus(),
        "twitch.host.v1/configure": payload => twitchProvider().configure(payload),
        "twitch.host.v1/configure-monitor": payload => twitchProvider().configureMonitor(payload),
        "twitch.host.v1/clear-client-id": () => twitchProvider().clearClientId(),
        "twitch.host.v1/begin": payload => twitchProvider().begin(payload),
        "twitch.host.v1/poll": () => twitchProvider().poll(),
        "twitch.host.v1/disconnect": () => twitchProvider().disconnect(),
        "twitch.host.v1/inspect-reward": payload => twitchProvider().inspectReward(payload),
        "twitch.host.v1/list-rewards": payload => twitchProvider().listRewards(payload),
        "twitch.host.v1/create-reward": payload => twitchProvider().createReward(payload),
        "twitch.rewards.manage.v1/set-paused": payload => twitchProvider().setManagedRewardPaused(payload),
        "twitch.host.v1/settle": payload => twitchProvider().settle(payload),
        "twitch.host.v1/send-chat": payload => twitchProvider().sendChat(payload),
        "youtube.catalog.host.v1/status": () => youtubeProvider().status(),
        "youtube.catalog.host.v1/configure": payload => youtubeProvider().configure(payload),
        "youtube.catalog.host.v1/clear": () => youtubeProvider().clear(),
        "youtube.catalog.host.v1/resolve": payload => youtubeProvider().resolve(payload),
        "youtube.catalog.host.v1/import-playlist-start": payload => youtubeProvider().importPlaylistStart(payload),
        "youtube.catalog.host.v1/import-playlist-status": payload => youtubeProvider().importPlaylistStatus(payload),
        "youtube.catalog.host.v1/import-playlist-page": payload => youtubeProvider().importPlaylistPage(payload),
        "youtube.catalog.host.v1/import-playlist-cancel": payload => youtubeProvider().importPlaylistCancel(payload),
        "alerts.tts.packages.v1/status": () => createTtsPackageProvider(registry, OFFICIAL_FEATURE_SOURCES, ttsPayloadManager).status(),
        "alerts.tts.packages.v1/install": payload => createTtsPackageProvider(registry, OFFICIAL_FEATURE_SOURCES, ttsPayloadManager).install(payload),
        "alerts.tts.packages.v1/update": payload => createTtsPackageProvider(registry, OFFICIAL_FEATURE_SOURCES, ttsPayloadManager).update(payload),
        "alerts.tts.packages.v1/remove": payload => createTtsPackageProvider(registry, OFFICIAL_FEATURE_SOURCES, ttsPayloadManager).remove(payload),
        ...(options.providers || {})
      },
      allowUnsafeRuntime: options.allowUnsafeRuntime === true
    });
    registerFeaturePlatformRoutes(context.app, { registry });
    let automationActive = false;
    const unsubscribeLifecycle = registry.subscribeLifecycle(snapshot => {
      if (!snapshot?.features?.some(row => row.id === "song-request" && row.lifecycle === "active")) mediaObserver.stop().catch(() => {});
      const twitchActive = snapshot?.features?.some(row => row.id === "twitch-integration" && row.lifecycle === "active");
      const nextAutomationActive = snapshot?.features?.some(row => row.id === "automation" && row.lifecycle === "active") === true;
      if (nextAutomationActive !== automationActive) { automationActive = nextAutomationActive; twitchOAuth?.refreshSubscriptions?.(); }
      if (!twitchActive) twitchOAuth?.suspendMonitor?.();
      else if (twitchOAuth) twitchOAuth.ensureStatus().catch(() => {});
    });
    const startup = registry.startInstalled().catch(error => ({ ok: false, error: String(error?.message || error).slice(0, 160) }));
    void startup.then(() => {
      if (registry.list().features.some(row => row.id === "twitch-integration" && row.lifecycle === "active")) return twitchProvider().ensureStatus();
      return null;
    }).catch(() => {});
    return Object.freeze({
      owner: "feature-platform",
      registry,
      startup,
      mediaObserver,
      async shutdown() {
        unsubscribeLifecycle?.();
        await mediaObserver.stop();
        await twitchOAuth?.shutdown?.();
        return registry.shutdown();
      }
    });
  };
}

module.exports = createFeaturePlatformExtension;
module.exports.createLightingOutputProvider = createLightingOutputProvider;
module.exports.createTtsPackageProvider = createTtsPackageProvider;
