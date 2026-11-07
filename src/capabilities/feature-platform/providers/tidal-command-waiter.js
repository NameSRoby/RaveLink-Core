/** One authenticated renderer can wait without polling until a command arrives. */
module.exports = function commandWaiter({ poll, takeCommand, isStopped }) {
  let pending = null;
  const fail = (error) => ({ ok: false, error });
  function wait(input = {}, signal) {
    if (signal?.aborted) return Promise.resolve(fail("tidal_poll_cancelled"));
    if (pending) return Promise.resolve(fail("tidal_poll_busy"));
    const initial = poll(input);
    if (!initial.ok || initial.command || input.waitMs !== 1500)
      return Promise.resolve({ ...initial, waitSupported: true });
    return new Promise((resolve) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        pending = null;
        resolve({
          ...(isStopped() || signal?.aborted ? fail("tidal_poll_cancelled") : takeCommand()),
          waitSupported: true,
        });
      };
      pending = finish;
      timer = setTimeout(finish, 1500);
      timer.unref?.();
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
  return { wait, notify: () => pending?.() };
};
