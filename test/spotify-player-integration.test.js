const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  express = require("express");
const createProvider = require("../integrations/spotify-desktop/provider.cjs");
const createWorker = require("../integrations/spotify-desktop/connection-worker.cjs");
const createFacade = require("../integrations/spotify-desktop/native-facade.cjs");
const {
  installRequestSecurityMiddleware,
} = require("../src/app/runtime/request-security.middleware");
const { createSongQueue } = require("../features/song-request/dist/domain");
const createPlayer = require("../features/song-request/dist/spotify-player");
const URI = "spotify:track:AAAAAAAAAAAAAAAAAAAAAA";

test("Spotify launch returns immediately, deduplicates pending launches and exposes a later failure", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-launch-"));
  fs.mkdirSync(path.join(root, "spotify-desktop"));
  fs.writeFileSync(
    path.join(root, "spotify-desktop/installation.json"),
    JSON.stringify({ id: "fixture" }),
  );
  let rejectLaunch,
    launches = 0;
  const provider = createProvider({
    runtimeDir: root,
    launch: () => {
      launches++;
      return new Promise((resolve, reject) => {
        rejectLaunch = reject;
      });
    },
  });
  t.after(() => {
    provider.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const response = await provider.handle("setup", { action: "launch" });
  assert.deepEqual(response, { ok: true, launching: true });
  assert.equal(provider.status().launching, true);
  await provider.handle("setup", { action: "launch" });
  assert.equal(launches, 1);
  rejectLaunch(Error("spotify_close_client_required"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.status().launching, false);
  assert.equal(provider.status().launchError, "spotify_close_client_required");
});

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-host-"));
  const provider = createProvider({ runtimeDir: root, discover: () => [] });
  const app = express();
  installRequestSecurityMiddleware(app, { express });
  app.use("/api/spotify/bridge", provider.router());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const coreUrl = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    provider.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const token = JSON.parse(fs.readFileSync(path.join(root, "spotify-desktop/pairing.json"))).token;
  const queue = [];
  let localDevice = true,
    current = {
      uri: "spotify:track:BBBBBBBBBBBBBBBBBBBBBB",
      uid: "personal-current",
      paused: true,
    },
    count = 0;
  const client = {
    snapshot: () => ({
      ok: true,
      complete: true,
      localDevice,
      queue: [...queue],
      current,
    }),
    search: async () => ({
      ok: true,
      candidates: [
        {
          uri: URI,
          providerItemId: URI.slice(14),
          title: "One More Time",
          artists: ["Daft Punk"],
          durationMs: 300000,
        },
      ],
    }),
    lookup: async () => client.search(),
    append: async (uri) => {
      const uid = "native-" + ++count;
      queue.push({ uri, uid, origin: "manual" });
      return { ok: true, delivery: "confirmed", uri, uid };
    },
    remove: async (item) => {
      const index = queue.findIndex((row) => row.uid === item.uid);
      if (index >= 0) queue.splice(index, 1);
      return { ok: true, removed: true };
    },
    control: async () => ({ ok: true, accepted: true }),
  };
  const worker = createWorker(client, {
    coreUrl,
    token,
    clientId: "desktop",
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        headers: { ...init.headers, origin: "https://xpui.app.spotify.com" },
      }),
  });
  await worker.step();
  async function complete(operation) {
    let finished = false;
    operation.finally(() => {
      finished = true;
    });
    for (let i = 0; i < 30 && !finished; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await worker.step();
    }
    return operation;
  }
  return {
    root,
    provider,
    worker,
    queue,
    complete,
    remote: () => {
      localDevice = false;
    },
    advance: () => {
      current = {
        ...queue.shift(),
        title: "One More Time",
        artists: ["Daft Punk"],
        durationMs: 300000,
        positionMs: 1000,
        paused: false,
      };
    },
  };
}

