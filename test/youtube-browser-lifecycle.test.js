/** Exercise disconnect/re-pair and delayed-message races, not live playback. */
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm");
const createBridge = require("../integrations/youtube-browser/bridge.cjs");
const extension = path.resolve(__dirname, "../integrations/youtube-browser/extension");
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("queue removal requires a matching confirmed append receipt from this document", async (t) => {
  const bridge = createBridge(),
    connection = await bridge.listen(0);
  t.after(() => bridge.close());
  async function request(route, body) {
    const response = await fetch(`${connection.base}/api/${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const documentId = "11111111-1111-4111-8111-111111111111";
  const observation = {
    clientId: "owner",
    snapshot: {
      current: { videoId: "aaaaaaaaaaa" },
      mediaReady: true,
      native: { available: true, documentId, allIdentified: true, queueWrite: true, network: true },
    },
  };
  const payload = { expectedVideoId: "aaaaaaaaaaa", nativeDocumentId: documentId };
  await request("pair", { clientId: "owner" });
  await request("exchange", observation);
  async function execute(body, receipt) {
    const pending = request("queue", { ...payload, ...body });
    let command;
    for (let i = 0; i < 100 && !command; i++) {
      command = (await request("exchange", observation)).body.command;
      if (!command) await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(command, "host must lease the command");
    await request("exchange", {
      ...observation,
      result: { id: command.id, sessionId: command.sessionId, ok: true, ...receipt },
    });
    return pending;
  }
  const missing = await execute({ id: "missing", action: "append", videoId: "bbbbbbbbbbb" }, {});
  assert.equal(missing.body.error, "control_unconfirmed");
  const invalid = await execute(
    { id: "invalid", action: "append", videoId: "bbbbbbbbbbb" },
    {
      occurrenceId: "wrong",
      videoId: "ccccccccccc",
      nativeDocumentId: documentId,
    },
  );
  assert.equal(invalid.body.error, "control_unconfirmed");
  assert.equal(
    (
      await request("queue", {
        ...payload,
        id: "unowned",
        action: "remove",
        occurrenceId: "wrong",
      })
    ).body.error,
    "native_entry_not_owned",
  );
  const receipt = {
    occurrenceId: "native_unique",
    videoId: "bbbbbbbbbbb",
    nativeDocumentId: documentId,
  };
  assert.deepEqual(
    (await execute({ id: "valid", action: "append", videoId: "bbbbbbbbbbb" }, receipt)).body,
    { ok: true, ...receipt },
  );
  assert.deepEqual(
    (await execute({ id: "remove", action: "remove", occurrenceId: receipt.occurrenceId }, {}))
      .body,
    { ok: true },
  );
  assert.equal(
    (
      await request("queue", {
        ...payload,
        id: "remove-again",
        action: "remove",
        occurrenceId: receipt.occurrenceId,
      })
    ).status,
    409,
  );
});

test("Disconnect during a slow Connect leaves no paired owner or saved configuration", async () => {
  const local = {},
    session = {},
    actions = [];
  const storage = (values) => ({
    get: async (key) => ({ [key]: values[key] }),
    set: async (input) => Object.assign(values, input),
    remove: async (key) => {
      delete values[key];
    },
  });
  let handler, deliverPair, pairStarted;
  const started = new Promise((resolve) => {
    pairStarted = resolve;
  });
  const popup = { id: "fixture", url: "moz-extension://fixture/popup.html" };
  vm.runInNewContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), {
    browser: {
      runtime: {
        id: "fixture",
        getURL: () => popup.url,
        onMessage: {
          addListener: (fn) => {
            handler = fn;
          },
        },
      },
      storage: { local: storage(local), session: storage(session) },
      tabs: {
        query: async () => [{ id: 7, url: "https://music.youtube.com/" }],
        sendMessage: async () => {},
      },
    },
    crypto: require("node:crypto").webcrypto,
    AbortSignal,
    fetch: async (url) => {
      if (url.endsWith("/api/status"))
        return {
          ok: true,
          json: async () => ({ prototype: true, protocolVersion: 1, paired: false }),
        };
      if (url.endsWith("/api/pair")) {
        actions.push("pair");
        pairStarted();
        return new Promise((resolve) => {
          deliverPair = () => resolve({ ok: true });
        });
      }
      if (url.endsWith("/api/disconnect")) {
        actions.push("disconnect");
        return { ok: true };
      }
      throw Error("Unexpected request");
    },
  });
  const send = (message) => new Promise((resolve) => handler(message, popup, resolve));
  const connecting = send({ type: "connect", port: 5051, token: "a".repeat(64) });
  await started;
  const disconnecting = send({ type: "disconnect" });
  await flush();
  deliverPair();
  await Promise.all([connecting, disconnecting]);
  assert.equal(session.owner, undefined);
  assert.equal(local.connection, undefined);
  assert.deepEqual(actions, ["pair", "disconnect"]);
});

test("full Unicode queue observations fit the transport budget while oversized payloads are rejected", async (t) => {
  const bridge = createBridge(),
    connection = await bridge.listen(0);
  t.after(() => bridge.close());
  const headers = {
    Authorization: `Bearer ${connection.token}`,
    "Content-Type": "application/json",
  };
  const pair = await fetch(`${connection.base}/api/pair`, {
    method: "POST",
    headers,
    body: JSON.stringify({ clientId: "unicode" }),
  });
  assert.equal(pair.status, 200);
  await pair.text();
  const body = JSON.stringify({
    clientId: "unicode",
    snapshot: {
      current: { videoId: 11111111111, title: "An invalid numeric ID" },
      mediaReady: true,
      queue: Array.from({ length: 100 }, () => ({
        videoId: "aaaaaaaaaaa",
        title: "\u66f2".repeat(180),
        artist: "\u97f3".repeat(180),
      })),
    },
  });
  assert.ok(Buffer.byteLength(body) > 32 * 1024);
  const exchange = await fetch(`${connection.base}/api/exchange`, {
    method: "POST",
    headers,
    body,
  });
  assert.equal(exchange.status, 200);
  await exchange.text();
  assert.equal(bridge.status().snapshot.queue.length, 100);
  assert.equal(bridge.status().snapshot.controls, false, "numeric IDs must not authorize controls");
  const oversized = await fetch(`${connection.base}/api/exchange`, {
    method: "POST",
    headers,
    body: JSON.stringify({ padding: "x".repeat(150000) }),
  });
  assert.equal(oversized.status, 400);
  await oversized.text();
  assert.equal(bridge.status().snapshot.queue.length, 100);
});

test("expired commands are never delivered later and late success cannot overwrite an uncertain outcome", async (t) => {
  const bridge = createBridge({ timeoutMs: 300 }),
    connection = await bridge.listen(0);
  t.after(() => bridge.close());
  const headers = {
    Authorization: `Bearer ${connection.token}`,
    "Content-Type": "application/json",
  };
  async function request(route, value) {
    const response = await fetch(`${connection.base}/api/${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(value),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  const observation = {
    clientId: "owner",
    snapshot: {
      current: { videoId: "aaaaaaaaaaa", title: "Song" },
      mediaReady: true,
      paused: true,
    },
  };
  await request("pair", { clientId: "owner" });
  await request("exchange", observation);
  const expired = { id: "never-issued", action: "pause", expectedVideoId: "aaaaaaaaaaa" };
  assert.equal((await request("control", expired)).error, "command_expired");
  assert.equal((await request("exchange", observation)).command, null);
  const payload = { ...expired, id: "issued-without-ack" };
  const pending = request("control", payload);
  let issued;
  for (let i = 0; i < 30 && !issued; i++) {
    issued = (await request("exchange", observation)).command;
    if (!issued) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(issued);
  assert.equal((await pending).error, "control_unconfirmed");
  const late = await request("exchange", {
    ...observation,
    result: { id: issued.id, sessionId: issued.sessionId, ok: true },
  });
  assert.equal(late.ack, issued.id, "release the peer's pending acknowledgement");
  assert.equal((await request("control", payload)).error, "control_unconfirmed");
  assert.equal(late.command, null);
});

test("a delayed poll cannot reclaim the browser bridge after explicit disconnect", async (t) => {
  const bridge = createBridge(),
    connection = await bridge.listen(0);
  t.after(() => bridge.close());
  async function request(route, body) {
    const response = await fetch(`${connection.base}/api/${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await response.text();
    return response.status;
  }
  assert.equal(await request("pair", { clientId: "old-owner" }), 200);
  assert.equal(await request("exchange", { clientId: "old-owner", snapshot: {} }), 200);
  assert.equal(await request("disconnect", { clientId: "old-owner" }), 200);
  assert.equal(await request("exchange", { clientId: "old-owner", snapshot: {} }), 409);
  assert.equal(bridge.status().paired, false);
  assert.equal(await request("pair", { clientId: "new-owner" }), 200);
  assert.equal(await request("exchange", { clientId: "old-owner", snapshot: {} }), 409);
  assert.equal(await request("exchange", { clientId: "new-owner", snapshot: {} }), 200);
});

test("an old acknowledgement cannot swallow the first command from a new bridge session", async () => {
  const timers = [],
    executed = [],
    sent = [];
  const replies = [
    { paired: true, sessionId: "old", command: { id: "first", sessionId: "old", action: "pause" } },
    {
      paired: true,
      sessionId: "new",
      command: { id: "second", sessionId: "new", action: "volume", value: 37 },
    },
    { paired: true, sessionId: "new", ack: "second", command: null },
  ];
  vm.runInNewContext(fs.readFileSync(path.join(extension, "content.js"), "utf8"), {
    browser: {
      runtime: {
        sendMessage: async (message) => {
          sent.push(message);
          return replies.shift();
        },
        onMessage: { addListener: () => {} },
      },
    },
    RaveLinkYouTubeSite: {
      create: () => ({
        read: () => ({}),
        execute: async (command) => {
          executed.push(command.id);
          return { ok: true };
        },
      }),
    },
    document: {},
    location: {},
    window: { addEventListener: () => {} },
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
  });
  await flush();
  timers.shift()();
  await flush();
  assert.deepEqual(executed, ["first", "second"]);
  timers.shift()();
  await flush();
  assert.equal(sent[2].result.id, "second");
});

test("disconnect discards a command response that was already in flight", async () => {
  const local = { connection: { base: "http://127.0.0.1:5051", token: "fixture" } };
  const session = { owner: { tabId: 7, clientId: "owner" } };
  const storage = (values) => ({
    get: async (key) => ({ [key]: values[key] }),
    set: async (input) => Object.assign(values, input),
    remove: async (key) => {
      delete values[key];
    },
  });
  let handler, finishExchange;
  const started = new Promise((resolve) => {
    finishExchange = resolve;
  });
  let deliver;
  const api = {
    runtime: {
      id: "fixture",
      getURL: () => "moz-extension://fixture/popup.html",
      onMessage: {
        addListener: (fn) => {
          handler = fn;
        },
      },
    },
    storage: { local: storage(local), session: storage(session) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), {
    browser: api,
    AbortSignal,
    fetch: async (url) => {
      if (url.endsWith("/api/exchange")) {
        finishExchange();
        return new Promise((resolve) => {
          deliver = () =>
            resolve({
              ok: true,
              json: async () => ({
                sessionId: "old",
                command: { id: "late", sessionId: "old", action: "skip" },
              }),
            });
        });
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  const send = (message, sender) => new Promise((resolve) => handler(message, sender, resolve));
  const pending = send(
    { type: "tick", snapshot: {} },
    { id: "fixture", url: "https://music.youtube.com/", frameId: 0, tab: { id: 7 } },
  );
  await started;
  await send({ type: "disconnect" }, { id: "fixture", url: "moz-extension://fixture/popup.html" });
  deliver();
  const response = await pending;
  assert.equal(response.paired, false);
  assert.equal(response.command, undefined);
});
