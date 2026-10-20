/** One actual operation and one replaceable pending operation per fixture.
 * Timing out a caller DOES NOT mean its transport stopped. Keep that lane busy
 * until the actual operation settles, so a late write cannot race a newer one.
 */
module.exports = function createFixtureOutputQueue({ maximum = 128, timeoutMs = 2000 } = {}) {
  const lanes = new Map();
  const fault = (code) => Object.assign(new Error(code), { code });
  function drain(id, lane) {
    if (lane.busy || !lane.pending) return;
    const job = lane.pending;
    lane.pending = null;
    lane.busy = true;
    Promise.resolve()
      .then(() => {
        if (performance.now() > job.deadline) throw fault("fixture_output_timeout");
        return job.guard() ? job.action() : { suppressed: true };
      })
      .then(
        (value) => job.finish(null, value),
        (error) => job.finish(error),
      )
      .finally(() => {
        lane.busy = false;
        if (lane.pending) drain(id, lane);
        else if (lanes.get(id) === lane) lanes.delete(id);
      });
  }
  function submit(id, action, guard = () => true) {
    let lane = lanes.get(id);
    if (!lane) {
      if (lanes.size >= maximum) return Promise.reject(fault("fixture_output_limit"));
      lane = { busy: false, pending: null };
      lanes.set(id, lane);
    }
    lane.pending?.finish(null, { suppressed: true });
    return new Promise((resolve, reject) => {
      let settled = false;
      const job = {
        action,
        guard,
        deadline: performance.now() + timeoutMs,
        finish(error, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (lane.pending === job) lane.pending = null;
          if (error) reject(error);
          else resolve(value);
        },
      };
      const timer = setTimeout(() => job.finish(fault("fixture_output_timeout")), timeoutMs);
      timer.unref?.();
      lane.pending = job;
      drain(id, lane);
    });
  }
  return {
    submit,
    snapshot: () => ({
      lanes: lanes.size,
      busy: [...lanes.values()].filter((l) => l.busy).length,
      pending: [...lanes.values()].filter((l) => l.pending).length,
    }),
  };
};
