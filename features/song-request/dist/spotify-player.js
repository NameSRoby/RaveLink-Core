/**
 * Spotify request delivery and playback coordination.
 * Provider readiness, accepted queue delivery, and observed now-playing data are
 * independent signals. Preserve occurrence identifiers for removal and moderation.
 * An unconfirmed append must stay reviewable; retrying it blindly can queue twice.
 * Use host capabilities rather than giving the feature direct desktop/network access.
 */
module.exports = function createSpotifyPlayer({
  queue,
  context,
  changed,
  isSelected = async () => true,
}) {
  const provider = (method, payload) =>
    context.callCapability("spotify.desktop.host.v1", method, payload, {
      timeoutMs: ["resolve", "enqueue", "remove"].includes(method)
        ? 20000
        : method === "setup"
          ? 30000
          : 10000,
    });
  let work = null,
    stopped = false,
    lastError = "",
    moderating = false;
  const entries = () => {
    const first = queue.status({ limit: 25 }),
      rows = [...first.queue];
    for (let offset = 25; offset < Math.min(200, first.counts.queued); offset += 25)
      rows.push(...queue.status({ offset, limit: 25 }).queue);
    return rows.filter((row) => row.candidate.provider === "spotify");
  };
  async function run() {
    try {
      for (let index = 0; index < 10 && !stopped && !moderating; index++) {
        if (!(await isSelected())) return;
        const status = await provider("status", null);
        if (!status.ready || status.capacity.available < 1) return;
        const waiting = entries(),
          row = waiting.find(
            (item) =>
              !status.handoffs?.some(
                (receipt) =>
                  receipt.entryId === item.id &&
                  ["unknown", "pending", "failed"].includes(receipt.phase),
              ),
          );
        if (!row) return;
        if (!(await isSelected())) return;
        const result = await provider("enqueue", {
          entryId: row.id,
          candidate: row.candidate,
          requesterKey: row.requesterKey,
          requesterLabel: row.requesterLabel,
          requesterRole: row.requesterRole,
        });
        if (!result.ok || !result.appended) {
          lastError = result.error || "spotify_delivery_unconfirmed";
          return;
        }
        const settled = queue.settle({
          entryId: row.id,
          outcome: "handed_off",
        });
        if (settled.ok) changed(settled);
      }
    } catch {
      lastError = "spotify_companion_unavailable";
    }
  }
  function trigger() {
    if (!work && !stopped && !moderating && entries().length) {
      lastError = "";
      work = Promise.resolve()
        .then(run)
        .finally(() => {
          work = null;
        });
    }
    return { ok: true, processing: Boolean(work) };
  }
  const moderate = require("./tidal-moderation")({
    queue,
    provider,
    changed,
    providerName: "spotify",
    waitForDelivery: () => work || Promise.resolve(),
  });
  async function handle(method, payload = {}) {
    if (method === "flush") return trigger();
    if (method === "status") {
      const status = await provider("status", null);
      return {
        ...status,
        queue: entries(),
        delivery: { processing: Boolean(work), lastError },
      };
    }
    if (method === "setup" || method === "control") return provider(method, payload);
    if (method === "lookup") {
      const state = queue.status();
      return provider("resolve", {
        query: payload.query,
        policy: {
          ...state.catalogPolicy,
          maxDurationMs: state.limits.maxDurationMs,
        },
      });
    }
    if (method === "review") {
      const result = await provider("review", payload);
      if (result.ok) trigger();
      return result;
    }
    if (method === "moderate") {
      const waiting = entries();
      moderating = true;
      try {
        return await moderate(payload, waiting);
      } finally {
        moderating = false;
        trigger();
      }
    }
    if (method === "monitor") {
      await context
        .callCapability(
          "media.windows.now-playing.v1",
          "control",
          { action: "stop" },
          { timeoutMs: 2000 },
        )
        .catch(() => {});
      const result = queue.configurePlaybackSource({ source: "spotify" });
      changed(result);
      return result;
    }
    if (method === "submit")
      return submit({
        ...payload,
        requesterId: "local-spotify-operator",
        requesterName: "Local Spotify operator",
        requesterRole: "moderator",
      });
    return { ok: false, error: "spotify_method_invalid" };
  }
  async function submit(payload) {
    if (!(await isSelected())) return { ok: false, code: "rejected", reason: "player_inactive" };
    const state = queue.status();
    let result;
    try {
      result = await provider("resolve", {
        query: payload.query,
        policy: {
          ...state.catalogPolicy,
          maxDurationMs: state.limits.maxDurationMs,
        },
      });
    } catch {
      return {
        ok: false,
        code: "rejected",
        reason: "spotify_search_unavailable",
      };
    }
    if (!result.ok) return { ok: false, code: "rejected", reason: result.error };
    if (!(await isSelected())) return { ok: false, code: "rejected", reason: "player_inactive" };
    let submitted = queue.submit({ ...payload, candidate: result.candidate });
    if (submitted.ok) {
      submitted = await require("./desktop-queue-position")(queue, "spotify", submitted, () =>
        provider("status", null),
      );
      changed(submitted);
      trigger();
    }
    return submitted;
  }
  handle.route = async (request, preferences) => {
    if (request.capability === "song.spotify.player.v1")
      return { value: await handle(request.method, request.payload || {}) };
    if (
      request.capability === "song.queue.admin.v1" &&
      request.method === "moderate" &&
      request.payload?.provider === "spotify"
    )
      return { value: await handle("moderate", request.payload) };
    if (
      request.capability === "song.queue.submit.v1" &&
      request.method === "submit" &&
      (request.activePlayer || (await preferences("status", null)).player) === "spotify"
    )
      return { value: await submit(request.payload || {}) };
    return null;
  };
  handle.submit = submit;
  handle.stop = () => {
    stopped = true;
  };
  return handle;
};