test("Spotify host admits ten native requests, keeps ownership, refills after advancement and removes one exact occurrence", async (t) => {
  const f = await setup(t);
  const resolved = await f.complete(
    f.provider.handle("resolve", { query: "Daft Punk One More Time" }),
  );
  assert.equal(resolved.ok, true);
  for (let index = 0; index < 10; index++) {
    const result = await f.complete(
      f.provider.handle("enqueue", {
        entryId: "request-" + index,
        candidate: resolved.candidate,
        requesterKey: "viewer-" + index,
        requesterLabel: "Viewer " + index,
      }),
    );
    assert.equal(result.appended, true);
  }
  assert.equal(f.provider.status().capacity.available, 0);
  const full = await f.provider.handle("enqueue", {
    entryId: "eleven",
    candidate: resolved.candidate,
  });
  assert.equal(full.error, "spotify_native_queue_full");
  assert.equal(f.queue.length, 10);
  assert.equal(
    (
      await f.provider.handle("enqueue", {
        entryId: "request-0",
        candidate: resolved.candidate,
      })
    ).appended,
    true,
  );
  assert.equal(f.queue.length, 10);
  f.advance();
  await f.worker.step();
  assert.equal(f.provider.status().capacity.available, 1);
  assert.equal(f.provider.status().current.requesterLabel, "Viewer 0");
  await f.complete(
    f.provider.handle("enqueue", {
      entryId: "eleven",
      candidate: resolved.candidate,
    }),
  );
  assert.equal(f.queue.length, 10);
  const removed = await f.complete(f.provider.handle("remove", { entryId: "request-5" }));
  assert.equal(removed.removed, 1);
  assert.equal(
    f.queue.some((row) => row.uid === "native-6"),
    false,
  );
  assert.equal(
    f.queue.some((row) => row.uid === "native-7"),
    true,
  );
  assert.equal(JSON.stringify(f.provider.status()).includes("token"), false);
  f.remote();
  await f.worker.step();
  assert.equal(f.provider.status().ready, false);
  assert.equal(
    (
      await f.provider.handle("enqueue", {
        entryId: "remote",
        candidate: resolved.candidate,
      })
    ).error,
    "spotify_local_device_unverified",
  );
});

test("Spotify request journal holds interrupted deliveries across host restart without issuing another append", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = createProvider({ runtimeDir: root });
  first.close();
  fs.writeFileSync(
    path.join(root, "spotify-desktop/requests.json"),
    JSON.stringify([{ entryId: "interrupted", uri: URI, phase: "pending" }]),
  );
  const second = createProvider({ runtimeDir: root });
  t.after(() => second.close());
  assert.equal(second.status().handoffs[0].phase, "unknown");
  assert.equal(second.status().capacity.queued, 1);
  assert.equal(
    (
      await second.handle("enqueue", {
        entryId: "interrupted",
        candidate: { providerItemId: URI.slice(14) },
      })
    ).error,
    "spotify_delivery_needs_review",
  );
});

test("Spotify feature drains requests in FIFO order, retains overflow locally and applies song-specific restrictions", async () => {
  const queue = createSongQueue({ requestProviders: ["spotify"] });
  let available = 2;
  const sent = [];
  const player = createPlayer({
    queue,
    changed: () => {},
    context: {
      callCapability: async (_cap, method, payload) => {
        if (method === "status") return { ready: true, capacity: { available }, handoffs: [] };
        if (method === "enqueue") {
          sent.push(payload.entryId);
          available--;
          return { ok: true, appended: true };
        }
        return { ok: true, removed: 0 };
      },
    },
  });
  for (let index = 0; index < 3; index++)
    queue.submit({
      requestId: "fifo-" + index,
      requesterId: "viewer",
      query: "Song " + index,
      candidate: {
        provider: "spotify",
        providerItemId: String(index).repeat(22),
        title: "Song " + index,
        artists: [],
        durationMs: 1000,
      },
    });
  const expected = queue.status().queue.map((row) => row.id);
  await player("flush");
  for (let i = 0; i < 20 && (await player("status")).delivery.processing; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(sent, expected.slice(0, 2));
  assert.equal(queue.status().counts.queued, 1);
  const result = await player("moderate", {
    action: "block_song",
    provider: "spotify",
    providerItemId: "2".repeat(22),
  });
  assert.equal(result.ok, true);
  assert.equal(queue.status().counts.queued, 0);
  player.stop();
});

test("Spotify modern registry resolves only named services and checks the active local device", () => {
  let active = { isLocal: true, isActive: true },
    sent;
  const player = {
    _state: {
      isPaused: false,
      duration: 1000,
      positionAsOfTimestamp: 100,
      timestamp: Date.now(),
    },
    _queue: {
      getInternalQueue: () => ({
        nextTracks: [{ contextTrack: { uri: URI, uid: "native" }, provider: "queue" }],
        track: null,
      }),
    },
  };
  const services = new Map([
    [Symbol.for("PlayerAPI"), player],
    [Symbol.for("ConnectDevicesAPI"), { getActiveDevice: () => active }],
    [
      Symbol.for("RequestBuilder"),
      {
        build() {
          const request = {
            withHost(value) {
              sent = value;
              return request;
            },
            withPath() {
              return request;
            },
            withQueryParameters() {
              return request;
            },
            withMethod() {
              return request;
            },
            send: async () => ({ body: { tracks: { items: [] } } }),
          };
          return request;
        },
      },
    ],
  ]);
  const facade = createFacade({
    getRegistry: () => ({ resolve: (symbol) => services.get(symbol) }),
  });
  assert.equal(facade.localDevice(), true);
  assert.equal(facade.snapshot().queue[0].uid, "native");
  active = { isLocal: false, isActive: true };
  assert.equal(facade.localDevice(), false);
  return facade.CosmosAsync.get(
    "https://api.spotify.com/v1/search?q=artist&type=track&limit=10",
  ).then(() => assert.equal(sent, "https://api.spotify.com"));
});
