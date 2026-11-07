/** Core-owned reward controls; exact IDs must still belong to a managed purpose. */
const { rateLimit } = require("express-rate-limit");
const { requireLocalOperator } = require("../../../app/runtime/local-operator.middleware");
const purposes = new Set(["lights", "teach", "song_request", "add_to_playlist"]);
const fault = (code, status = 409) => Object.assign(Error(code), { code, status });
module.exports = function registerDashboardRewards(app, { getProvider, registry }) {
  let busy = false,
    changes = [];
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
      return {
        ok: true,
        available: false,
        reason:
          catalog.error === "twitch_scope_missing"
            ? "twitch_scope_missing"
            : "reward_status_unavailable",
        rewards: [],
      };
    const known = new Map(status.managedRewards.map((row) => [row.rewardId, row.purpose]));
    return {
      ok: true,
      available: true,
      rewards: catalog.rewards
        .filter((row) => known.has(row.id) && purposes.has(known.get(row.id)))
        .map((row) => ({
          id: row.id,
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
  async function update(body, toggle = false) {
    if (
      !body ||
      Object.keys(body).some((key) => !["purpose", "paused", "rewardId"].includes(key)) ||
      typeof body.paused !== "boolean" ||
      (body.rewardId !== undefined &&
        (typeof body.rewardId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(body.rewardId))) ||
      (body.purpose !== "all" && !purposes.has(body.purpose))
    )
      throw fault("dashboard_reward_request_invalid", 400);
    if (busy) throw fault("dashboard_rewards_busy");
    changes = changes.filter((at) => Date.now() - at < 60000);
    if (changes.length >= 20) throw fault("dashboard_rewards_rate_limited", 429);
    changes.push(Date.now());
    busy = true;
    try {
      const before = await snapshot(true);
      if (!before.available) throw fault(before.reason);
      const selected = before.rewards.filter(
        (row) =>
          row.manageable &&
          (body.purpose === "all" || row.purpose === body.purpose) &&
          (!body.rewardId || row.id === body.rewardId),
      );
      if (!selected.length) throw fault("managed_rewards_unavailable");
      if (toggle && selected.some((row) => typeof row.paused !== "boolean"))
        throw fault("managed_rewards_state_unknown");
      const paused = toggle ? selected.some((row) => row.paused === false) : body.paused;
      // Intake admission owns song rewards. Never reopen a paused or unavailable queue.
      let songOpen = false;
      if (
        !paused &&
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
        if (!paused && !songOpen && ["song_request", "add_to_playlist"].includes(row.purpose)) {
          results.push({
            id: row.id,
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
            rewardId: row.id,
            paused,
          });
          results.push({
            id: row.id,
            purpose: row.purpose,
            ok: result?.ok === true,
            ...(result?.ok ? {} : { error: "reward_update_failed" }),
          });
        } catch {
          results.push({
            id: row.id,
            purpose: row.purpose,
            ok: false,
            error: "reward_update_failed",
          });
        }
      }
      return {
        ok: true,
        results,
        partial: results.some((row) => !row.ok),
        state: await snapshot(true),
      };
    } catch (error) {
      throw error;
    } finally {
      busy = false;
    }
  }
  app.post("/api/dashboard/rewards", requireLocalOperator, limit, async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await update(req.body));
    } catch (error) {
      if (error.code) res.status(error.status || 409).json({ ok: false, error: error.code });
      else next(error);
    }
  });
  return Object.freeze({
    snapshot,
    update,
    toggle: (purpose = "all") => update({ purpose, paused: false }, true),
    toggleReward: async (rewardId) => {
      if (typeof rewardId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(rewardId))
        throw fault("dashboard_reward_request_invalid", 400);
      return update({ purpose: "all", paused: false, rewardId }, true);
    },
  });
};
