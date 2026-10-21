const test = require("node:test"),
  assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const create = require("../src/adapters/brands/hue-entertainment.runtime");
const config = {
  bridgeIp: "192.0.2.1",
  bridgeId: "001788FFFE123456",
  username: "user",
  clientKey: "ab".repeat(16),
  entertainmentAreaId: "3",
  forceHttp: true,
};
const areaId = "a".repeat(8) + "-bbbb-cccc-dddd-" + "e".repeat(12);
function harness({
  v2 = false,
  connect = true,
  sendError = false,
  busy = false,
  startReject = false,
} = {}) {
  const requests = [],
    packets = [],
    sockets = [];
  const runtime = create({
    preheatMs: 5,
    startTimeoutMs: 80,
    axios: {
      request: async (request) => {
        requests.push(request);
        if (request.method === "PUT") {
          if (startReject && (request.data.action === "start" || request.data.stream?.active))
            throw Error("rejected");
          return { data: {} };
        }
        const url = request.url;
        if (url.endsWith("auth/v1")) return { data: { application_id: "application-identity" } };
        if (url.endsWith("/light"))
          return {
            data: { data: [{ id: "light-rid", id_v1: "/lights/7", owner: { rid: "device" } }] },
          };
        if (url.endsWith("/entertainment"))
          return {
            data: {
              data: [
                {
                  id: "service",
                  renderer_reference: { rid: "light-rid" },
                  owner: { rid: "device" },
                },
              ],
            },
          };
        if (v2)
          return {
            data: {
              data: [
                {
                  id: areaId,
                  status: busy ? "active" : "inactive",
                  channels: [{ channel_id: 4, members: [{ service: { rid: "service" } }] }],
                },
              ],
            },
          };
        return { data: { type: "Entertainment", lights: ["7", "11"], stream: { active: busy } } };
      },
    },
    createSocket: (options) => {
      const socket = new EventEmitter();
      sockets.push({ socket, options });
      socket.send = (data, callback) => {
        packets.push(data);
        callback(sendError ? Error("offline") : null);
      };
      socket.close = () => {
        socket.emit("close");
      };
      if (connect) setImmediate(() => socket.emit("connected"));
      return socket;
    },
  });
  return {
    runtime,
    requests,
    packets,
    sockets,
    config: { ...config, entertainmentAreaId: v2 ? areaId : "3" },
  };
}
test("v1 handshake and settle gate sends; packets target real light IDs and wrap sequence", async () => {
  const h = harness();
  assert.equal(h.runtime.getStatus().activeSessions, 0);
  const starting = h.runtime.ensureSession(h.config);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.runtime.getStatus().activeSessions, 0);
  assert.equal(h.packets.length, 0);
  assert.equal((await starting).ok, true);
  for (let i = 0; i < 258; i++)
    assert.equal(
      (
        await h.runtime.sendFrame(h.config, {
          lightIds: ["11"],
          rgb: { r: 255, g: 128, b: 0 },
          bri: 127,
        })
      ).ok,
      true,
    );
  const p = h.packets[0];
  assert.equal(p.subarray(0, 9).toString(), "HueStream");
  assert.equal(p[9], 1);
  assert.equal(p.length, 25);
  assert.equal(p.readUInt16BE(17), 11);
  assert.equal(p.readUInt16BE(19), 128 * 257);
  assert.equal(h.packets[257][11], 1);
  await h.runtime.stopAll();
  assert.equal(h.runtime.getStatus().activeSessions, 0);
});
test("v2 uses application identity, configured UUID and non-contiguous channel IDs", async () => {
  const h = harness({ v2: true });
  assert.equal(
    (await h.runtime.sendFrame(h.config, { lightIds: ["7"], rgb: { r: 10 }, bri: 254 })).ok,
    true,
  );
  assert.ok(h.sockets[0].options.psk["application-identity"]);
  assert.deepEqual(h.sockets[0].options.ciphers, ["TLS_PSK_WITH_AES_128_GCM_SHA256"]);
  const p = h.packets[0];
  assert.equal(p[9], 2);
  assert.equal(p.subarray(16, 52).toString(), areaId);
  assert.equal(p[52], 4);
  assert.equal(p.length, 59);
  assert.equal((await h.runtime.sendFrame(h.config, { lightIds: ["11"] })).ok, false);
  assert.equal(h.packets.length, 1);
  await h.runtime.stopAll();
});
test("handshake timeout, synchronous and asynchronous socket errors release stream ownership", async () => {
  for (const mode of ["timeout", "socket", "send", "rejected"]) {
    const h = harness({
      connect: !["timeout", "socket"].includes(mode),
      sendError: mode === "send",
      startReject: mode === "rejected",
    });
    const starting = h.runtime.ensureSession(h.config);
    if (mode === "socket") {
      await new Promise((r) => setImmediate(r));
      for (let i = 0; i < 40 && !h.sockets.length; i++) await new Promise((r) => setTimeout(r, 1));
      h.sockets[0].socket.emit("error", Error("offline"));
    }
    const result = await starting;
    if (mode === "send")
      assert.equal((await h.runtime.sendFrame(h.config, { lightIds: ["7"] })).ok, false);
    else assert.equal(result.ok, false);
    assert.equal(h.runtime.getStatus().activeSessions, 0);
    assert.ok(h.requests.some((r) => r.data?.stream?.active === false));
    await h.runtime.stopAll();
  }
});
test("busy areas are never stolen and shutdown invalidates pending preheat", async () => {
  const busy = harness({ busy: true });
  assert.equal(
    (await busy.runtime.ensureSession(busy.config)).error,
    "hue_entertainment_area_busy",
  );
  assert.equal(
    busy.requests.some((r) => r.method === "PUT"),
    false,
  );
  const h = harness({ connect: false });
  const pending = h.runtime.ensureSession(h.config);
  await new Promise((r) => setImmediate(r));
  await h.runtime.stopAll();
  assert.equal((await pending).ok, false);
  assert.equal(h.runtime.getStatus().activeSessions, 0);
  assert.equal((await h.runtime.ensureSession(h.config)).ok, false);
});
