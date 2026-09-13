// [TITLE] Module: adapters/brands/govee-lan.adapter.js
// [TITLE] Purpose: alpha Govee LAN discovery, status, and whole-device light control

const dgram = require("node:dgram");
const os = require("node:os");

const DISCOVERY_HOST = "239.255.255.250";
const DISCOVERY_PORT = 4001;
const RESPONSE_PORT = 4002;
const CONTROL_PORT = 4003;

function ipv4(value) {
  const text = String(value || "").trim();
  const parts = text.split(".").map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? text : "";
}

function bounded(value, maximum) { return String(value || "").trim().slice(0, maximum); }
function clamp(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.round(Math.min(max, Math.max(min, number))) : fallback; }
function packet(cmd, data = {}) { return Buffer.from(JSON.stringify({ msg: { cmd, data } }), "utf8"); }

module.exports = function createGoveeLanAdapter(options = {}) {
  const dgramRef = options.dgramRef || dgram;
  const osRef = options.osRef || os;
  const dryRun = options.dryRun !== false;
  const log = options.log || console;
  const setTimeoutFn = options.setTimeout || setTimeout;
  let telemetry = { sent: 0, failed: 0, discoveries: 0, probes: 0, lastError: "", updatedAt: Date.now() };

  function broadcastTargets() {
    const targets = new Set([DISCOVERY_HOST, "255.255.255.255"]);
    for (const rows of Object.values(osRef.networkInterfaces?.() || {})) for (const row of rows || []) {
      if (row?.family !== "IPv4" || row.internal) continue;
      const ip = ipv4(row.address), mask = ipv4(row.netmask);
      if (!ip || !mask) continue;
      const a = ip.split(".").map(Number), m = mask.split(".").map(Number);
      targets.add(a.map((part, index) => (part | (255 ^ m[index])) & 255).join("."));
    }
    return [...targets];
  }

  function normalizeScan(message, remote) {
    const data = message?.msg?.cmd === "scan" ? message.msg.data : null;
    const ip = ipv4(data?.ip) || ipv4(remote?.address);
    const device = bounded(data?.device, 128), sku = bounded(data?.sku, 32).toUpperCase();
    return ip && device && /^H[A-Z0-9]{3,15}$/.test(sku) ? { ip, device, sku, name: `Govee ${sku}` } : null;
  }

  async function discoverDevices(input = {}) {
    const timeoutMs = clamp(input.timeoutMs, 300, 10000, 1800);
    if (!dgramRef?.createSocket) return { ok: false, error: "govee_discovery_transport_unavailable", devices: [] };
    const socket = dgramRef.createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map();
    return await new Promise(resolve => {
      let settled = false;
      const finish = result => { if (settled) return; settled = true; try { socket.close(); } catch {} resolve(result); };
      socket.on("error", error => { telemetry.lastError = bounded(error?.message, 160); finish({ ok: false, error: "govee_discovery_failed", devices: [] }); });
      socket.on("message", (buffer, remote) => {
        try { const row = normalizeScan(JSON.parse(String(buffer)), remote); if (row) found.set(row.device, row); } catch {}
      });
      socket.bind(RESPONSE_PORT, "0.0.0.0", () => {
        try { socket.setBroadcast(true); socket.addMembership?.(DISCOVERY_HOST); } catch {}
        const request = packet("scan", { account_topic: "reserve" });
        for (const host of broadcastTargets()) try { socket.send(request, DISCOVERY_PORT, host); } catch {}
        const timer = setTimeoutFn(() => { telemetry.discoveries += 1; telemetry.updatedAt = Date.now(); finish({ ok: true, devices: [...found.values()].slice(0, 32), alpha: true }); }, timeoutMs);
        timer?.unref?.();
      });
    });
  }

  function sendState(fixtures = [], state = {}) {
    const targets = Array.isArray(fixtures) ? fixtures : [];
    const on = state.on !== false;
    const commands = [packet("turn", { value: on ? 1 : 0 })];
    if (on) {
      commands.push(packet("brightness", { value: clamp(state.dimming, 1, 100, 100) }));
      if ([state.r, state.g, state.b].every(value => Number.isFinite(Number(value)))) commands.push(packet("colorwc", { color: { r: clamp(state.r, 0, 255, 0), g: clamp(state.g, 0, 255, 0), b: clamp(state.b, 0, 255, 0) }, colorTemInKelvin: 0 }));
      else if (Number.isFinite(Number(state.temp))) commands.push(packet("colorwc", { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: clamp(state.temp, 2000, 9000, 3500) }));
    }
    if (dryRun) return { sent: targets.length, failed: 0, dryRun: true, commandCount: commands.length };
    const socket = dgramRef.createSocket("udp4");
    let sent = 0, failed = 0;
    for (const fixture of targets) {
      const ip = ipv4(fixture?.ip);
      if (!ip) { failed += 1; continue; }
      try { for (const command of commands) socket.send(command, CONTROL_PORT, ip); sent += 1; }
      catch (error) { failed += 1; telemetry.lastError = bounded(error?.message, 160); log.warn("[GOVEE ALPHA] LAN send failed"); }
    }
    const timer = setTimeoutFn(() => { try { socket.close(); } catch {} }, 250); timer?.unref?.();
    telemetry.sent += sent; telemetry.failed += failed; telemetry.updatedAt = Date.now();
    return { sent, failed, dryRun: false, commandCount: commands.length };
  }

  async function probeDevice(fixture = {}, input = {}) {
    const ip = ipv4(fixture.ip);
    if (!ip || !dgramRef?.createSocket) return { ok: false, reachable: false, error: ip ? "govee_probe_transport_unavailable" : "invalid_govee_target_ip" };
    const timeoutMs = clamp(input.timeoutMs, 300, 5000, 1400);
    const socket = dgramRef.createSocket({ type: "udp4", reuseAddr: true });
    return await new Promise(resolve => {
      let settled = false, timer;
      const finish = result => { if (settled) return; settled = true; if (timer) clearTimeout(timer); try { socket.close(); } catch {} resolve(result); };
      socket.on("error", () => finish({ ok: false, reachable: false, error: "govee_probe_failed" }));
      socket.on("message", (buffer, remote) => {
        if (remote?.address !== ip) return;
        try {
          const message = JSON.parse(String(buffer));
          if (message?.msg?.cmd !== "devStatus") return;
          telemetry.probes += 1; telemetry.updatedAt = Date.now();
          const data = message.msg.data || {};
          finish({ ok: true, reachable: true, state: { on: data.onOff === 1, brightness: clamp(data.brightness, 0, 100, 0), color: data.color || null }, alpha: true });
        } catch {}
      });
      socket.bind(RESPONSE_PORT, "0.0.0.0", () => {
        try { socket.send(packet("devStatus"), CONTROL_PORT, ip); } catch { return finish({ ok: false, reachable: false, error: "govee_probe_failed" }); }
        timer = setTimeoutFn(() => finish({ ok: false, reachable: false, error: "govee_probe_timeout" }), timeoutMs); timer?.unref?.();
      });
    });
  }

  function getTelemetry() { return { ok: true, source: "govee_lan_alpha", alpha: true, transport: "udp_lan", ...telemetry, resources: { persistentSockets: 0, responsePort: RESPONSE_PORT, controlPort: CONTROL_PORT } }; }
  function reconcileFixtures() { return { ok: true }; }
  function shutdown() { return { ok: true }; }
  return Object.freeze({ discoverDevices, sendState, probeDevice, getTelemetry, reconcileFixtures, shutdown });
};

module.exports.constants = { DISCOVERY_HOST, DISCOVERY_PORT, RESPONSE_PORT, CONTROL_PORT };
