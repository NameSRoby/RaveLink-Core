const path = require("node:path");
const createFeatureHostRegistry = require("../../capabilities/feature-platform/host/feature-host-registry");
const registerFeaturePlatformRoutes = require("../../capabilities/feature-platform/http/register-feature-platform.routes");
const createWindowsMediaObserver = require("../../capabilities/feature-platform/providers/windows-media-observer");
const createTwitchChatCommandRouter = require("../../capabilities/feature-platform/providers/twitch-chat-command-router");
const { TWITCH_PUBLIC_CLIENT_ID } = require("../../capabilities/feature-platform/providers/twitch-public-client");
const { OFFICIAL_FEATURE_SOURCES } = require("../../capabilities/feature-platform/packages/official-feature-sources");

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
          onIntakeModeChange: mode => context.twitchIntakeGate?.setMode?.(mode),
          onRedemption: require('../../capabilities/feature-platform/providers/twitch-redemption-router')({ twitchProvider, chatCommands, widgetController: context.widgetController }),
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
      onSnapshot: payload => {
        tidalBridge?.observe(payload);
        return registry.request("song-request", "song.playback.observe.v1", "observe", payload, { timeoutMs: 1000 });
      }
    });
    const featureRuntimeRoot = options.runtimeRoot || path.join(context.runtimeDir, "features");
    const playlistExports = require('../../capabilities/feature-platform/providers/playlist-export-provider')({ root: path.join(context.runtimeDir, 'exports', 'playlists') });
    let tidalCatalog, soundcloudCatalog;
    const getSoundCloudCatalog = () => soundcloudCatalog || (soundcloudCatalog = require('../../capabilities/feature-platform/providers/soundcloud-catalog-provider')({ fetchImpl: options.soundcloudCatalogFetch, egressGovernor: context.egressGovernor }));
    const getTidalCatalog = () => tidalCatalog || (tidalCatalog = require('../../capabilities/feature-platform/providers/tidal-catalog-provider')({
      vaultPath: path.join(context.runtimeDir, 'tidal-catalog-vault.json'), fetchImpl: options.tidalCatalogFetch, egressGovernor: context.egressGovernor
    }));
    require('../../capabilities/feature-platform/http/register-tidal-oauth.routes')(context.app, getTidalCatalog);
    registry = createFeatureHostRegistry({
      featuresRoot: options.featuresRoot || path.join(rootDir, "features", "installed"),
      packageRoots: options.packageRoots || [path.join(rootDir, "feature-packages"), path.join(rootDir, "features")],
      remoteSources: options.remoteSources || (options.packageRoots ? [] : OFFICIAL_FEATURE_SOURCES),
      fetchImpl: options.featureFetch,
      runtimeRoot: featureRuntimeRoot,
      providers: {
        'playlist.exports.host.v1/action': (payload, caller) => caller.featureId === 'song-request' ? playlistExports.action(payload) : { ok: false, code: 'export_denied' },
        'soundcloud.catalog.host.v1/resolve': (payload, caller) => caller.featureId === 'song-request' ? getSoundCloudCatalog().resolve(payload) : { ok: false, reason: 'soundcloud_catalog_denied' },
        "media.windows.now-playing.v1/control": payload => mediaObserver.control(payload),
        'tidal.playlists.host.v1/action': (payload, caller) => caller.featureId === 'song-request' ? getTidalCatalog().playlists(payload) : { ok: false, error: 'tidal_playlist_denied' },
        "tidal.desktop.experimental.v1/status": () => tidalBridge ? tidalBridge.status() : { ok: true, enabled: false },
        'tidal.desktop.experimental.v1/volume': (payload, caller) => caller.featureId === 'song-request' && tidalBridge ? tidalBridge.volume(payload) : { ok: false, error: 'tidal_experiment_disabled' },
        "tidal.desktop.experimental.v1/enable": (_payload, caller) => caller.featureId === 'song-request' ? enableTidalExperiment() : { ok: false, error: 'tidal_experiment_denied' },
        "tidal.desktop.experimental.v1/manage-companion": (payload, caller) => manageTidalCompanion(payload, caller),
        "tidal.desktop.experimental.v1/catalog": (payload, caller) => {
          if (caller.featureId !== 'song-request' || !['status', 'configure', 'reset-client', 'begin', 'test', 'disconnect', 'clear'].includes(payload?.action)) return { ok: false, error: 'tidal_catalog_action_denied' };
          return getTidalCatalog()[payload.action](payload);
        },
        "tidal.desktop.experimental.v1/resolve": (payload, caller) => caller.featureId === 'song-request' && tidalBridge ? tidalBridge.resolve(payload) : { ok: false, error: 'tidal_experiment_disabled' },
        "tidal.desktop.experimental.v1/enqueue": (payload, caller) => caller.featureId === 'song-request' && tidalBridge ? tidalBridge.enqueue(payload) : { ok: false, error: 'tidal_experiment_disabled' },
        "tidal.desktop.experimental.v1/review": (payload, caller) => caller.featureId === 'song-request' && tidalBridge ? tidalBridge.review(payload) : { ok: false, error: 'tidal_experiment_disabled' },
        "tidal.desktop.experimental.v1/remove": (payload, caller) => caller.featureId === 'song-request' && tidalBridge ? tidalBridge.remove(payload) : { ok: false, error: 'tidal_experiment_disabled' },
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
        "twitch.host.v1/review-transactions": () => twitchProvider().reviewTransactions(),
        "twitch.host.v1/reconcile-transaction": payload => twitchProvider().reconcileTransaction(payload),
        "twitch.host.v1/send-chat": payload => twitchProvider().sendChat(payload),
        "youtube.catalog.host.v1/status": () => youtubeProvider().status(),
        "youtube.catalog.host.v1/configure": payload => youtubeProvider().configure(payload),
        "youtube.catalog.host.v1/clear": () => youtubeProvider().clear(),
        "youtube.catalog.host.v1/resolve": payload => youtubeProvider().resolve(payload),
        "youtube.catalog.host.v1/import-playlist-start": payload => youtubeProvider().importPlaylistStart(payload),
        "youtube.catalog.host.v1/import-playlist-status": payload => youtubeProvider().importPlaylistStatus(payload),
        "youtube.catalog.host.v1/import-playlist-page": payload => youtubeProvider().importPlaylistPage(payload),
        "youtube.catalog.host.v1/import-playlist-cancel": payload => youtubeProvider().importPlaylistCancel(payload),
        ...(options.providers || {})
      },
      allowUnsafeRuntime: options.allowUnsafeRuntime === true
    });
    registerFeaturePlatformRoutes(context.app, { registry });
    const tidalEnabled = options.experimentalTidal === true || process.env.RAVELINK_EXPERIMENTAL_TIDAL === '1';
    let tidalBridge;
    const manageTidalCompanion = require('../../capabilities/feature-platform/providers/tidal-companion-manager')({ rootDir, runtimeDir: context.runtimeDir, getBridge: () => tidalBridge, installer: options.tidalCompanionInstaller });
    function enableTidalExperiment() {
      if (!tidalBridge) {
        tidalBridge = require('../../capabilities/feature-platform/providers/experimental-tidal-bridge')({ runtimeDir: context.runtimeDir,
          search: query => getTidalCatalog().search(query),
          onQueueChanged: () => { registry.request('song-request', 'song.tidal.experimental.v1', 'flush', { nativeQueueChanged: true }).catch(() => {}); } });
        require('../../capabilities/feature-platform/http/register-experimental-tidal.routes')(context.app, { bridge: tidalBridge, registry, rootDir });
      }
      return tidalBridge.status();
    }
    if (tidalEnabled) enableTidalExperiment();
    const unsubscribeLifecycle = registry.subscribeLifecycle(snapshot => {
      if (!snapshot?.features?.some(row => row.id === "song-request" && row.lifecycle === "active")) mediaObserver.stop().catch(() => {});
      const twitchActive = snapshot?.features?.some(row => row.id === "twitch-integration" && row.lifecycle === "active");
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
        tidalBridge?.shutdown();
        tidalCatalog?.shutdown();
        await mediaObserver.stop();
        await twitchOAuth?.shutdown?.();
        return registry.shutdown();
      }
    });
  };
}

module.exports = createFeaturePlatformExtension;
