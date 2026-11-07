/** OBS WebSocket 5 / RPC 1. One authenticated socket; writes are never replayed. */
const crypto = require("node:crypto");
const fault = (code) => Object.assign(Error(code), { code });
module.exports = function createObsClient({
  WebSocketImpl = globalThis.WebSocket,
  changed = () => {},
  event = () => {},
  timeoutMs = 4000,
} = {}) {
  let socket,
    ready = false,
    closed = false,
    desired = null,
    retry,
    handshake,
    attempt = 0,
    sequence = 0,
    connectFlight;
  let lastError = "obs_not_connected";
  const pending = new Map();
  const status = () => ({
    connected: ready,
    connecting: !!socket && !ready,
    code: ready ? "obs_connected" : lastError,
  });
  function fail(code, worker = socket) {
    if (worker !== socket) return;
    socket = null;
    ready = false;
    lastError = code;
    clearTimeout(handshake);
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(fault(code));
    }
    pending.clear();
    connectFlight?.reject(fault(code));
    connectFlight = null;
    try {
      worker?.close();
    } catch {}
    changed();
    if (
      desired &&
      !closed &&
      code !== "obs_authentication_failed" &&
      code !== "obs_protocol_unsupported"
    ) {
      clearTimeout(retry);
      retry = setTimeout(
        () => {
          retry = null;
          void open().catch(() => {});
        },
        Math.min(15000, 500 * 2 ** Math.min(attempt++, 5)),
      );
      retry.unref?.();
    }
  }
  function send(data) {
    socket.send(JSON.stringify(data));
  }
  function message(worker, raw) {
    if (worker !== socket) return;
    try {
      if (typeof raw !== "string" || Buffer.byteLength(raw) > 2 * 1024 * 1024)
        throw fault("obs_response_invalid");
      const { op, d } = JSON.parse(raw);
      if (op === 0) {
        if (!d || d.rpcVersion < 1) throw fault("obs_protocol_unsupported");
        // Ordinary scene/input/filter/output/UI events; no meters, media ticks or vendor traffic.
        const identify = { rpcVersion: 1, eventSubscriptions: 1279 };
        if (d.authentication) {
          const { salt, challenge } = d.authentication;
          if (
            typeof salt !== "string" ||
            typeof challenge !== "string" ||
            salt.length > 1024 ||
            challenge.length > 1024
          )
            throw fault("obs_response_invalid");
          const secret = crypto
            .createHash("sha256")
            .update(desired.password + salt)
            .digest("base64");
          identify.authentication = crypto
            .createHash("sha256")
            .update(secret + challenge)
            .digest("base64");
        }
        send({ op: 1, d: identify });
      } else if (op === 2) {
        ready = true;
        lastError = "";
        attempt = 0;
        clearTimeout(handshake);
        connectFlight?.resolve(status());
        connectFlight = null;
        changed();
      } else if (op === 7) {
        const job = pending.get(d?.requestId);
        if (!job) return;
        pending.delete(d.requestId);
        clearTimeout(job.timer);
        if (d.requestType !== job.type) job.reject(fault("obs_response_invalid"));
        else if (d.requestStatus?.result) job.resolve(d.responseData || {});
        else
          job.reject(
            Object.assign(fault("obs_request_rejected"), {
              obsCode: Number(d.requestStatus?.code) || 0,
            }),
          );
      } else if (op === 5 && ready && typeof d?.eventType === "string")
        event(d.eventType, d.eventData || {});
    } catch (error) {
      fail(error.code || "obs_response_invalid", worker);
    }
  }
  function open() {
    if (closed || !desired) return Promise.reject(fault("obs_not_connected"));
    if (ready) return Promise.resolve(status());
    if (connectFlight) return connectFlight.promise;
    const flight = {};
    flight.promise = new Promise((resolve, reject) => {
      flight.resolve = resolve;
      flight.reject = reject;
    });
    connectFlight = flight;
    try {
      const worker = new WebSocketImpl(
        "ws://" + desired.host + ":" + desired.port,
        "obswebsocket.json",
      );
      socket = worker;
      lastError = "obs_connecting";
      worker.addEventListener("message", (e) => message(worker, e.data));
      worker.addEventListener("error", () => fail("obs_connection_failed", worker));
      worker.addEventListener("close", (e) =>
        fail(
          e.code === 4009
            ? "obs_authentication_failed"
            : e.code === 4010
              ? "obs_protocol_unsupported"
              : "obs_disconnected",
          worker,
        ),
      );
      handshake = setTimeout(() => fail("obs_connection_timeout", worker), timeoutMs);
      handshake.unref?.();
      changed();
    } catch {
      fail("obs_connection_failed");
    }
    return flight.promise;
  }
  function disconnect() {
    desired = null;
    clearTimeout(retry);
    retry = null;
    fail("obs_not_connected");
  }
  return {
    status,
    connect(config) {
      disconnect();
      desired = { ...config };
      return open();
    },
    async request(type, data = {}) {
      if (!ready) throw fault("obs_not_connected");
      if (pending.size >= 32) throw fault("obs_busy");
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(fault("obs_request_timeout"));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { type, resolve, reject, timer });
        try {
          send({ op: 6, d: { requestType: type, requestId: id, requestData: data } });
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          reject(fault("obs_disconnected"));
        }
      });
    },
    disconnect,
    close() {
      closed = true;
      disconnect();
    },
  };
};
