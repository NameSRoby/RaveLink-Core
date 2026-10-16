// Keep at most one transport write and one replaceable pending frame per fixture.
module.exports = function createFixtureEffectDispatch({ isCurrent, dispatch, reportFault }) {
  const slots = new Map();
  return function dispatchLatest(entry, frame, transitionMs) {
    const id = entry.fixture.id;
    let slot = slots.get(id);
    if (!slot) { slot = { busy: false, next: null }; slots.set(id, slot); }
    slot.next = { entry, frame, transitionMs };
    if (slot.busy) return;
    slot.busy = true;
    const drain = async () => {
      try {
        while (slot.next) {
          const job = slot.next; slot.next = null;
          if (!isCurrent(job.entry)) continue;
          try { await dispatch(job.entry.fixture, job.frame, job.transitionMs); }
          catch (error) { reportFault(error, 'dispatch', id); }
        }
      } finally { slot.busy = false; slots.delete(id); }
    };
    void drain();
  };
};
