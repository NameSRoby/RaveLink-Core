/** One shared refresh loop for visible decks; unchanged views produce no traffic. */
const crypto = require("node:crypto");
module.exports = function createDeckLive({ read, refresh, subscribe, intervalMs = 500 }) {
  const instance = crypto.randomBytes(8).toString("hex"),
    listeners = new Set();
  let timer,
    scheduled,
    last = "",
    frame = "",
    published = "",
    version = 0,
    closed = false;
  function current() {
    const data = JSON.stringify(read(), (key, value) => (key === "updatedAt" ? undefined : value));
    if (data !== last) {
      last = data;
      frame =
        '{"instance":' +
        JSON.stringify(instance) +
        ',"version":' +
        ++version +
        ',"value":' +
        data +
        "}";
    }
    return frame;
  }
  function publish() {
    scheduled = undefined;
    if (closed || !listeners.size) return;
    const next = current();
    if (published !== next) {
      published = next;
      for (const listener of listeners) listener(next);
    }
  }
  function changed() {
    if (!closed && listeners.size && !scheduled) {
      scheduled = setTimeout(publish, 16);
      scheduled.unref?.();
    }
  }
  function tick() {
    if (closed || !listeners.size) return;
    Promise.resolve().then(refresh).then(changed, changed);
    changed();
  }
  const unsubscribe = subscribe?.(changed);
  function listen(listener) {
    if (closed) throw Error("control_deck_closed");
    if (listeners.size >= 16)
      throw Object.assign(Error("control_deck_stream_busy"), { code: "control_deck_stream_busy" });
    listeners.add(listener);
    if (listeners.size === 1) published = current();
    listener(current());
    if (!timer) {
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      tick();
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (!listeners.size) {
        clearInterval(timer);
        clearTimeout(scheduled);
        timer = scheduled = undefined;
      }
    };
  }
  return {
    current,
    changed,
    listen,
    close() {
      closed = true;
      clearInterval(timer);
      clearTimeout(scheduled);
      unsubscribe?.();
      for (const listener of listeners) listener(null);
      listeners.clear();
    },
  };
};
