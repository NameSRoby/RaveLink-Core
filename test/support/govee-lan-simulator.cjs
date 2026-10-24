/** Stateful Govee LAN peer for protocol tests, never a production device backend.
 * Uses real UDP on isolated loopback ports. The adapter-facing transport rewrites
 * only ports/discovery destinations so tests cannot broadcast onto a real LAN.
 * Whole-device turn/brightness/colorwc/devStatus/scan follow the Govee LAN guide:
 * https://app-h5.govee.com/user-manual/wlan-guide
 * SKU labels are test data, not claims of hardware/model compatibility.
 */
const dgram = require("node:dgram");
const { EventEmitter } = require("node:events");

const clone = (value) => JSON.parse(JSON.stringify(value));
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const rgb = (value) => value && ["r", "g", "b"].every((key) => integer(value[key], 0, 255));

async function createSimulator(options = {}) {
  const events = new EventEmitter();
  const peers = new Map();
  const sockets = new Set();
  const timers = new Set();
  const history = [];
  let responsePort = options.responsePort || 0;
  let closed = false;
  const definitions = options.devices || [
    { id: "sim-govee-rgbw", ip: "127.0.0.101", sku: "H6008", temperature: true },
    { id: "sim-govee-rgb", ip: "127.0.0.102", sku: "H6008", temperature: false },
  ];
  const bind = (host, port = 0) =>
    new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      sockets.add(socket);
      socket.once("error", reject);
      socket.bind(port, host, () => resolve(socket));
    });
  const later = (work, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closed) work();
    }, ms);
    timers.add(timer);
  };
  function reply(peer, value) {
    if (closed || peer.faults.offline || peer.faults.dropReplies || !responsePort) return;
    const bytes = Buffer.from(peer.faults.malformed ? "{invalid-json" : JSON.stringify(value));
    const destination = responsePort;
    later(() => {
      const sender = peers.get(peer.faults.sourceIp)?.socket || peer.socket;
      sender.send(bytes, destination, "127.0.0.1");
      if (peer.faults.duplicate) sender.send(bytes, destination, "127.0.0.1");
    }, peer.faults.delayMs || 0);
  }
  function handle(peer, bytes, remote) {
    let msg;
    try {
      msg = JSON.parse(String(bytes)).msg;
    } catch {
      return;
    }
    if (!msg || typeof msg.cmd !== "string") return;
    const entry = {
      device: peer.id,
      command: msg.cmd,
      data: clone(msg.data || {}),
      accepted: false,
    };
    history.push(entry);
    if (peer.faults.offline) return;
    if (peer.faults.dropCommands?.includes(msg.cmd)) return;
    if (msg.cmd !== "devStatus" && peer.faults.dropNextCommands > 0) {
      peer.faults.dropNextCommands--;
      return;
    }
    const data = msg.data || {};
    switch (msg.cmd) {
      case "turn":
        if (!integer(data.value, 0, 1)) break;
        peer.state.onOff = data.value;
        entry.accepted = true;
        break;
      case "brightness":
        if (!integer(data.value, 0, 100)) break;
        peer.state.brightness = data.value;
        entry.accepted = true;
        break;
      case "colorwc":
        if (!rgb(data.color) || !integer(data.colorTemInKelvin, 0, 9000)) break;
        if (data.colorTemInKelvin && (!peer.temperature || data.colorTemInKelvin < 2000)) break;
        peer.state.color = clone(data.color);
        peer.state.colorTemInKelvin = data.colorTemInKelvin;
        entry.accepted = true;
        break;
      case "devStatus":
        entry.accepted = true;
        reply(peer, {
          msg: { cmd: "devStatus", data: peer.faults.statusOverride ?? clone(peer.state) },
        });
        break;
      default:
        // Segments, scenes and effects are deliberately not invented LAN capabilities.
        break;
    }
    events.emit("command", entry, remote);
  }
  for (const [index, definition] of definitions.entries()) {
    if (!/^127\./.test(definition.ip))
      throw new Error("Simulator fixtures must use loopback addresses");
    const peer = {
      ...definition,
      device: `SIMULATED:GOVEE:${index + 1}`,
      state: {
        onOff: 1,
        brightness: 37,
        color: { r: 25, g: 90, b: 160 },
        colorTemInKelvin: 0,
        ...clone(definition.state || {}),
      },
      faults: {},
      socket: await bind(definition.ip, options.controlPort || 0),
    };
    peers.set(peer.ip, peer);
    peer.socket.on("message", (bytes, remote) => handle(peer, bytes, remote));
  }
  const discovery = await bind("127.0.0.1", options.discoveryPort || 0);
  discovery.on("message", (bytes) => {
    try {
      if (JSON.parse(String(bytes)).msg?.cmd !== "scan") return;
    } catch {
      return;
    }
    for (const peer of peers.values())
      reply(peer, {
        msg: {
          cmd: "scan",
          data: peer.faults.scanOverride || { ip: peer.ip, device: peer.device, sku: peer.sku },
        },
      });
  });
  const transport = {
    createSocket(settings) {
      const raw = dgram.createSocket(settings);
      const socket = new EventEmitter();
      sockets.add(raw);
      raw.on("message", (...args) => socket.emit("message", ...args));
      raw.on("error", (error) => socket.emit("error", error));
      raw.once("close", () => {
        sockets.delete(raw);
        socket.emit("close");
      });
      socket.bind = (_port, _host, callback) => {
        return raw.bind(0, "127.0.0.1", () => {
          responsePort = raw.address().port;
          callback();
        });
      };
      socket.send = (bytes, port, host) => {
        if (port === 4001) return raw.send(bytes, discovery.address().port, "127.0.0.1");
        const peer = peers.get(host);
        if (port !== 4003 || !peer)
          throw new Error("Simulator transport blocked a non-fixture destination");
        return raw.send(bytes, peer.socket.address().port, host);
      };
      socket.close = () => raw.close();
      socket.setBroadcast = (enabled) => raw.setBroadcast(enabled);
      socket.addMembership = () => {};
      return socket;
    },
  };
  return {
    transport,
    fixtures: () => [...peers.values()].map(({ id, ip, sku }) => ({ id, ip, sku, brand: "govee" })),
    snapshot: (id) => clone([...peers.values()].find((peer) => peer.id === id)?.state),
    history: () => clone(history),
    faults(id, patch) {
      Object.assign([...peers.values()].find((peer) => peer.id === id).faults, patch);
    },
    async waitFor(predicate, timeoutMs = 1500) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Simulator command deadline exceeded");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {}
      }
      sockets.clear();
    },
  };
}
module.exports = { createSimulator };

if (require.main === module && process.argv[2] === "--serve") {
  createSimulator({ controlPort: 4003, discoveryPort: 4001, responsePort: 4002 })
    .then((simulator) => {
      console.log(
        "Simulated Govee peers on loopback only; add these addresses manually in an isolated Core test installation:",
      );
      console.log(JSON.stringify(simulator.fixtures(), null, 2));
      process.on("SIGINT", () => {
        void simulator.close();
      });
      process.on("SIGTERM", () => {
        void simulator.close();
      });
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
