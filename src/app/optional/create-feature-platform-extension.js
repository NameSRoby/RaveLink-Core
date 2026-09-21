const path = require("node:path");
const createFeatureHostRegistry = require("../../capabilities/feature-platform/host/feature-host-registry");
const registerFeaturePlatformRoutes = require("../../capabilities/feature-platform/http/register-feature-platform.routes");
const createWindowsMediaObserver = require("../../capabilities/feature-platform/providers/windows-media-observer");
const createTwitchChatCommandRouter = require("../../capabilities/feature-platform/providers/twitch-chat-command-router");
const { TWITCH_PUBLIC_CLIENT_ID } = require("../../capabilities/feature-platform/providers/twitch-public-client");
const { OFFICIAL_FEATURE_SOURCES } = require("../../capabilities/feature-platform/packages/official-feature-sources");

module.exports = function createFeaturePlatformExtension(options = {}) {
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
          onRedemption: async (event, managedRewards) => {
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
    registry = createFeatureHostRegistry({
      featuresRoot: options.featuresRoot || path.join(rootDir, "features", "installed"),
      packageRoots: options.packageRoots || [path.join(rootDir, "feature-packages"), path.join(rootDir, "features")],
      remoteSources: options.remoteSources || (options.packageRoots ? [] : OFFICIAL_FEATURE_SOURCES),
      fetchImpl: options.featureFetch,
      runtimeRoot: options.runtimeRoot || path.join(context.runtimeDir, "features"),
      providers: {
        "media.windows.now-playing.v1/control": payload => mediaObserver.control(payload),
        "twitch.host.v1/status": () => twitchProvider().ensureStatus(),
        "twitch.host.v1/configure": payload => twitchProvider().configure(payload),
        "twitch.host.v1/configure-monitor": payload => twitchProvider().configureMonitor(payload),
        "twitch.host.v1/clear-client-id": () => twitchProvider().clearClientId(),
        "twitch.host.v1/begin": payload => twitchProvider().begin(payload),
        "twitch.host.v1/poll": () => twitchProvider().poll(),
        "twitch.host.v1/disconnect": () => twitchProvider().disconnect(),
        "twitch.host.v1/inspect-reward": payload => twitchProvider().inspectReward(payload),
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
        ...(options.providers || {})
      },
      allowUnsafeRuntime: options.allowUnsafeRuntime === true
    });
    registerFeaturePlatformRoutes(context.app, { registry });
    const unsubscribeLifecycle = registry.subscribeLifecycle(snapshot => {
      if (!snapshot?.features?.some(row => row.id === "song-request" && row.lifecycle === "active")) void mediaObserver.stop();
      const twitchActive = snapshot?.features?.some(row => row.id === "twitch-integration" && row.lifecycle === "active");
      if (!twitchActive) twitchOAuth?.suspendMonitor?.();
      else if (twitchOAuth) void twitchOAuth.ensureStatus();
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
};
