const test = require("node:test");
const assert = require("node:assert/strict");

const createGoveeLanAdapter = require("../src/adapters/brands/govee-lan.adapter");

function fakeDgram(onSend) {
  const sockets = [];
  return {
    sockets,
    createSocket() {
      const handlers = {};
      const socket = {
        closed: false,
        sent: [],
        on(name, handler) { handlers[name] = handler; return socket; },
        bind(port, host, callback) { socket.bound = { port, host }; queueMicrotask(callback); },
        setBroadcast() {},
        addMembership() {},
        send(buffer, port, host) {
          const message = JSON.parse(String(buffer));
          socket.sent.push({ message, port, host });
          onSend?.({ socket, handlers, message, port, host });
        },
        close() { socket.closed = true; }
      };
      sockets.push(socket);
      return socket;
    }
  };
}

test("Govee alpha discovery uses the documented LAN ports and rejects malformed replies", async () => {
  const transport = fakeDgram(({ handlers, message }) => {
    if (message.msg.cmd !== "scan") return;
    queueMicrotask(() => {
      handlers.message?.(Buffer.from(JSON.stringify({ msg: { cmd: "scan", data: { ip: "192.168.1.44", device: "AA:BB:CC:DD", sku: "H6008" } } })), { address: "192.168.1.44" });
      handlers.message?.(Buffer.from('{"msg":{"cmd":"scan","data":{"ip":"bad","sku":"oops"}}}'), { address: "bad" });
    });
  });
  const adapter = createGoveeLanAdapter({
    dgramRef: transport,
    osRef: { networkInterfaces: () => ({ lan: [{ family: "IPv4", internal: false, address: "192.168.1.10", netmask: "255.255.255.0" }] }) },
    setTimeout: callback => { const timer = setTimeout(callback, 5); return timer; }
  });

  const result = await adapter.discoverDevices({ timeoutMs: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.alpha, true);
  assert.deepEqual(result.devices, [{ ip: "192.168.1.44", device: "AA:BB:CC:DD", sku: "H6008", name: "Govee H6008" }]);
  assert.equal(transport.sockets[0].bound.port, 4002);
  assert.ok(transport.sockets[0].sent.every(row => row.port === 4001));
  assert.ok(transport.sockets[0].sent.some(row => row.host === "239.255.255.250"));
  assert.ok(transport.sockets[0].sent.some(row => row.host === "192.168.1.255"));
});

test("Govee alpha control sends power, brightness, and whole-device RGB over UDP 4003", () => {
  const transport = fakeDgram();
  const adapter = createGoveeLanAdapter({ dgramRef: transport, dryRun: false, setTimeout: () => ({ unref() {} }), log: { warn() {} } });

  const result = adapter.sendState([{ id: "desk", ip: "192.168.1.44" }], { on: true, dimming: 63, r: 12, g: 34, b: 56 });
  assert.deepEqual({ sent: result.sent, failed: result.failed, commandCount: result.commandCount }, { sent: 1, failed: 0, commandCount: 3 });
  assert.ok(transport.sockets[0].sent.every(row => row.port === 4003 && row.host === "192.168.1.44"));
  assert.deepEqual(transport.sockets[0].sent.map(row => row.message.msg), [
    { cmd: "turn", data: { value: 1 } },
    { cmd: "brightness", data: { value: 63 } },
    { cmd: "colorwc", data: { color: { r: 12, g: 34, b: 56 }, colorTemInKelvin: 0 } }
  ]);
});

test("Govee alpha control does not send to an invalid target address", () => {
  const transport = fakeDgram();
  const adapter = createGoveeLanAdapter({ dgramRef: transport, dryRun: false, setTimeout: () => ({ unref() {} }), log: { warn() {} } });
  const result = adapter.sendState([{ id: "bad", ip: "example.com" }], { on: false });
  assert.deepEqual({ sent: result.sent, failed: result.failed }, { sent: 0, failed: 1 });
  assert.equal(transport.sockets[0].sent.length, 0);
});
