/** Reference-count one native app capture across continuous and temporary music.
 * Timed consumers have independent deadlines; null means operator-owned until Stop.
 * Ending the shorter consumer cannot
 * cut off a song-length Rave; the last release waits for confirmed native exit.
 * No raw capture is created without a first consumer, and no idle lease exists.
 */
module.exports = function createSharedCapture(
  native,
  { schedule = setTimeout, cancel = clearTimeout } = {},
) {
  let current = null;
  function acquire(id, seconds) {
    if (seconds !== null && (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600))
      throw Object.assign(Error("invalid_duration"), { code: "invalid_duration" });
    if (current && (current.id !== id || current.closing))
      throw Object.assign(Error("music_capture_busy"), { code: "music_capture_busy" });
    if (!current) {
      // Joining continuous consumers must not inherit a timed root's deadline.
      // The last lease closes its private control pipe and awaits confirmed exit.
      const root = native.capture(id, { seconds: 0 });
      const entry = { id, root, leases: new Set(), closing: false };
      current = entry;
      const ended = (result, error) => {
        if (current === entry) current = null;
        for (const lease of [...entry.leases]) lease.end(result, error);
      };
      root.done.then(
        (r) => ended(r),
        (e) => ended(null, e),
      );
    }
    const entry = current;
    let finish,
      reject,
      closed = false,
      timer;
    const done = new Promise((r, j) => {
      finish = r;
      reject = j;
    });
    const lease = {
      end(result, error) {
        if (closed) return;
        closed = true;
        cancel(timer);
        entry.leases.delete(lease);
        if (!entry.leases.size && current === entry) {
          entry.closing = true;
          entry.root.stop();
          entry.root.done.then(() => (error ? reject(error) : finish(result)), reject);
        } else if (error) reject(error);
        else finish(result);
      },
    };
    entry.leases.add(lease);
    if (seconds !== null) {
      timer = schedule(() => lease.end({ reason: "consumer_deadline" }), seconds * 1000);
      timer.unref?.();
    }
    return {
      events: entry.root.events,
      snapshot: () => entry.root.snapshot(),
      done,
      stop: () => lease.end({ reason: "parent_stop" }),
    };
  }
  return { acquire, active: () => !!current };
};
