/** Read-only overview. Optional workers are queried only while Dashboard is visible. */
const { requireLocalOperator } = require("../runtime/local-operator.middleware");
module.exports = function registerDashboardRoutes(app, { core, music, getRegistry }) {
  app.get("/api/dashboard", requireLocalOperator, async (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const registry = getRegistry();
      const packages = (registry?.list().features || []).map((row) => ({
        id: row.id,
        name: row.name,
        lifecycle: row.lifecycle,
        pages: row.uiContributions.map(({ id, title }) => ({ id, title })),
      }));
      const active = (id) => packages.some((p) => p.id === id && p.lifecycle === "active");
      let song = null;
      if (active("song-request")) {
        try {
          const [queue, playback] = await Promise.all([
            registry.request(
              "song-request",
              "song.queue.read.v1",
              "status",
              { limit: 1, playlistLimit: 1, moderationLimit: 1 },
              { timeoutMs: 2000 },
            ),
            registry.request("song-request", "song.playback.read.v1", "status", null, {
              timeoutMs: 2000,
            }),
          ]);
          if (queue.ok && playback.ok) {
            const current = playback.value.primary;
            song = {
              paused: queue.value.paused,
              queued: queue.value.counts.queued,
              title: current?.candidate?.title || current?.title || "",
              canSkip: Boolean(playback.value.managed?.entryId),
              entryId: playback.value.managed?.entryId || "",
            };
          }
        } catch {
          /* Leave this card unavailable; other controls still work. */
        }
      }
      const view = music.view(),
        library = await music.library();
      res.json({
        ok: true,
        packages,
        featuresAvailable: Boolean(registry),
        song,
        twitchActive: active("twitch-integration"),
        music: {
          state: view.status.state,
          source: view.status.sourceLabel || "",
          lights: view.status.musicFixtureCount,
          ready: Boolean(
            view.captureAvailable &&
            view.status.sourceSelected &&
            view.status.permissions.capture &&
            view.status.permissions.output &&
            view.status.musicFixtureCount,
          ),
          autoRave: library.enabled,
          pending: library.pending.length,
        },
        profiles: core.lightingProfiles.snapshot().profiles.map(({ id, name }) => ({ id, name })),
      });
    } catch (error) {
      next(error);
    }
  });
};
