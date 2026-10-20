/** Restore captured fixture state through the same queue as effect frames.
 * Generation checks prevent delayed returns from overwriting a newer command.
 * Keep the original baseline available while an animated return is pending.
 */
module.exports = function createEffectRestoration({
  outputOwnership,
  adapters,
  lightingLayout,
  active,
  restoring,
  restoreGenerations,
  later,
  dispatch,
  dispatchLatest,
  returnEffect,
}) {
  return async function restore(entry, options = {}) {
    const shouldRestore =
      options.restore !== false &&
      (options.force === true || returnEffect() || entry?.settings?.restorePrevious === true);
    if (outputOwnership) {
      // Stop may arrive during baseline capture. Await that reservation before
      // releasing its token; replacement/manual takeover already fence it.
      try {
        await entry.baseline;
      } catch {
        return;
      }
      if (!outputOwnership.has(entry.leaseToken)) return;
      if (!shouldRestore) return outputOwnership.release(entry.leaseToken, { restore: false });
    }
    if (!shouldRestore || !entry?.previousState?.value) return;
    restoring.set(entry.fixture.id, entry.previousState);
    const adapter = adapters[String(entry.fixture.brand).toLowerCase()];
    const generation = Number(restoreGenerations.get(entry.fixture.id) || 0) + 1;
    restoreGenerations.set(entry.fixture.id, generation);
    const finish = () =>
      dispatchLatest.afterCurrent(entry.fixture.id, async () => {
        if (active.has(entry.fixture.id) || restoreGenerations.get(entry.fixture.id) !== generation)
          return;
        const result = outputOwnership
          ? await outputOwnership.release(entry.leaseToken)
          : adapter?.restoreState
            ? await adapter.restoreState([entry.fixture], entry.previousState.value)
            : await adapter?.sendState?.([entry.fixture], entry.previousState.value);
        if (result?.failed > 0)
          throw Object.assign(Error("effect_restore_failed"), { code: "effect_restore_failed" });
        if (restoreGenerations.get(entry.fixture.id) === generation)
          restoring.delete(entry.fixture.id);
      });
    if (!returnEffect() || options.animate === false || !entry.lastFrame) return finish();
    const offset =
      lightingLayout?.spatialOffset?.(
        entry.fixture.id,
        "sweep",
        entry.fixtureIndex,
        entry.fixtureCount,
        entry.settings,
      ) ?? entry.fixtureIndex / Math.max(1, entry.fixtureCount - 1);
    later(entry.fixture.id, generation, Math.max(0, Math.min(1, offset)) * 240, async () => {
      try {
        await dispatchLatest.afterCurrent(entry.fixture.id, () => {
          if (
            active.has(entry.fixture.id) ||
            restoreGenerations.get(entry.fixture.id) !== generation
          )
            return;
          return dispatch(
            entry.fixture,
            {
              rgb: entry.lastFrame.rgb,
              brightness: Math.min(18, entry.lastFrame.brightness),
            },
            120,
            entry,
          );
        });
      } catch {}
      later(entry.fixture.id, generation, 180, finish);
    });
  };
};
