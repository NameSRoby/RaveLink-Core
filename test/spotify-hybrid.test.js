const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const create = require("../integrations/spotify-desktop/playback-provider.cjs");
const URI = "spotify:track:" + "A".repeat(22);
function fixture(t) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-hybrid-")),
    root = path.join(runtimeDir, "spotify-desktop");
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(root, "premium-device.json"),
    JSON.stringify({ deviceId: "device-a" }),
  );
  const calls = [],
    nativeRows = [],
    officialRows = [];
  let connected = true,
    nativeId = "device-a",
    authConnected = true;
  const current = (uid) => ({
    uri: URI,
    uid,
    title: "Track",
    trackId: "A".repeat(22),
  });
  const native = {
    status: () => ({
      ok: true,
      connected,
      ready: connected,
      deviceId: nativeId,
      controlsAvailable: connected,
      current: current("native-current"),
      capacity: { reported: connected, available: 10 },
      handoffs: nativeRows,
      installation: { prepared: true },
    }),
    handle: async (method, input) => {
      calls.push({ route: "desktop", method, input });
      if (method === "enqueue") {
        nativeRows.push({
          entryId: input.entryId,
          uri: URI,
          uid: "native-entry",
          phase: "unknown",
          trackId: "A".repeat(22),
        });
        return { ok: false, error: "spotify_delivery_unconfirmed" };
      }
      return { ok: true };
    },
    router() {},
    close() {},
  };
  const official = {
    refresh: async () => {},
    status: () => ({
      ok: true,
      connected: true,
      ready: true,
      controlsAvailable: true,
      volumeAvailable: true,
      capacity: { reported: true, available: 10 },
      current: current("api-current"),
      handoffs: officialRows,
    }),
    handle: async (method, input) => {
      calls.push({ route: "official", method, input });
      if (method === "resolve")
        return {
          ok: true,
          candidate: { provider: "spotify", providerItemId: "A".repeat(22) },
        };
      if (method === "enqueue") {
        officialRows.push({
          entryId: input.entryId,
          uri: URI,
          uid: "api-entry",
          phase: "appended",
        });
        return { ok: true, appended: true };
      }
      return { ok: true, removed: 0 };
    },
    reset() {},
  };
  const auth = { status: () => ({ connected: authConnected }), close() {} };
  const options = {
    runtimeDir,
    createAuth: () => auth,
    createDesktop: () => native,
    createPremium: () => official,
    api: {},
  };
  const provider = create(options);
  t.after(() => {
    provider.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  return {
    provider,
    options,
    calls,
    nativeRows,
    officialRows,
    offline() {
      connected = false;
    },
    mismatch() {
      nativeId = "other-device";
    },
    free() {
      authConnected = false;
    },
    reconnect() {
      connected = true;
    },
  };
}
test("one Spotify player combines official lookup/controls with verified native queue ownership", async (t) => {
  const f = fixture(t),
    status = await f.provider.handle("status");
  assert.equal(status.mode, "hybrid");
  assert.equal(status.sameDevice, true);
  assert.equal(status.queueRemoval, true);
  assert.equal((await f.provider.handle("resolve", { query: "Artist track" })).ok, true);
  assert.equal(f.calls.at(-1).route, "official");
  await f.provider.handle("control", {
    action: "skip",
    currentUid: "native-current",
  });
  assert.equal(f.calls.at(-1).route, "official");
  assert.equal(f.calls.at(-1).input.currentUid, "api-current");
  assert.equal(
    (
      await f.provider.handle("control", {
        action: "skip",
        currentUid: "stale",
      })
    ).error,
    "spotify_current_changed",
  );
  await f.provider.handle("enqueue", {
    entryId: "owned",
    candidate: { providerItemId: "A".repeat(22) },
  });
  assert.equal(f.calls.at(-1).route, "desktop");
  f.offline();
  await f.provider.handle("enqueue", {
    entryId: "owned",
    candidate: { providerItemId: "A".repeat(22) },
  });
  assert.equal(
    f.calls.at(-1).route,
    "desktop",
    "an uncertain native write cannot fall back to the official API",
  );
  await f.provider.handle("enqueue", {
    entryId: "new-request",
    candidate: { providerItemId: "B".repeat(22) },
  });
  assert.equal(f.calls.at(-1).route, "official");
  f.reconnect();
  const next = await f.provider.handle("status");
  assert.equal(next.capacity.queued, 2);
  assert.equal(next.handoffs.find((row) => row.entryId === "owned").nativeRemoval, true);
  assert.equal(next.handoffs.find((row) => row.entryId === "new-request").nativeRemoval, false);
  const restarted = create(f.options);
  t.after(() => restarted.close());
  f.offline();
  await restarted.handle("enqueue", {
    entryId: "owned",
    candidate: { providerItemId: "A".repeat(22) },
  });
  assert.equal(f.calls.at(-1).route, "desktop", "transport binding survives Core restart");
});
test("hybrid refuses to mix distinct devices, shares one ten-slot limit, and needs no OAuth for Free", async (t) => {
  const f = fixture(t);
  f.mismatch();
  let state = await f.provider.handle("status");
  assert.equal(state.mode, "official");
  assert.equal(state.sameDevice, false);
  assert.equal(state.queueRemoval, false);
  await f.provider.handle("enqueue", {
    entryId: "remote",
    candidate: { providerItemId: "A".repeat(22) },
  });
  assert.equal(f.calls.at(-1).route, "official");
  for (let index = 0; index < 9; index++)
    f.nativeRows.push({ entryId: "native-" + index, phase: "unknown" });
  assert.equal(
    (
      await f.provider.handle("enqueue", {
        entryId: "overflow",
        candidate: { providerItemId: "A".repeat(22) },
      })
    ).error,
    "spotify_native_queue_full",
  );
  f.free();
  state = await f.provider.handle("status");
  assert.equal(state.mode, "desktop");
  assert.equal(state.account.connected, false);
});
