/**
 * Taught color preview service.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#lighting-and-dynamic-effects
 */
// Briefly shows a newly taught color on its saved Twitch route, then restores
// only fixtures that have not received a newer command in the meantime.

module.exports = function createTaughtColorPreviewService(options = {}) {
  const { colorCommandService, fixtureRegistry, lightingLab, hueBridge, wizBridge, goveeBridge } =
    options;
  const delay = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const durationMs = Math.max(500, Math.min(5000, Number(options.durationMs || 1400)));
  if (options.outputOwnership)
    return require("./taught-color-preview-output")({ ...options, durationMs, delay });
  const timers = new Set();

  function adapterFor(brand) {
    return brand === "hue"
      ? hueBridge
      : brand === "wiz"
        ? wizBridge
        : brand === "govee"
          ? goveeBridge
          : null;
  }

  async function restore(rows) {
    const available = new Map(fixtureRegistry.listEngineBy("", "all").map((row) => [row.id, row]));
    let restored = 0,
      superseded = 0,
      failed = 0;
    for (const row of rows) {
      if (
        Number(lightingLab.previousState(row.fixtureId)?.generation || 0) !== row.expectedGeneration
      ) {
        superseded += 1;
        continue;
      }
      const fixture = available.get(row.fixtureId),
        adapter = adapterFor(row.previous.brand);
      if (!fixture || typeof adapter?.sendState !== "function") {
        failed += 1;
        continue;
      }
      try {
        const result = await adapter.sendState([fixture], row.previous.value);
        if (Number(result?.sent || 0) < 1) {
          failed += 1;
          continue;
        }
        lightingLab.rememberState(row.fixtureId, row.previous.brand, row.previous.value);
        restored += 1;
      } catch {
        failed += 1;
      }
    }
    return { restored, superseded, failed };
  }

  async function preview(hex) {
    const route = await colorCommandService.applyColorText(hex, {
      preview: true,
    });
    if (!route?.ok)
      return {
        ok: false,
        scheduled: false,
        reason: route?.error || "teach_preview_route_unavailable",
      };
    const rows = [...new Set(route.targets || [])]
      .map((fixtureId) => ({
        fixtureId,
        previous: lightingLab.previousState(fixtureId),
      }))
      .filter((row) => row.previous?.value);
    if (!rows.length)
      return {
        ok: false,
        scheduled: false,
        reason: "teach_preview_previous_state_unavailable",
      };
    const applied = await colorCommandService.applyColorText(hex, {
      mode: "direct",
      target: "both",
      targetExplicit: true,
      fixtureIds: rows.map((row) => row.fixtureId),
    });
    if (!applied?.ok || Number(applied.sent || 0) < 1)
      return {
        ok: false,
        scheduled: false,
        reason: applied?.error || "teach_preview_delivery_failed",
      };
    const guarded = rows.map((row) => ({
      ...row,
      expectedGeneration: Number(lightingLab.previousState(row.fixtureId)?.generation || 0),
    }));
    const timer = delay(() => {
      timers.delete(timer);
      void restore(guarded);
    }, durationMs);
    timer?.unref?.();
    timers.add(timer);
    return {
      ok: true,
      scheduled: true,
      targets: guarded.map((row) => row.fixtureId),
      durationMs,
    };
  }

  function shutdown() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  return Object.freeze({ preview, shutdown, _test: { restore } });
};
