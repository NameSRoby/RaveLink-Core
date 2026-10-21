const test = require("node:test"),
  assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const create = require("../src/adapters/brands/hue-dtls-handshake");
function environment() {
  const socket = new EventEmitter(),
    udp = new EventEmitter(),
    writes = [],
    pending = new Map();
  const controller = new AbortController();
  socket.udp = udp;
  const original = (udp.send = (message, ...args) => {
    writes.push(Buffer.from(message));
    if (typeof args.at(-1) === "function") args.at(-1)();
  });
  create(
    () => socket,
    { signal: controller.signal },
    {
      setTimeout(fn, delay) {
        pending.set(fn, delay);
        return fn;
      },
      clearTimeout(fn) {
        pending.delete(fn);
      },
    },
  );
  function packet(type = 22, handshake = 1, sequence = 1) {
    const buffer = Buffer.alloc(32);
    buffer[0] = type;
    buffer[13] = handshake;
    buffer.writeUInt16BE(sequence, 17);
    return buffer;
  }
  return {
    socket,
    udp,
    writes,
    pending,
    original,
    controller,
    packet,
    fire() {
      const [fn] = pending.keys();
      pending.delete(fn);
      fn();
    },
  };
}
test("only the cookie ClientHello is retransmitted unchanged, with bounded backoff", () => {
  const e = environment();
  e.udp.send(e.packet(22, 1, 0), 2100, "192.0.2.1");
  assert.equal(e.pending.size, 0, "initial hello has no cookie yet");
  const cookie = e.packet();
  let callbacks = 0;
  e.udp.send(cookie, 2100, "192.0.2.1", () => callbacks++);
  assert.deepEqual([...e.pending.values()], [1000]);
  e.udp.emit("message", e.packet(22, 3, 0));
  assert.equal(e.pending.size, 1, "HelloVerifyRequest does not erase the cookie flight");
  e.fire();
  assert.deepEqual([...e.pending.values()], [2000]);
  e.fire();
  assert.equal(e.pending.size, 0);
  assert.equal(e.writes.length, 4);
  assert(e.writes.slice(1).every((message) => message.equals(cookie)));
  assert.equal(callbacks, 1, "original send completion is not repeated");
  e.socket.emit("close");
});
test("server progress, connection, errors, close and abort clear handshake retry state", () => {
  for (const signal of ["server", "connected", "error", "close", "abort", "keyExchange"]) {
    const e = environment();
    e.socket.on("error", () => {});
    e.udp.send(e.packet(), 2100, "192.0.2.1");
    if (signal === "server") e.udp.emit("message", e.packet(22, 2, 1));
    else if (signal === "abort") e.controller.abort();
    else if (signal === "keyExchange") e.udp.send(e.packet(22, 16, 2), 2100, "192.0.2.1");
    else e.socket.emit(signal);
    assert.equal(e.pending.size, 0, signal);
    assert.equal(e.udp.send, e.original, signal);
    assert.equal(e.udp.listenerCount("message"), 0);
    e.udp.send(e.packet(23), 2100, "192.0.2.1");
    assert.equal(e.pending.size, 0, "application frames cannot start handshake retries");
    e.socket.emit("close");
  }
});
