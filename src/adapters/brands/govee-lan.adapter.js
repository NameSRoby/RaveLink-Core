// [TITLE] Module: adapters/brands/govee-lan.adapter.js
// [TITLE] Purpose: Govee LAN discovery, status, and whole-device light control

const dgram = require("node:dgram");
const os = require("node:os");

const DISCOVERY_HOST = "239.255.255.250";
const DISCOVERY_PORT = 4001;
const RESPONSE_PORT = 4002;
const CONTROL_PORT = 4003;

function ipv4(value) {
  const text = String(value || "").trim();
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(text)) return "";
  const parts = text.split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? text
    : "";
}

function bounded(value, maximum) {
  return String(value || "")
    .trim()
    .slice(0, maximum);
}
function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.min(max, Math.max(min, number))) : fallback;
}
function packet(cmd, data = {}) {
  return Buffer.from(JSON.stringify({ msg: { cmd, data } }), "utf8");
}
function validStatus(data) {
  const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  return (
    data &&
    integer(data.onOff, 0, 1) &&
    integer(data.brightness, 0, 100) &&
    data.color &&
    ["r", "g", "b"].every((key) => integer(data.color[key], 0, 255)) &&
    (data.colorTemInKelvin === undefined ||
      data.colorTemInKelvin === 0 ||
      integer(data.colorTemInKelvin, 2000, 9000))
  );
}

