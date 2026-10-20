/** Temporary taught-color previews under the Core fixture broker.
 * Read native state through acquisition, then release the same token. A newer
 * effect or manual write invalidates it, so an old timer cannot restore stale
 * state. This path never consults lightingLab's last-command cache.
 */
module.exports = function createTaughtColorPreviewOutput({
  colorCommandService,
  directiveService,
  fixtureRegistry,
  outputOwnership,
  durationMs,
  delay,
  clearTimeout: cancel = clearTimeout,
}) {
  let closed = false;
  const owned = new Map(),
    pending = new Set();
  async function release(row) {
    cancel(row.timer);
    if (owned.get(row.id) === row) owned.delete(row.id);
    return outputOwnership.release(row.token);
  }
  async function run(hex) {
    if (closed) return { ok: false, scheduled: false, reason: "teach_preview_closed" };
    const route = await colorCommandService.applyColorText(hex, { preview: true });
    const directive = directiveService.parseTwitchColorDirective(hex);
    if (!route?.ok || !directive?.ok)
      return {
        ok: false,
        scheduled: false,
        reason: route?.error || "teach_preview_route_unavailable",
      };
    const fixtures = new Map(fixtureRegistry.getFixtures().map((row) => [row.id, row]));
    const rows = await Promise.all(
      [...new Set(route.targets || [])].map(async (id) => {
        let token;
        try {
          if (closed) return null;
          const grant = await outputOwnership.replaceOwned({
            fixtureId: id,
            owner: "core.effects",
            kind: "effect",
            ttlMs: durationMs + 2000,
          });
          token = grant.token;
          if (closed) {
            await outputOwnership.release(token);
            return null;
          }
          const state = fixtures.get(id)?.brand === "hue" ? directive.hueState : directive.wizState;
          const result = await outputOwnership.write(token, state);
          if (result.sent !== 1) throw new Error("teach_preview_delivery_failed");
          // Do not retain replaced timers for repeated previews of the same bulb.
          const previous = owned.get(id);
          if (previous) cancel(previous.timer);
          const row = { id, token, timer: null };
          owned.set(id, row);
          if (closed) {
            await release(row);
            return null;
          }
          row.timer = delay(() => {
            void release(row).catch(() => {});
          }, durationMs);
          row.timer?.unref?.();
          return id;
        } catch {
          if (token) await outputOwnership.release(token);
          return null;
        }
      }),
    );
    const targets = rows.filter(Boolean);
    return {
      ok: targets.length > 0,
      scheduled: targets.length > 0,
      targets,
      durationMs,
      failed: rows.length - targets.length,
      ...(!targets.length ? { reason: "teach_preview_native_state_or_delivery_unavailable" } : {}),
    };
  }
  function preview(hex) {
    const task = run(hex);
    pending.add(task);
    task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }
  async function shutdown() {
    closed = true;
    await Promise.allSettled([...pending]);
    await Promise.allSettled([...owned.values()].map(release));
  }
  return Object.freeze({ preview, shutdown });
};
