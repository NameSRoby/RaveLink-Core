/** Core-owned reward controls; clients select a managed purpose, never an arbitrary reward ID. */
const { rateLimit } = require("express-rate-limit");
const { requireLocalOperator } = require("../../../app/runtime/local-operator.middleware");
const purposes = new Set(["lights", "teach", "song_request", "add_to_playlist"]);
module.exports = function registerDashboardRewards(app, { getProvider, registry }) {
  let busy = false;
  const active = (id) =>
    registry.list().features.some((row) => row.id === id && row.lifecycle === "active");
  async function snapshot(force = false) {
    if (!active("twitch-integration"))
      return { ok: true, available: false, reason: "twitch_integration_inactive", rewards: [] };
    const provider = getProvider(),
      status = provider.status();
    if (!status.connected)
      return { ok: true, available: false, reason: "twitch_disconnected", rewards: [] };
    const catalog = await provider.listRewards({ force });
    if (!catalog.ok)
      return { ok: true, available: false, reason: "reward_status_unavailable", rewards: [] };
    const known = new Map(status.managedRewards.map((row) => [row.rewardId, row.purpose]));
    return {
      ok: true,
      available: true,
      rewards: catalog.rewards
        .filter((row) => known.has(row.id) && purposes.has(known.get(row.id)))
        .map((row) => ({
          purpose: known.get(row.id),
          title: row.title,
          cost: row.cost,
          paused: row.paused,
          enabled: row.enabled,
          manageable: row.manageable,
        })),
    };
  }
  const limit = rateLimit({
    windowMs: 60000,
    limit: 20,
    keyGenerator: () => "dashboard-rewards",
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.get("/api/dashboard/rewards", requireLocalOperator, async (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await snapshot());
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/dashboard/rewards", requireLocalOperator, limit, async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const body = req.body;
    if (
      !body ||
      Object.keys(body).some((key) => !["purpose", "paused"].includes(key)) ||
      typeof body.paused !== "boolean" ||
      (body.purpose !== "all" && !purposes.has(body.purpose))
    )
      return res.status(400).json({ ok: false, error: "dashboard_reward_request_invalid" });
    if (busy) return res.status(409).json({ ok: false, error: "dashboard_rewards_busy" });
    busy = true;
    try {
      const before = await snapshot(true);
      if (!before.available) return res.status(409).json({ ok: false, error: before.reason });
      const selected = before.rewards.filter(
        (row) => row.manageable && (body.purpose === "all" || row.purpose === body.purpose),
      );
      if (!selected.length)
        return res.status(409).json({ ok: false, error: "managed_rewards_unavailable" });
      // Intake admission owns song rewards. Never reopen a paused or unavailable queue.
      let songOpen = false;
      if (
        !body.paused &&
        selected.some((r) => ["song_request", "add_to_playlist"].includes(r.purpose)) &&
        active("song-request")
      ) {
        try {
          const queue = await registry.request(
            "song-request",
            "song.queue.read.v1",
            "status",
            { limit: 1, playlistLimit: 1, moderationLimit: 1 },
            { timeoutMs: 2000 },
          );
          songOpen = queue.ok && queue.value?.paused === false;
        } catch {
          /* Unverified intake remains closed. */
        }
      }
      const results = [];
      for (const row of selected) {
        if (
          !body.paused &&
          !songOpen &&
          ["song_request", "add_to_playlist"].includes(row.purpose)
        ) {
          results.push({
            purpose: row.purpose,
            ok: false,
            held: true,
            error: "song_intake_paused_or_unavailable",
          });
          continue;
        }
        try {
          const result = await getProvider().setManagedRewardPaused({
            purpose: row.purpose,
            paused: body.paused,
          });
          results.push({
            purpose: row.purpose,
            ok: result?.ok === true,
            ...(result?.ok ? {} : { error: "reward_update_failed" }),
          });
        } catch {
          results.push({ purpose: row.purpose, ok: false, error: "reward_update_failed" });
        }
      }
      res.json({
        ok: true,
        results,
        partial: results.some((row) => !row.ok),
        state: await snapshot(true),
      });
    } catch (error) {
      next(error);
    } finally {
      busy = false;
    }
  });
};
