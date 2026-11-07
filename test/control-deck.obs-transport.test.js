/** Native Node WebSocket handshake against a tiny local RFC 6455 protocol peer. */
const test = require("node:test"),
  assert = require("node:assert/strict"),
  http = require("node:http"),
  crypto = require("node:crypto");
test("native OBS socket negotiates JSON, authenticates, receives events and drains pending work", async (t) => {
  const sockets = new Set(),
    requests = [],
    password = "native fixture password";
  const server = http.createServer();
  function frame(socket, data, opcode = 1) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data)),
      header = Buffer.alloc(body.length < 126 ? 2 : 4);
    header[0] = 128 | opcode;
    header[1] = body.length < 126 ? body.length : 126;
    if (body.length >= 126) header.writeUInt16BE(body.length, 2);
    socket.write(Buffer.concat([header, body]));
  }
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const accept = crypto
      .createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\nSec-WebSocket-Protocol: obswebsocket.json\r\n\r\n",
    );
    frame(socket, {
      op: 0,
      d: { rpcVersion: 1, authentication: { salt: "salt", challenge: "challenge" } },
    });
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15,
          masked = !!(buffer[1] & 128);
        let size = buffer[1] & 127,
          offset = 2;
        if (size === 126) {
          if (buffer.length < 4) return;
          size = buffer.readUInt16BE(2);
          offset = 4;
        }
        assert(size < 65536);
        if (buffer.length < offset + (masked ? 4 : 0) + size) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        offset += masked ? 4 : 0;
        const body = Buffer.from(buffer.subarray(offset, offset + size));
        buffer = buffer.subarray(offset + size);
        if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        if (opcode === 8) {
          frame(socket, Buffer.alloc(0), 8);
          socket.end();
          return;
        }
        if (opcode === 9) {
          frame(socket, body, 10);
          continue;
        }
        const msg = JSON.parse(body);
        if (msg.op === 1) {
          const secret = crypto
            .createHash("sha256")
            .update(password + "salt")
            .digest("base64");
          assert.equal(
            msg.d.authentication,
            crypto
              .createHash("sha256")
              .update(secret + "challenge")
              .digest("base64"),
          );
          assert.equal(msg.d.rpcVersion, 1);
          frame(socket, { op: 2, d: { negotiatedRpcVersion: 1 } });
        } else {
          requests.push(msg.d.requestType);
          if (msg.d.requestType === "NeverAnswers") continue;
          frame(socket, {
            op: 7,
            d: {
              requestId: msg.d.requestId,
              requestType: msg.d.requestType,
              requestStatus: { result: true, code: 100 },
              responseData: { scenes: [] },
            },
          });
          frame(socket, {
            op: 5,
            d: {
              eventType: "CurrentProgramSceneChanged",
              eventData: { sceneName: "Fixture scene" },
            },
          });
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const events = [],
    client = require("../src/domains/control-deck/obs-client")({
      event: (type, data) => events.push({ type, data }),
    });
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  });
  await client.connect({ host: "127.0.0.1", port: server.address().port, password });
  assert.deepEqual(await client.request("GetSceneList"), { scenes: [] });
  await new Promise((r) => setImmediate(r));
  assert.equal(events[0].data.sceneName, "Fixture scene");
  const pending = client.request("NeverAnswers");
  const rejected = assert.rejects(pending, /obs_not_connected/);
  client.close();
  await rejected;
  assert.equal(client.status().connected, false);
  assert.deepEqual(
    requests.filter((r) => r !== "NeverAnswers"),
    ["GetSceneList"],
  );
});
