/** A visible deck shares one Core status feed with other local/LAN screens. */
export function createDeckFeed({ request, visible, receive, offline }) {
  let source,
    timer,
    flight,
    instance,
    version = -1,
    closed = false;
  function accept(frame) {
    if (!frame || !Number.isSafeInteger(frame.version) || !frame.value) return;
    if (frame.instance === instance && frame.version < version) return;
    instance = frame.instance;
    version = frame.version;
    receive(frame.value);
  }
  function stop() {
    clearTimeout(timer);
    source?.close();
    source = null;
  }
  function connect() {
    if (closed || !visible()) {
      stop();
      return;
    }
    if (source || typeof EventSource === "undefined") return;
    source = new EventSource("/api/control-deck/events");
    source.onmessage = (event) => {
      try {
        accept(JSON.parse(event.data));
      } catch {}
    };
    source.onerror = () => {
      stop();
      offline();
      timer = setTimeout(() => void refresh(), 1500);
    };
  }
  async function refresh(force = false) {
    if (closed || (!force && !visible())) {
      stop();
      return;
    }
    connect();
    if (flight) return flight;
    flight = request("/api/control-deck/state")
      .then(accept)
      .catch(() => offline())
      .finally(() => {
        flight = null;
        if (!source && visible() && !closed) timer = setTimeout(() => void refresh(), 2000);
      });
    return flight;
  }
  return {
    refresh,
    sync: connect,
    close() {
      closed = true;
      stop();
    },
    resume() {
      closed = false;
      connect();
    },
  };
}
