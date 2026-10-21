/** Hue Entertainment v1/v2 over DTLS. Frames address actual light/channel IDs;
 * no selected fixture count is ever used as an area-wide RGB broadcast.
 * Startup, send and teardown are bounded, and shutdown invalidates pending starts.
 */
const resolveCa = require("./hue-ca-path");
const keyFor = (c) => [c.bridgeIp, c.username, c.clientKey, c.entertainmentAreaId].join("|");
const fault = (code) => Object.assign(new Error(code), { code });
const lightId = (value) =>
  String(value || "")
    .split("/")
    .pop();
function packet(version, areaId, sequence, channels, rgb) {
  const header = Buffer.alloc(16);
  header.write("HueStream");
  header[9] = version;
  header[11] = sequence % 256;
  const rows = channels.map((id) => {
    const row = Buffer.alloc(version === 1 ? 9 : 7);
    if (version === 1) row.writeUInt16BE(Number(id), 1);
    else row[0] = Number(id);
    const offset = version === 1 ? 3 : 1;
    [rgb.r, rgb.g, rgb.b].forEach((v, i) => row.writeUInt16BE(Math.round(v) * 257, offset + i * 2));
    return row;
  });
  return Buffer.concat([header, ...(version === 2 ? [Buffer.from(areaId, "ascii")] : []), ...rows]);
}
module.exports = function createHueEntertainmentRuntime(options = {}) {
  const now = options.now || Date.now;
  const http = options.axios || require("axios");
  const timeoutMs = options.startTimeoutMs ?? 9000;
  const settleMs = options.preheatMs ?? 150;
  const sessions = new Map(),
    pending = new Map(),
    stopping = new Map();
  let epoch = 0,
    lastError = "",
    closed = false,
    sent = 0;
  let createSocket = options.createSocket,
    unavailable = "";
  if (!createSocket) {
    try {
      createSocket = require("node-dtls-client").dtls.createSocket;
    } catch {
      unavailable = "node_dtls_client_unavailable";
    }
  }
  const certPath = resolveCa(options.rootDir || process.cwd());
  const request = require("./hue-entertainment-http")({
    http,
    timeoutMs,
    rootDir: options.rootDir || process.cwd(),
  });
  async function stop(session) {
    if (!session || session.stopping) return session?.stopping;
    session.active = false;
    clearTimeout(session.idleTimer);
    if (sessions.get(session.key) === session) sessions.delete(session.key);
    session.stopping = Promise.resolve()
      .then(async () => {
        session.controller.abort();
        try {
          session.socket?.close();
        } catch {}
        if (session.claimed) {
          try {
            await request(
              session.config,
              session.version,
              session.resource,
              session.version === 1 ? { stream: { active: false } } : { action: "stop" },
            );
          } catch {}
        }
      })
      .finally(() => stopping.delete(session.key));
    stopping.set(session.key, session.stopping);
    return session.stopping;
  }
  async function discover(c, signal) {
    const requested = String(c.entertainmentAreaId || "");
    // Pairing via API v1 returns numeric group IDs. UUIDs select v2 directly.
    const version = /^\d+$/.test(requested) ? 1 : 2;
    if (version === 1) {
      const area = await request(c, 1, `groups/${requested}`, null, signal);
      if (area.type !== "Entertainment" || !Array.isArray(area.lights) || !area.lights.length)
        throw fault("hue_entertainment_area_unavailable");
      if (area.stream?.active) throw fault("hue_entertainment_area_busy");
      return {
        version,
        areaId: requested,
        resource: `groups/${requested}`,
        identity: c.username,
        channels: area.lights.map((id) => ({ id: Number(id), lights: [String(id)] })),
      };
    }
    const response = await request(
      c,
      2,
      `clip/v2/resource/entertainment_configuration/${requested}`,
      null,
      signal,
    );
    const area = response.data?.find((a) => a.id === requested);
    if (!area?.channels?.length) throw fault("hue_entertainment_area_unavailable");
    if (area.status === "active" || area.active_streamer)
      throw fault("hue_entertainment_area_busy");
    const lights = (await request(c, 2, "clip/v2/resource/light", null, signal)).data || [];
    const services =
      (await request(c, 2, "clip/v2/resource/entertainment", null, signal)).data || [];
    const auth = await request(c, 2, "auth/v1", null, signal);
    const identity = auth.application_id || auth["hue-application-id"];
    if (!identity) throw fault("hue_entertainment_identity_missing");
    return {
      version,
      areaId: area.id,
      resource: `clip/v2/resource/entertainment_configuration/${area.id}`,
      identity,
      channels: area.channels.map((channel) => ({
        id: channel.channel_id,
        lights: [
          ...new Set(
            (channel.members || []).map((member) => {
              const rid = member.service?.rid;
              const service = services.find((s) => s.id === rid);
              const light = lights.find(
                (l) => l.id === rid || l.id === service?.renderer_reference?.rid,
              );
              return lightId(light?.id_v1);
            }),
          ),
        ],
      })),
    };
  }
  async function ensureSession(c = {}) {
    if (closed || !createSocket)
      return { ok: false, error: unavailable || "hue_entertainment_closed" };
    if (
      !c.bridgeIp ||
      !c.username ||
      !/^[a-f\d]{32}$/i.test(c.clientKey || "") ||
      !c.entertainmentAreaId
    )
      return { ok: false, error: "hue_entertainment_config_incomplete" };
    const key = keyFor(c);
    await stopping.get(key);
    if (closed) return { ok: false, error: "hue_entertainment_closed" };
    const existing = sessions.get(key);
    if (existing?.active) return { ok: true, session: existing };
    if (pending.has(key)) return pending.get(key);
    if (sessions.size + pending.size >= 64)
      return { ok: false, error: "hue_entertainment_session_limit" };
    const generation = epoch;
    const controller = new AbortController();
    const session = {
      key,
      config: c,
      controller,
      active: false,
      claimed: false,
      sequence: 0,
      lastUsedAt: now(),
    };
    const work = (async () => {
      let timer;
      try {
        await Promise.race([
          (async () => {
            Object.assign(session, await discover(c, controller.signal));
            if (generation !== epoch || controller.signal.aborted)
              throw fault("hue_entertainment_cancelled");
            // No other area on this bridge may be started concurrently by this runtime.
            if (
              [...sessions.values()].some((s) => s.config.bridgeIp === c.bridgeIp && s.key !== key)
            )
              throw fault("hue_entertainment_bridge_busy");
            sessions.set(key, session);
            session.claimed = true;
            await request(
              c,
              session.version,
              session.resource,
              session.version === 1 ? { stream: { active: true } } : { action: "start" },
              controller.signal,
            );
            if (controller.signal.aborted) throw fault("hue_entertainment_cancelled");
            // The bridge acknowledges activation before its UDP listener is
            // necessarily ready. Do not lose the first DTLS ClientHello there.
            await new Promise((resolve) => setTimeout(resolve, settleMs));
            if (generation !== epoch || controller.signal.aborted)
              throw fault("hue_entertainment_cancelled");
            await new Promise((resolve, reject) => {
              session.socket = require("./hue-dtls-handshake")(createSocket, {
                address: c.bridgeIp,
                port: 2100,
                type: "udp4",
                timeout: timeoutMs,
                signal: controller.signal,
                ciphers: ["TLS_PSK_WITH_AES_128_GCM_SHA256"],
                psk: { [session.identity]: Buffer.from(c.clientKey, "hex") },
              });
              session.socket.on("error", () => {
                lastError = "hue_entertainment_socket_error";
                reject(fault(lastError));
                void stop(session);
              });
              session.socket.once("close", () => {
                reject(fault("hue_entertainment_session_closed"));
                void stop(session);
              });
              session.socket.once("connected", resolve);
            });
            await new Promise((resolve) => setTimeout(resolve, settleMs));
            if (generation !== epoch || controller.signal.aborted)
              throw fault("hue_entertainment_cancelled");
            session.active = true;
            armIdle(session);
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(fault("hue_entertainment_start_timeout"));
            }, timeoutMs);
          }),
        ]);
        return { ok: true, session };
      } catch (error) {
        lastError = error.code?.startsWith("hue_") ? error.code : "hue_entertainment_start_failed";
        await stop(session);
        return { ok: false, error: lastError };
      } finally {
        clearTimeout(timer);
        pending.delete(key);
      }
    })();
    pending.set(key, work);
    return work;
  }
  function armIdle(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void stop(session);
    }, options.sessionIdleTtlMs ?? 30000);
    session.idleTimer.unref?.();
  }
  async function sendFrame(c = {}, input = {}) {
    const ensured = input.requireActive
      ? {
          ok: sessions.get(keyFor(c))?.active === true,
          session: sessions.get(keyFor(c)),
          error: "hue_entertainment_not_active",
        }
      : await ensureSession(c);
    if (!ensured.ok) return ensured;
    const session = ensured.session;
    const requested = (input.lightIds || []).map(String);
    const channels = requested.length
      ? session.channels.filter(
          (ch) => ch.lights.length && ch.lights.every((id) => requested.includes(id)),
        )
      : session.channels;
    if (!channels.length || requested.some((id) => !channels.some((ch) => ch.lights.includes(id))))
      return { ok: false, error: "hue_entertainment_channel_not_addressable" };
    const gain = input.on === false ? 0 : Math.max(0, Math.min(1, (input.bri ?? 254) / 254));
    const rgb = Object.fromEntries(
      ["r", "g", "b"].map((k) => [
        k,
        Math.max(0, Math.min(255, Number(input.rgb?.[k]) || 0)) * gain,
      ]),
    );
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(fault("hue_entertainment_send_timeout")), 1000);
        session.socket.send(
          packet(
            session.version,
            session.areaId,
            session.sequence++,
            channels.map((ch) => ch.id),
            rgb,
          ),
          (error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          },
        );
      });
      session.lastUsedAt = now();
      armIdle(session);
      sent++;
      return { ok: true, channelCount: channels.length, version: session.version };
    } catch {
      lastError = "hue_entertainment_send_failed";
      await stop(session);
      return { ok: false, error: lastError };
    } finally {
      clearTimeout(timer);
    }
  }
  async function stopAll(reason = "shutdown") {
    epoch++;
    if (reason === "shutdown") closed = true;
    await Promise.allSettled([...sessions.values()].map(stop));
    await Promise.allSettled([...pending.values()]);
    await Promise.allSettled([...sessions.values()].map(stop));
    return { ok: true };
  }
  return {
    ensureSession,
    sendFrame,
    stopAll,
    async stopConfig(c) {
      await stop(sessions.get(keyFor(c)));
    },
    async reconcileConfigs(configs = []) {
      const keep = new Set(configs.map(keyFor));
      await Promise.allSettled([...sessions.values()].filter((s) => !keep.has(s.key)).map(stop));
    },
    getStatus: () => ({
      available: !!createSocket,
      reason: unavailable,
      activeSessions: [...sessions.values()].filter((s) => s.active).length,
      pendingSessions: pending.size,
      supportedVersions: [1, 2],
      maximumSessions: 64,
      stoppingSessions: stopping.size,
      preheatMs: settleMs,
      sent,
      lastError,
      sessions: [...sessions.values()].map((s) => ({
        version: s.version,
        active: s.active,
        channelCount: s.channels.length,
      })),
      caTrust: { installed: !!certPath, certPath },
    }),
  };
};
module.exports.packet = packet;
