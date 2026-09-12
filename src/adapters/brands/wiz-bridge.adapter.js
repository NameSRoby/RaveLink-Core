// [TITLE] Module: adapters/brands/wiz-bridge.adapter.js
// [TITLE] Purpose: WiZ transport adapter boundary
// [TITLE] Functionality Index:
// [TITLE] - emit WiZ state payloads per fixture
// [TITLE] - discover WiZ devices via UDP broadcast probe
// [TITLE] - support dry-run behavior
// [TITLE] - isolate transport exceptions from domain logic

const dgram = require("node:dgram");
const os = require("node:os");

module.exports = function createWizBridgeAdapter(options = {}) {
  const log = options.log || console;
  const dryRun = options.dryRun !== false;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sendFixture = typeof options.sendFixture === "function"
    ? options.sendFixture
    : (() => {});
  const hasInjectedSendFixture = typeof options.sendFixture === "function";
  const dgramRef = options.dgramRef && typeof options.dgramRef === "object"
    ? options.dgramRef
    : dgram;
  const osRef = options.osRef && typeof options.osRef === "object"
    ? options.osRef
    : os;
  const setTimeoutFn = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const defaultPort = clampNumber(options.port, 1, 65535, 38899);
  const defaultRepeats = clampNumber(options.sendRepeats, 1, 3, 2);
  const defaultRepeatDelayMs = clampNumber(options.repeatDelayMs, 8, 120, 16);
  const MAX_WIZ_TARGETS = 256;
  let targetEvictions = 0;
  let lifecycleEvictions = 0;

  let liveSocket = null;
  let socketReady = false;
  let socketReadyAt = 0;
  let socketLastError = "";
  const latestSendSeqByIp = new Map();
  const repeatTimersByIp = new Map();
  function admitTarget(ip) {
    if (latestSendSeqByIp.has(ip) || latestSendSeqByIp.size < MAX_WIZ_TARGETS) return;
    const oldestIp = latestSendSeqByIp.keys().next().value;
    clearRepeatTimersForIp(oldestIp);
    latestSendSeqByIp.delete(oldestIp);
    targetEvictions += 1;
  }
  let telemetry = {
    sent: 0,
    failed: 0,
    skipped: 0,
    lastDurationMs: 0,
    lastTargetIp: "",
    lastError: "",
    lastState: {
      on: true,
      dimming: 100,
      r: 0,
      g: 0,
      b: 0
    },
    updatedAt: Number(now() || Date.now())
  };

  function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return Number(fallback);
    return Math.min(Number(max), Math.max(Number(min), parsed));
  }

  function toRoundedInt(value, min, max, fallback) {
    return Math.round(clampNumber(value, min, max, fallback));
  }

  function parseIpv4(value) {
    const text = String(value || "").trim();
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)) return null;
    const parts = text.split(".").map(part => Number(part));
    if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return parts;
  }

  function formatIpv4(parts = []) {
    if (!Array.isArray(parts) || parts.length !== 4) return "";
    return parts.map(part => String(Math.max(0, Math.min(255, Number(part) || 0)))).join(".");
  }

  function normalizeFixtureIp(target = {}) {
    const source = target && typeof target === "object" ? target : {};
    const rawIp = String(source.ip || source.host || source.address || "").trim();
    const parsed = parseIpv4(rawIp);
    if (!parsed) return "";
    return formatIpv4(parsed);
  }

  function normalizeTelemetryWizState(rawState = {}) {
    const source = rawState && typeof rawState === "object" ? rawState : {};
    return {
      on: source.on !== false,
      dimming: toRoundedInt(source.dimming, 10, 100, source.on === false ? 10 : 100),
      r: toRoundedInt(source.r, 0, 255, 0),
      g: toRoundedInt(source.g, 0, 255, 0),
      b: toRoundedInt(source.b, 0, 255, 0)
    };
  }

  function clearRepeatTimersForIp(ip = "") {
    const key = String(ip || "").trim();
    if (!key) return;
    const timers = repeatTimersByIp.get(key);
    if (!timers) return;
    for (const timer of timers) {
      try {
        clearTimeoutFn(timer);
      } catch {}
    }
    repeatTimersByIp.delete(key);
  }

  function ensureLiveSocket() {
    if (liveSocket) return liveSocket;
    if (!dgramRef || typeof dgramRef.createSocket !== "function") {
      throw new Error("wiz_udp_transport_unavailable");
    }
    liveSocket = dgramRef.createSocket("udp4");
    if (liveSocket && typeof liveSocket.on === "function") {
      liveSocket.on("error", err => {
        const message = String(err?.message || err || "wiz_socket_error");
        socketLastError = message;
        telemetry.lastError = message;
        telemetry.updatedAt = Number(now() || Date.now());
        log.warn("[WIZ] UDP socket error:", message);
      });
    }
    if (liveSocket && typeof liveSocket.bind === "function") {
      try {
        liveSocket.bind(0, () => {
          try {
            liveSocket.setBroadcast(true);
          } catch (error) {
            socketLastError = String(error?.message || error || "wiz_socket_broadcast_failed");
            telemetry.lastError = socketLastError;
            telemetry.updatedAt = Number(now() || Date.now());
            log.warn("[WIZ] setBroadcast failed:", socketLastError);
          }
          socketReady = true;
          socketReadyAt = Number(now() || Date.now());
        });
      } catch (error) {
        socketLastError = String(error?.message || error || "wiz_socket_bind_failed");
        telemetry.lastError = socketLastError;
        telemetry.updatedAt = Number(now() || Date.now());
        log.warn("[WIZ] UDP bind failed:", socketLastError);
      }
    }
    return liveSocket;
  }

  function buildWizPilotPayload(rawState = {}) {
    const source = rawState && typeof rawState === "object" ? rawState : {};
    const on = source.on !== false;
    const params = {
      state: on
    };
    if (Number.isFinite(Number(source.dimming))) {
      params.dimming = toRoundedInt(source.dimming, 10, 100, 100);
    } else {
      params.dimming = on ? 100 : 10;
    }
    if (on && Number.isFinite(Number(source.speed))) {
      params.speed = toRoundedInt(source.speed, 20, 200, 80);
    }
    if (on && Number.isFinite(Number(source.temp))) {
      params.temp = toRoundedInt(source.temp, 2200, 6500, 3500);
    } else if (
      on &&
      Number.isFinite(Number(source.r)) &&
      Number.isFinite(Number(source.g)) &&
      Number.isFinite(Number(source.b))
    ) {
      params.r = toRoundedInt(source.r, 0, 255, 0);
      params.g = toRoundedInt(source.g, 0, 255, 0);
      params.b = toRoundedInt(source.b, 0, 255, 0);
    }
    return Buffer.from(JSON.stringify({
      method: "setPilot",
      params
    }), "utf8");
  }

  function sendFixtureViaUdp(target = {}, state = {}) {
    const ip = normalizeFixtureIp(target);
    if (!ip) {
      throw new Error("invalid_wiz_target_ip");
    }
    const socket = ensureLiveSocket();
    const payload = buildWizPilotPayload(state);
    const repeats = toRoundedInt(defaultRepeats, 1, 3, 2);
    const repeatDelayMs = toRoundedInt(defaultRepeatDelayMs, 8, 120, 16);
    admitTarget(ip);
    const sendSeq = Number(latestSendSeqByIp.get(ip) || 0) + 1;
    latestSendSeqByIp.set(ip, sendSeq);
    clearRepeatTimersForIp(ip);
    const repeatTimers = new Set();
    repeatTimersByIp.set(ip, repeatTimers);

    const sendNow = () => {
      socket.send(payload, defaultPort, ip);
    };
    sendNow();
    for (let attempt = 1; attempt < repeats; attempt += 1) {
      let timer = null;
      timer = setTimeoutFn(() => {
        if (timer) {
          repeatTimers.delete(timer);
        }
        if (Number(latestSendSeqByIp.get(ip) || 0) !== sendSeq) return;
        try {
          sendNow();
        } catch (error) {
          const message = String(error?.message || error || "wiz_send_repeat_failed");
          telemetry.lastError = message;
          telemetry.updatedAt = Number(now() || Date.now());
          log.warn("[WIZ] repeat send failed:", message);
        }
        if (!repeatTimers.size) {
          repeatTimersByIp.delete(ip);
          if (Number(latestSendSeqByIp.get(ip) || 0) === sendSeq) latestSendSeqByIp.delete(ip);
        }
      }, attempt * repeatDelayMs);
      if (timer && typeof timer.unref === "function") {
        timer.unref();
      }
      repeatTimers.add(timer);
    }
    if (!repeatTimers.size) {
      repeatTimersByIp.delete(ip);
      latestSendSeqByIp.delete(ip);
    }
    return ip;
  }

  function reconcileFixtures(fixtures = []) {
    const retained = new Set((Array.isArray(fixtures) ? fixtures : [])
      .filter(row => String(row?.brand || "").toLowerCase() === "wiz")
      .map(normalizeFixtureIp)
      .filter(Boolean));
    let removed = 0;
    for (const ip of [...latestSendSeqByIp.keys()]) {
      if (retained.has(ip)) continue;
      clearRepeatTimersForIp(ip);
      latestSendSeqByIp.delete(ip);
      removed += 1;
    }
    lifecycleEvictions += removed;
    return { ok: true, removed, retained: retained.size };
  }

  function shutdown() {
    const targets = new Set([...latestSendSeqByIp.keys(), ...repeatTimersByIp.keys()]);
    for (const ip of targets) clearRepeatTimersForIp(ip);
    latestSendSeqByIp.clear();
    try { liveSocket?.close?.(); } catch {}
    liveSocket = null; socketReady = false; socketReadyAt = 0;
    return { ok: true, removed: targets.size };
  }

  function computeBroadcastAddress(ip, netmask) {
    const ipParts = parseIpv4(ip);
    const maskParts = parseIpv4(netmask);
    if (!ipParts || !maskParts) return "";
    const out = [];
    for (let index = 0; index < 4; index += 1) {
      const value = (ipParts[index] | (255 ^ maskParts[index])) & 255;
      out.push(value);
    }
    return formatIpv4(out);
  }

  function normalizeWizDeviceFromMessage(message = {}, host = "") {
    const source = message && typeof message === "object" && !Array.isArray(message) ? message : {};
    const result = source.result && typeof source.result === "object" && !Array.isArray(source.result)
      ? source.result
      : source;
    const ip = String(host || "").trim();
    if (!ip || !parseIpv4(ip)) return null;
    const moduleName = String(result.moduleName || result.name || "").trim();
    const roomId = Number.isFinite(Number(result.roomId)) ? Number(result.roomId) : 0;
    const roomName = String(result.roomName || "").trim();
    const mac = String(result.mac || result.macAddress || "").trim().toUpperCase();
    return {
      ip,
      mac,
      moduleName,
      roomId,
      roomName
    };
  }

  function getBroadcastTargets() {
    const targets = new Set(["255.255.255.255"]);
    const interfaces = typeof osRef.networkInterfaces === "function"
      ? osRef.networkInterfaces() || {}
      : {};
    for (const rows of Object.values(interfaces)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || row.family !== "IPv4" || row.internal !== false) continue;
        const broadcast = computeBroadcastAddress(row.address, row.netmask);
        if (broadcast) targets.add(broadcast);
      }
    }
    return [...targets];
  }

  function sendState(fixtures = [], state = {}) {
    // [DEV] WiZ send strategy remains adapter-owned so runtime policy can evolve
    // [DEV] without changing route/domain contracts.
    const targets = Array.isArray(fixtures) ? fixtures : [];
    const command = JSON.parse(String(buildWizPilotPayload(state)));
    const startedAt = Number(now() || Date.now());
    if (!targets.length) {
      telemetry.skipped = Number(telemetry.skipped || 0) + 1;
      telemetry.lastDurationMs = 0;
      telemetry.updatedAt = Number(now() || Date.now());
      return { sent: 0, failed: 0, dryRun, command };
    }
    if (dryRun) {
      telemetry.sent = Number(telemetry.sent || 0) + targets.length;
      telemetry.lastState = normalizeTelemetryWizState(state);
      telemetry.lastDurationMs = Number(now() || Date.now()) - startedAt;
      telemetry.updatedAt = Number(now() || Date.now());
      return { sent: targets.length, failed: 0, dryRun: true, command };
    }
    let sent = 0;
    let failed = 0;
    let lastTargetIp = "";
    for (const target of targets) {
      try {
        if (hasInjectedSendFixture) {
          sendFixture(target, state);
          lastTargetIp = normalizeFixtureIp(target);
        } else {
          lastTargetIp = sendFixtureViaUdp(target, state);
        }
        sent += 1;
        telemetry.lastState = normalizeTelemetryWizState(state);
      } catch (err) {
        failed += 1;
        const message = String(err?.message || err || "wiz_state_send_failed");
        telemetry.lastError = message;
        log.warn("[WIZ] state send failed:", message);
      }
    }
    telemetry.sent = Number(telemetry.sent || 0) + sent;
    telemetry.failed = Number(telemetry.failed || 0) + failed;
    telemetry.lastTargetIp = String(lastTargetIp || telemetry.lastTargetIp || "");
    telemetry.lastDurationMs = Number(now() || Date.now()) - startedAt;
    telemetry.updatedAt = Number(now() || Date.now());
    return { sent, failed, dryRun: false, command };
  }

  function getTelemetry() {
    return {
      ok: true,
      source: "wiz_udp_adapter",
      transport: hasInjectedSendFixture ? "injected_sender" : "udp_socket",
      sent: Number(telemetry.sent || 0),
      failed: Number(telemetry.failed || 0),
      skipped: Number(telemetry.skipped || 0),
      lastDurationMs: Number(telemetry.lastDurationMs || 0),
      lastTargetIp: String(telemetry.lastTargetIp || ""),
      lastError: String(telemetry.lastError || ""),
      lastState: normalizeTelemetryWizState(telemetry.lastState),
      socket: {
        created: Boolean(liveSocket),
        ready: socketReady === true,
        readyAt: Number(socketReadyAt || 0),
        lastError: String(socketLastError || "")
      },
      updatedAt: Number(telemetry.updatedAt || 0)
    };
  }

  async function discoverDevices(input = {}) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    if (!dgramRef || typeof dgramRef.createSocket !== "function") {
      return {
        ok: false,
        error: "wiz_discovery_transport_unavailable",
        devices: []
      };
    }

    const timeoutMs = clampNumber(source.timeoutMs, 200, 10000, 1200);
    const port = clampNumber(source.port, 1, 65535, 38899);
    const payloads = ["getSystemConfig", "getPilot"].map(method => Buffer.from(JSON.stringify({ method, params: {} }), "utf8"));
    const targets = getBroadcastTargets();
    const socket = dgramRef.createSocket("udp4");
    const byIp = new Map();
    let settled = false;

    function finalize(result) {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {}
      return result;
    }

    return await new Promise(resolve => {
      socket.on("error", error => {
        const detail = String(error?.message || error || "wiz_discovery_socket_error");
        log.warn("[WIZ] discovery socket error:", detail);
        resolve(finalize({
          ok: false,
          error: "wiz_discovery_failed",
          detail,
          devices: []
        }));
      });

      socket.on("message", (buffer, remote) => {
        try {
          const parsed = JSON.parse(String(buffer || "").trim() || "{}");
          const device = normalizeWizDeviceFromMessage(parsed, remote?.address);
          if (!device) return;
          byIp.set(device.ip, device);
        } catch {}
      });

      socket.bind(0, () => {
        try {
          socket.setBroadcast(true);
        } catch (error) {
          resolve(finalize({
            ok: false,
            error: "wiz_discovery_failed",
            detail: String(error?.message || error),
            devices: []
          }));
          return;
        }
        for (const host of targets) {
          for (const payload of payloads) {
            try {
              socket.send(payload, port, host);
            } catch {}
          }
        }
        const timer = setTimeoutFn(() => {
          const devices = [...byIp.values()].sort((a, b) => String(a.ip || "").localeCompare(String(b.ip || "")));
          resolve(finalize({
            ok: true,
            devices,
            targetCount: targets.length
          }));
        }, timeoutMs);
        if (timer && typeof timer.unref === "function") {
          timer.unref();
        }
      });
    });
  }

  async function probeDevice(target = {}, input = {}) {
    const ip = normalizeFixtureIp(target);
    if (!ip) return { ok: false, reachable: false, error: "invalid_wiz_target_ip" };
    if (!dgramRef || typeof dgramRef.createSocket !== "function") return { ok: false, reachable: false, error: "wiz_probe_transport_unavailable" };
    const timeoutMs = clampNumber(input.timeoutMs, 200, 5000, 1200);
    const socket = dgramRef.createSocket("udp4");
    let settled = false;
    return await new Promise(resolve => {
      let timer = null;
      const finish = result => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeoutFn(timer);
        try { socket.close(); } catch {}
        resolve(result);
      };
      socket.on("error", () => finish({ ok: false, reachable: false, error: "wiz_probe_failed" }));
      socket.on("message", (buffer, remote) => {
        if (String(remote?.address || "") !== ip) return;
        try {
          const message = JSON.parse(String(buffer || "").trim() || "{}");
          if (message?.method !== "getPilot" && !message?.result) return;
          finish({ ok: true, reachable: true, state: normalizeTelemetryWizState(message.result || {}) });
        } catch {}
      });
      socket.bind(0, () => {
        try { socket.send(Buffer.from(JSON.stringify({ method: "getPilot", params: {} })), defaultPort, ip); }
        catch { return finish({ ok: false, reachable: false, error: "wiz_probe_failed" }); }
        if (settled) return;
        timer = setTimeoutFn(() => finish({ ok: false, reachable: false, error: "wiz_probe_timeout" }), timeoutMs);
        timer?.unref?.();
      });
    });
  }

  return {
    sendState,
    discoverDevices,
    probeDevice,
    getTelemetry() {
      return {
        ...getTelemetry(),
        resources: {
          targetEntries: latestSendSeqByIp.size,
          timerTargetEntries: repeatTimersByIp.size,
          maximumTargetEntries: MAX_WIZ_TARGETS,
          targetEvictions,
          lifecycleEvictions
        }
      };
    },
    reconcileFixtures,
    shutdown
  };
};