module.exports = function createGoveeLanAdapter(options = {}) {
  const dgramRef = options.dgramRef || dgram;
  const osRef = options.osRef || os;
  const dryRun = options.dryRun !== false;
  const log = options.log || console;
  const setTimeoutFn = options.setTimeout || setTimeout;
  let responseTail = Promise.resolve(),
    pendingReceivers = 0,
    stopped = false;
  const cancellations = new Set(),
    sendSockets = new Set();
  let sender = null;
  const stoppedResult = () => ({
    ok: false,
    reachable: false,
    devices: [],
    error: "govee_adapter_stopped",
  });
  function receive(work) {
    if (stopped) return Promise.resolve(stoppedResult());
    if (pendingReceivers >= 64)
      return Promise.resolve({
        ok: false,
        reachable: false,
        devices: [],
        error: "govee_receiver_busy",
      });
    pendingReceivers += 1;
    const result = responseTail
      .then(() => (stopped ? stoppedResult() : work()))
      .finally(() => {
        pendingReceivers -= 1;
      });
    responseTail = result.catch(() => {});
    return result;
  }
  let telemetry = {
    sent: 0,
    failed: 0,
    discoveries: 0,
    probes: 0,
    lastError: "",
    updatedAt: Date.now(),
  };

  function broadcastTargets() {
    const targets = new Set([DISCOVERY_HOST, "255.255.255.255"]);
    for (const rows of Object.values(osRef.networkInterfaces?.() || {}))
      for (const row of rows || []) {
        if (row?.family !== "IPv4" || row.internal) continue;
        const ip = ipv4(row.address),
          mask = ipv4(row.netmask);
        if (!ip || !mask) continue;
        const a = ip.split(".").map(Number),
          m = mask.split(".").map(Number);
        targets.add(a.map((part, index) => (part | (255 ^ m[index])) & 255).join("."));
      }
    return [...targets];
  }

  function normalizeScan(message, remote) {
    const data = message?.msg?.cmd === "scan" ? message.msg.data : null;
    const ip = ipv4(remote?.address);
    if (data?.ip !== undefined && ipv4(data.ip) !== ip) return null;
    const device = bounded(data?.device, 128),
      sku = bounded(data?.sku, 32).toUpperCase();
    return ip && device && /^H[A-Z0-9]{3,15}$/.test(sku)
      ? { ip, device, sku, name: `Govee ${sku}` }
      : null;
  }

  async function discoverDevices(input = {}) {
    const timeoutMs = clamp(input.timeoutMs, 300, 10000, 1800);
    if (!dgramRef?.createSocket)
      return {
        ok: false,
        error: "govee_discovery_transport_unavailable",
        devices: [],
      };
    const socket = dgramRef.createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map();
    return await new Promise((resolve) => {
      let settled = false,
        timer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cancellations.delete(cancel);
        try {
          socket.close();
        } catch {}
        resolve(result);
      };
      const cancel = () => finish(stoppedResult());
      cancellations.add(cancel);
      socket.on("error", (error) => {
        telemetry.lastError = bounded(error?.message, 160);
        finish({ ok: false, error: "govee_discovery_failed", devices: [] });
      });
      socket.on("message", (buffer, remote) => {
        if (buffer.length > 8192) return;
        try {
          const row = normalizeScan(JSON.parse(String(buffer)), remote);
          if (row && (found.has(row.device) || found.size < 32)) found.set(row.device, row);
        } catch {}
      });
      socket.bind(RESPONSE_PORT, "0.0.0.0", () => {
        if (settled) return;
        try {
          socket.setBroadcast(true);
          socket.addMembership?.(DISCOVERY_HOST);
        } catch {}
        const request = packet("scan", { account_topic: "reserve" });
        for (const host of broadcastTargets())
          try {
            socket.send(request, DISCOVERY_PORT, host);
          } catch {}
        if (settled) return;
        timer = setTimeoutFn(() => {
          telemetry.discoveries += 1;
          telemetry.updatedAt = Date.now();
          finish({
            ok: true,
            devices: [...found.values()].slice(0, 32),
            support: "lan-whole-device",
          });
        }, timeoutMs);
        timer?.unref?.();
      });
    });
  }

  function sendState(fixtures = [], state = {}, restoringNative = false) {
    const targets = Array.isArray(fixtures) ? fixtures : [];
    if (stopped) return { sent: 0, failed: targets.length, dryRun, error: "govee_adapter_stopped" };
    const on = state.on !== false;
    const commands = restoringNative ? [] : [packet("turn", { value: on ? 1 : 0 })];
    // Restore latent color/brightness while off without flashing the light on.
    if (restoringNative && !on) commands.push(packet("turn", { value: 0 }));
    if (on || restoringNative) {
      commands.push(
        packet("brightness", { value: clamp(state.dimming, restoringNative ? 0 : 1, 100, 100) }),
      );
      if ([state.r, state.g, state.b].every((value) => Number.isFinite(Number(value))))
        commands.push(
          packet("colorwc", {
            color: {
              r: clamp(state.r, 0, 255, 0),
              g: clamp(state.g, 0, 255, 0),
              b: clamp(state.b, 0, 255, 0),
            },
            colorTemInKelvin: 0,
          }),
        );
      else if (Number.isFinite(Number(state.temp)))
        commands.push(
          packet("colorwc", {
            color: { r: 0, g: 0, b: 0 },
            colorTemInKelvin: clamp(state.temp, 2000, 9000, 3500),
          }),
        );
    }
    if (restoringNative && on) commands.push(packet("turn", { value: 1 }));
    if (dryRun)
      return {
        sent: targets.length,
        failed: 0,
        dryRun: true,
        commandCount: commands.length,
      };
    const socket = sender || dgramRef.createSocket("udp4");
    const close = () => {
      cancellations.delete(close);
      sendSockets.delete(socket);
      if (sender === socket) sender = null;
      try {
        socket.close();
      } catch {}
    };
    if (!sender) {
      sender = socket;
      sendSockets.add(socket);
      cancellations.add(close);
      socket.on("error", (error) => {
        telemetry.failed += 1;
        telemetry.lastError = bounded(error?.code || "govee_send_failed", 160);
        telemetry.updatedAt = Date.now();
        close();
      });
    }
    let sent = 0,
      failed = 0;
    for (const fixture of targets) {
      const ip = ipv4(fixture?.ip);
      if (!ip) {
        failed += 1;
        continue;
      }
      try {
        for (const command of commands) socket.send(command, CONTROL_PORT, ip);
        sent += 1;
      } catch (error) {
        failed += 1;
        telemetry.lastError = bounded(error?.message, 160);
        log.warn("[GOVEE] LAN send failed");
      }
    }
    telemetry.sent += sent;
    telemetry.failed += failed;
    telemetry.updatedAt = Date.now();
    return { sent, failed, dryRun: false, commandCount: commands.length };
  }

  async function probeDevice(fixture = {}, input = {}) {
    const ip = ipv4(fixture.ip);
    if (!ip || !dgramRef?.createSocket)
      return {
        ok: false,
        reachable: false,
        error: ip ? "govee_probe_transport_unavailable" : "invalid_govee_target_ip",
      };
    const timeoutMs = clamp(input.timeoutMs, 300, 5000, 1400);
    const socket = dgramRef.createSocket({ type: "udp4", reuseAddr: true });
    return await new Promise((resolve) => {
      let settled = false,
        timer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cancellations.delete(cancel);
        if (timer) clearTimeout(timer);
        try {
          socket.close();
        } catch {}
        resolve(result);
      };
      const cancel = () => finish(stoppedResult());
      cancellations.add(cancel);
      socket.on("error", () =>
        finish({ ok: false, reachable: false, error: "govee_probe_failed" }),
      );
      socket.on("message", (buffer, remote) => {
        if (remote?.address !== ip || buffer.length > 8192) return;
        try {
          const message = JSON.parse(String(buffer));
          if (message?.msg?.cmd !== "devStatus") return;
          const data = message.msg.data;
          if (!validStatus(data)) return;
          telemetry.probes += 1;
          telemetry.updatedAt = Date.now();
          finish({
            ok: true,
            reachable: true,
            state: {
              on: data.onOff === 1,
              brightness: clamp(data.brightness, 0, 100, 0),
              color: { r: data.color.r, g: data.color.g, b: data.color.b },
              ...(data.colorTemInKelvin ? { temp: data.colorTemInKelvin } : {}),
            },
            support: "lan-whole-device",
          });
        } catch {}
      });
      socket.bind(RESPONSE_PORT, "0.0.0.0", () => {
        if (settled) return;
        try {
          socket.send(packet("devStatus"), CONTROL_PORT, ip);
        } catch {
          return finish({
            ok: false,
            reachable: false,
            error: "govee_probe_failed",
          });
        }
        timer = setTimeoutFn(
          () =>
            finish({
              ok: false,
              reachable: false,
              error: "govee_probe_timeout",
            }),
          timeoutMs,
        );
        timer?.unref?.();
      });
    });
  }

  async function readState(fixture, input) {
    const result = await probeDevice(fixture, input);
    if (!result.ok) return result;
    const { on, brightness, color, temp } = result.state;
    return {
      ok: true,
      state: { on, dimming: brightness, ...(temp ? { temp } : color) },
    };
  }

  async function restoreState(fixtures, state) {
    // Only the documented whole-device modes are restorable. LAN status does
    // not identify app scenes/segments; never fabricate those capabilities.
    const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
    if (
      !state ||
      typeof state.on !== "boolean" ||
      !integer(state.dimming, 0, 100) ||
      !(integer(state.temp, 2000, 9000) || ["r", "g", "b"].every((k) => integer(state[k], 0, 255)))
    )
      return { sent: 0, failed: fixtures.length, error: "invalid_govee_restore_state" };
    let sent = 0,
      failed = 0;
    for (const fixture of fixtures) {
      let verified = false;
      for (let attempt = 0; attempt < 2 && !stopped; attempt++) {
        const delivery = sendState([fixture], state, true);
        if (dryRun || delivery.failed) {
          verified = dryRun && delivery.failed === 0;
          break;
        }
        const actual = await readState(fixture, { timeoutMs: 500 });
        if (
          actual.ok &&
          Object.entries(state).every(([key, value]) => actual.state[key] === value)
        ) {
          verified = true;
          break;
        }
        if (attempt === 0 && !stopped)
          await new Promise((resolve) => {
            let timer;
            const finish = () => {
              clearTimeout(timer);
              cancellations.delete(finish);
              resolve();
            };
            cancellations.add(finish);
            timer = setTimeoutFn(finish, 100);
          });
      }
      if (verified) sent++;
      else failed++;
    }
    return { sent, failed, dryRun, ...(failed ? { error: "govee_restore_unverified" } : {}) };
  }

  function getTelemetry() {
    return {
      ok: true,
      source: "govee_lan",
      support: "lan-whole-device",
      transport: "udp_lan",
      ...telemetry,
      resources: {
        persistentSockets: sendSockets.size,
        responsePort: RESPONSE_PORT,
        controlPort: CONTROL_PORT,
        pendingReceivers,
        activeSends: sendSockets.size,
      },
    };
  }
  function reconcileFixtures() {
    return { ok: true };
  }
  function shutdown() {
    stopped = true;
    for (const cancel of [...cancellations]) cancel();
    for (const socket of sendSockets) {
      try {
        socket.close();
      } catch {}
    }
    sendSockets.clear();
    return { ok: true };
  }
  return Object.freeze({
    discoverDevices: (input) => receive(() => discoverDevices(input)),
    sendState,
    probeDevice: (fixture, input) => receive(() => probeDevice(fixture, input)),
    readState: (fixture, input) => receive(() => readState(fixture, input)),
    restoreState: (fixtures, state) => receive(() => restoreState(fixtures, state)),
    getTelemetry,
    reconcileFixtures,
    shutdown,
  });
};

module.exports.constants = {
  DISCOVERY_HOST,
  DISCOVERY_PORT,
  RESPONSE_PORT,
  CONTROL_PORT,
};
