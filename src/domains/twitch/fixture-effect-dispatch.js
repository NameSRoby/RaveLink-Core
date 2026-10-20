/**
 * Fixture effect dispatch.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#lighting-and-dynamic-effects
 */
// Keep at most one transport write and one replaceable pending frame per fixture.
module.exports = function createFixtureEffectDispatch({ isCurrent, dispatch, reportFault }) {
  const slots = new Map();
  function slotFor(id) {
    let slot = slots.get(id);
    if (!slot) {
      slot = { busy: false, next: null, barrier: null };
      slots.set(id, slot);
    }
    return slot;
  }
  function drain(id, slot) {
    if (slot.busy) return;
    slot.busy = true;
    const work = async () => {
      try {
        while (slot.next || slot.barrier) {
          if (slot.barrier) {
            const barrier = slot.barrier;
            slot.barrier = null;
            try {
              await barrier.action();
            } catch (error) {
              reportFault(error, "restore", id);
            } finally {
              barrier.resolve();
            }
            continue;
          }
          const job = slot.next;
          slot.next = null;
          if (!isCurrent(job.entry)) continue;
          try {
            await dispatch(job.entry.fixture, job.frame, job.transitionMs, job.entry);
          } catch (error) {
            reportFault(error, "dispatch", id);
          }
        }
      } finally {
        slot.busy = false;
        slots.delete(id);
      }
    };
    slot.work = work();
  }
  function dispatchLatest(entry, frame, transitionMs) {
    const id = entry.fixture.id,
      slot = slotFor(id);
    slot.next = { entry, frame, transitionMs };
    drain(id, slot);
  }
  // Restore belongs to the same transport queue as frames. Drop a superseded
  // pending restore, but let an already-started write finish before the next one.
  dispatchLatest.afterCurrent = (id, action) =>
    new Promise((resolve) => {
      const slot = slotFor(id);
      slot.barrier?.resolve();
      slot.next = null;
      slot.barrier = { action, resolve };
      drain(id, slot);
    });
  dispatchLatest.settled = (id) => slots.get(id)?.work || Promise.resolve();
  return dispatchLatest;
};

module.exports.nextDeadline = function (entry, at, cadence) {
  const origin = entry.startedAt;
  if (at < origin) return origin;
  return origin + (Math.floor((at - origin) / cadence) + 1) * cadence;
};
