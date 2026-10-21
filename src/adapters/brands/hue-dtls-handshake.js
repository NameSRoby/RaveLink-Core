/** node-dtls-client 1.1.1 has no handshake-flight retransmission. Hue can
 * answer HelloVerifyRequest then lose the cookie ClientHello. Retransmit only
 * that unauthenticated flight, unchanged, at 1 s then 2 s. Never replay color
 * data or the PSK exchange. The runtime's existing deadline still bounds setup.
 */
module.exports = function createHueDtlsSocket(factory, options, timers = {}) {
  const socket = factory(options),
    udp = socket.udp;
  if (!udp?.send || !udp.on) return socket;
  const schedule = timers.setTimeout || setTimeout;
  const cancel = timers.clearTimeout || clearTimeout;
  const original = udp.send,
    send = original.bind(udp);
  let timer,
    flight,
    destination,
    attempts = 0,
    finished = false;
  function clear() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    flight = destination = undefined;
  }
  function finish() {
    finished = true;
    clear();
    udp.removeListener("message", received);
    if (udp.send === trackedSend) udp.send = original;
  }
  function retry() {
    timer = undefined;
    if (finished || !flight) return;
    try {
      send(flight, ...destination, () => {});
    } catch {
      finish();
      return;
    }
    attempts++;
    if (attempts < 2) {
      timer = schedule(retry, 2000);
      timer?.unref?.();
    }
  }
  function received(message) {
    if (!Buffer.isBuffer(message) || message.length < 14) return;
    // Library listeners may have already sent the key-exchange flight by now.
    // Ignore HelloVerifyRequest itself; it creates the flight being retained.
    if (message[0] === 21 || (message[0] === 22 && message[13] !== 3)) finish();
  }
  function trackedSend(message, ...args) {
    if (!finished && Buffer.isBuffer(message) && message.length >= 25) {
      if (
        message[0] === 22 &&
        message.readUInt16BE(3) === 0 &&
        message[13] === 1 &&
        message.readUInt16BE(17) > 0
      ) {
        clear();
        flight = Buffer.from(message);
        destination = args.filter((arg) => typeof arg !== "function");
        attempts = 0;
        timer = schedule(retry, 1000);
        timer?.unref?.();
      } else if (message[0] === 21 || (message[0] === 22 && message[13] !== 1)) finish();
    }
    return send(message, ...args);
  }
  udp.send = trackedSend;
  udp.on("message", received);
  socket.once("connected", finish);
  socket.once("error", finish);
  socket.once("close", finish);
  options.signal?.addEventListener("abort", finish, { once: true });
  socket.once("close", () => options.signal?.removeEventListener("abort", finish));
  return socket;
};
