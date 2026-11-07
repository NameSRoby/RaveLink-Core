/** Reviewed features may overlap background work with operator commands.
 * Wait for a broker slot once, within the original deadline; never retry writes.
 */
module.exports = function createCapabilityCallQueue({ limit, capacity }) {
  let active = 0,
    closed = false;
  const waiting = [];
  function drain() {
    while (!closed && active < limit && waiting.length) {
      const entry = waiting.shift();
      clearTimeout(entry.timer);
      const remaining = entry.deadline - Date.now();
      if (remaining <= 0) {
        entry.reject(new Error("request_deadline_exceeded"));
        continue;
      }
      active++;
      Promise.resolve()
        .then(() => entry.start(remaining))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  }
  return {
    run(start, timeoutMs) {
      if (closed) return Promise.reject(new Error("workload_shutdown"));
      if (active >= limit && waiting.length >= capacity)
        return Promise.reject(Object.assign(new Error("broker_busy"), { code: "broker_busy" }));
      return new Promise((resolve, reject) => {
        const entry = { start, resolve, reject, deadline: Date.now() + timeoutMs, timer: null };
        entry.timer = setTimeout(() => {
          const at = waiting.indexOf(entry);
          if (at >= 0) {
            waiting.splice(at, 1);
            reject(new Error("request_deadline_exceeded"));
          }
        }, timeoutMs);
        waiting.push(entry);
        drain();
      });
    },
    close() {
      closed = true;
      for (const entry of waiting.splice(0)) {
        clearTimeout(entry.timer);
        entry.reject(new Error("workload_shutdown"));
      }
    },
  };
};
