const test = require("node:test"),
  assert = require("node:assert/strict"),
  express = require("express");
const createHost = require("../integrations/spotify-desktop/host-bridge.cjs");
const createWorker = require("../integrations/spotify-desktop/connection-worker.cjs");
const createAdapter = require("../integrations/spotify-desktop/desktop-adapter.cjs");
const createFacade = require("../integrations/spotify-desktop/native-facade.cjs");
const A = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA";
async function setup(t, options = {}) {
  const host = createHost({ timeoutMs: 1000, ...options }),
    app = express();
  app.use("/api/spotify/bridge", host.router());
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const coreUrl = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    host.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const post = (route, data, headers = {}) =>
    fetch(coreUrl + "/api/spotify/bridge/" + route, {
      method: "POST",
      headers: {
        authorization: "Bearer " + host.pairing().token,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(data),
    });
  return { host, coreUrl, post };
}

test("paired Spotify connection delivers normalized lookup and mutation results and reuses request receipts", async (t) => {
  const { host, coreUrl } = await setup(t),
    actions = [];
  const client = {
    search: async (query) => ({
      ok: true,
      candidates: [
        {
          uri: A,
          title: query,
          artists: ["Artist"],
          accessToken: "must-not-leak",
        },
      ],
    }),
    append: async (uri) => {
      actions.push(uri);
      return {
        ok: true,
        delivery: "confirmed",
        uri,
        uid: "entry-1",
        privateToken: "must-not-leak",
      };
    },
  };
  const worker = createWorker(client, {
    coreUrl,
    token: host.pairing().token,
    clientId: "desktop",
  });
  await worker.step();
  assert.equal(host.status().connected, true);
  const search = host.invoke("search", { query: "Artist and title" }, "lookup-1");
  await worker.step();
  const found = await search;
  assert.equal(found.candidates[0].providerItemId, "AAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(JSON.stringify(found).includes("must-not-leak"), false);
  const delivery = host.invoke("append", { uri: A }, "request-1");
  await Promise.all([worker.step(), worker.step()]);
  assert.equal((await delivery).delivery, "confirmed");
  assert.equal(actions.length, 1);
  assert.equal((await host.invoke("append", { uri: A }, "request-1")).uid, "entry-1");
  assert.equal(actions.length, 1);
  assert.equal(
    (await host.invoke("remove", { uri: A, uid: "entry-1" }, "request-1")).error,
    "spotify_request_id_conflict",
  );
  assert.equal(JSON.stringify(host.status()).includes(host.pairing().token), false);
  worker.close();
});

test("lost result acknowledgement retries the receipt without replaying the Spotify queue operation", async (t) => {
  const { host, coreUrl } = await setup(t);
  let writes = 0,
    dropped = false;
  const worker = createWorker(
    {
      append: async (uri) => {
        writes++;
        return { ok: true, delivery: "confirmed", uri, uid: "one" };
      },
    },
    {
      coreUrl,
      token: host.pairing().token,
      clientId: "desktop",
      fetch: async (url, options) => {
        const response = await fetch(url, options);
        if (url.pathname.endsWith("/result") && !dropped) {
          dropped = true;
          await response.arrayBuffer();
          throw Error("Simulated connection dropped after the server accepted the receipt");
        }
        return response;
      },
    },
  );
  await worker.step();
  const pending = host.invoke("append", { uri: A }, "request-1");
  await worker.step();
  assert.equal((await pending).delivery, "confirmed");
  assert.equal(worker.status().awaitingReceipt, true);
  await worker.step();
  assert.equal(worker.status().awaitingReceipt, false);
  assert.equal(writes, 1);
});

test("Spotify keeps its authenticated heartbeat alive while a result acknowledgement waits", async (t) => {
  const { host, coreUrl } = await setup(t);
  let releaseReceipt, receiptStarted, heartbeatSeen;
  const waiting = new Promise((resolve) => {
    receiptStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseReceipt = resolve;
  });
  const heartbeat = new Promise((resolve) => {
    heartbeatSeen = resolve;
  });
  let writes = 0,
    heartbeats = 0;
  const worker = createWorker(
    {
      append: async (uri) => {
        writes++;
        return { ok: true, delivery: "confirmed", uri, uid: "one" };
      },
    },
    {
      coreUrl,
      token: host.pairing().token,
      clientId: "heartbeat",
      fetch: async (url, options) => {
        if (url.pathname.endsWith("/result")) {
          receiptStarted();
          await gate;
        }
        const response = await fetch(url, options);
        if (url.pathname.endsWith("/heartbeat")) {
          heartbeats++;
          heartbeatSeen();
        }
        return response;
      },
    },
  );
  t.after(() => {
    releaseReceipt();
    worker.close();
  });
  await worker.step();
  const result = host.invoke("append", { uri: A }, "slow-ack");
  const operation = worker.step();
  await waiting;
  for (let i = 0; i < 10; i++) assert.equal(worker.step(), operation);
  await heartbeat;
  assert.equal(heartbeats, 1);
  assert.equal(host.status().connected, true);
  assert.equal(host.status().pending, 1, "heartbeats do not settle pending writes");
  releaseReceipt();
  await operation;
  assert.equal((await result).delivery, "confirmed");
  assert.equal(writes, 1);
});

test("Spotify reconnects after a host session change without resending an old native write", async () => {
  let session = "old-session",
    queued = null,
    writes = 0,
    dropAck = true;
  const worker = createWorker(
    {
      append: async (uri) => {
        writes++;
        return { ok: true, delivery: "confirmed", uri, uid: "one" };
      },
    },
    {
      coreUrl: "http://127.0.0.1:5050",
      token: "a".repeat(64),
      clientId: "reconnect",
      fetch: async (url, options) => {
        const input = JSON.parse(options.body);
        const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
        if (url.pathname.endsWith("/hello")) return reply({ ok: true, sessionId: session });
        if (input.sessionId !== session)
          return reply({ ok: false, error: "spotify_companion_session_required" }, 409);
        if (url.pathname.endsWith("/result")) {
          if (dropAck) {
            dropAck = false;
            throw Error("lost acknowledgement");
          }
          return reply({ ok: true });
        }
        const command = queued;
        queued = null;
        return reply({ ok: true, command });
      },
    },
  );
  try {
    await worker.step();
    queued = { id: "same-write", lease: "1".repeat(32), kind: "append", payload: { uri: A } };
    await worker.step();
    assert.equal(worker.status().awaitingReceipt, true);
    session = "new-session";
    await worker.step();
    assert.equal(worker.status().paired, false);
    queued = { id: "same-write", lease: "2".repeat(32), kind: "append", payload: { uri: A } };
    await worker.step();
    assert.equal(worker.status().paired, true);
    assert.equal(worker.status().awaitingReceipt, false);
    assert.equal(writes, 1, "recovery reuses the cached outcome rather than executing again");
  } finally {
    worker.close();
  }
});

test("Spotify bridge rejects foreign origins, missing pairing, stale sessions and forged result leases", async (t) => {
  const { host, coreUrl, post } = await setup(t);
  assert.equal(
    (await post("hello", { clientId: "desktop" }, { authorization: "Bearer invalid" })).status,
    401,
  );
  assert.equal(
    (await post("hello", { clientId: "desktop" }, { authorization: host.pairing().token })).status,
    401,
  );
  assert.equal(
    (await post("hello", { clientId: "desktop" }, { origin: "https://example.com" })).status,
    403,
  );
  const preflight = await fetch(coreUrl + "/api/spotify/bridge/hello", {
    method: "OPTIONS",
    headers: { origin: "https://xpui.app.spotify.com" },
  });
  assert.equal(preflight.status, 204);
  assert.equal((await post("hello", { clientId: "desktop" })).status, 200);
  assert.equal((await post("hello", { clientId: "another-client" })).status, 409);
  assert.equal((await post("next", { clientId: "desktop", sessionId: "stale" })).status, 409);
  const session = { clientId: "desktop", sessionId: host.pairing().sessionId },
    pending = host.invoke("append", { uri: A }, "request-1");
  const { command } = await (await post("next", session)).json();
  assert.equal(
    (
      await post("result", {
        ...session,
        id: command.id,
        lease: "wrong",
        result: { ok: true },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await post("result", {
        ...session,
        id: command.id,
        lease: command.lease,
        result: { ok: true, delivery: "confirmed", uri: A, uid: "one" },
      })
    ).status,
    200,
  );
  assert.equal((await pending).uid, "one");
  assert.throws(
    () => createWorker({}, { coreUrl: "https://example.com", token: host.pairing().token }),
    /pairing_invalid/,
  );
});

test("expired issued writes remain unconfirmed and are never reissued after a missing receipt", async (t) => {
  const { host, post } = await setup(t, { timeoutMs: 50 });
  await post("hello", { clientId: "desktop" });
  const session = { clientId: "desktop", sessionId: host.pairing().sessionId };
  const pending = host.invoke("append", { uri: A }, "request-1");
  const first = await (await post("next", session)).json();
  assert.equal(first.command.id, "request-1");
  assert.equal((await (await post("next", session)).json()).command, null);
  const expired = await pending;
  assert.equal(expired.error, "spotify_delivery_unconfirmed");
  assert.equal(expired.retrySafe, false);
  assert.equal(
    (await host.invoke("append", { uri: A }, "request-1")).error,
    "spotify_delivery_unconfirmed",
  );
  assert.equal(host.status().reviewRequired, 1);
});

test("paired playlist reading is bounded and strips unrelated account fields", async (t) => {
  const { host, coreUrl } = await setup(t),
    worker = createWorker(
      {
        playlist: async () => ({
          ok: true,
          name: "Source",
          total: 1,
          tracks: [
            {
              providerItemId: "A".repeat(22),
              title: "Song",
              artists: ["Artist"],
              album: "Album",
              privateToken: "must-not-leak",
            },
          ],
        }),
      },
      { coreUrl, token: host.pairing().token, clientId: "playlist-reader" },
    );
  t.after(() => worker.close());
  await worker.step();
  const reply = host.invoke(
    "playlist",
    { action: "read", id: "spotify:playlist:" + "B".repeat(22), offset: 0 },
    "read-list",
  );
  await worker.step();
  const result = await reply;
  assert.equal(result.tracks[0].album, "Album");
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(
    (await host.invoke("playlist", { action: "append", id: "B".repeat(22) }, "bad-write")).ok,
    false,
  );
});

test("native playlist transfer receipts carry long Unicode pages and acknowledge writes without replaying them", async (t) => {
  const { host, coreUrl } = await setup(t),
    playlist = "spotify:playlist:" + "B".repeat(22),
    entries = [];
  let created = 0,
    appended = 0;
  const platform = {
    RootlistAPI: {
      createPlaylist: async () => {
        created++;
        return playlist;
      },
    },
    PlaylistAPI: {
      add: async (id, tracks) => {
        assert.equal(id, playlist);
        appended++;
        entries.push(...tracks);
      },
      getPlaylist: async (_id, _options, page) => ({
        metadata: { isLoaded: true, name: "Long source", totalLength: 25 },
        contents: {
          items: Array.from({ length: Math.min(25 - page.offset, 25) }, () => ({
            uri: A,
            name: "曲".repeat(200),
            artists: Array.from({ length: 8 }, () => ({
              name: "名".repeat(100),
            })),
            album: { name: "盤".repeat(200) },
          })),
        },
      }),
    },
  };
  const worker = createWorker(createAdapter(createFacade(platform)), {
    coreUrl,
    token: host.pairing().token,
    clientId: "transfers",
  });
  t.after(() => worker.close());
  await worker.step();
  const read = host.invoke("playlist", { action: "read", id: playlist, offset: 0 }, "long-page");
  await worker.step();
  const page = await read;
  assert.equal(page.ok, true);
  assert.ok(page.tracks.length > 0 && page.tracks.length < 25);
  assert.equal(Number(page.cursor), page.tracks.length);
  assert.equal(worker.status().awaitingReceipt, false);
  const create = host.invoke(
    "playlist",
    { action: "create", name: "Transferred" },
    "create-playlist",
  );
  await worker.step();
  assert.equal((await create).id, playlist);
  const append = host.invoke(
    "playlist",
    { action: "append", id: playlist, ids: [A, A] },
    "append-playlist",
  );
  await worker.step();
  assert.equal((await append).ok, true);
  assert.equal(
    (
      await host.invoke(
        "playlist",
        { action: "append", id: playlist, ids: [A, A] },
        "append-playlist",
      )
    ).ok,
    true,
  );
  assert.equal(created, 1);
  assert.equal(appended, 1);
  assert.deepEqual(entries, [A, A]);
});
