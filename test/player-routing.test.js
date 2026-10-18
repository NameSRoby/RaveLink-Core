const test = require("node:test"),
  assert = require("node:assert/strict");
const { createFeatureRuntimeHarness } = require("./support/feature-runtime-harness");
const { createSongQueue } = require("../features/song-request/dist/domain");
const feature = require("../features/song-request/dist/main");

test("startup restores the saved desktop player and observer even with a missing or conflicting playback snapshot", async () => {
  for (const player of ["tidal", "spotify", "youtube", "soundcloud"]) {
    const snapshot = createSongQueue().exportSnapshot();
    const storage = new Map([
      ["player-preferences-v1", { player }],
      ["queue-state-v1", snapshot],
    ]);
    const controls = [];
    const harness = createFeatureRuntimeHarness(feature, {
      providers: {
        "ravelink.storage.v1/get": ({ key }) => ({
          ok: true,
          found: storage.has(key),
          value: storage.get(key),
        }),
        "ravelink.storage.v1/set": ({ key, value }) => {
          storage.set(key, value);
          return { ok: true };
        },
        "media.windows.now-playing.v1/control": (payload) => {
          controls.push(payload);
          return { ok: true };
        },
      },
    });
    try {
      await harness.start();
      const state = await harness.request("song.playback.read.v1", "status", {});
      assert.equal(state.playbackSource, player);
      assert.deepEqual(
        controls,
        ["tidal", "spotify"].includes(player)
          ? [{ action: "select", provider: player }, { action: "start" }]
          : [{ action: "stop" }],
      );
    } finally {
      await harness.stop();
    }
  }
});

test("selected player exclusively owns shared intake and inactive player endpoints cannot submit or pull", async (t) => {
  const storage = new Map(),
    lookups = [];
  let harness,
    switchDuringLookup = false;
  const track = (provider) => ({
    provider,
    providerItemId:
      provider === "youtube" ? "abcdefghijk" : provider === "spotify" ? "A".repeat(22) : "12345",
    title: provider + " song",
    artists: ["Artist"],
    durationMs: 1000,
  });
  const providers = {
    "ravelink.storage.v1/get": (input) => ({
      ok: true,
      value: storage.get(input.key),
      found: storage.has(input.key),
    }),
    "ravelink.storage.v1/set": (input) => {
      storage.set(input.key, input.value);
      return { ok: true };
    },
  };
  for (const [name, cap] of Object.entries({
    youtube: "youtube.catalog.host.v1",
    tidal: "tidal.desktop.experimental.v1",
    spotify: "spotify.desktop.host.v1",
    soundcloud: "soundcloud.catalog.host.v1",
  })) {
    providers[cap + "/resolve"] = async () => {
      lookups.push(name);
      if (switchDuringLookup) {
        switchDuringLookup = false;
        await harness.request("song.player.preferences.v1", "select", {
          player: "spotify",
        });
      }
      return { ok: true, candidate: track(name) };
    };
    providers[cap + "/status"] = () => ({
      ok: true,
      enabled: true,
      ready: false,
      capacity: { available: 0 },
    });
    providers[cap + "/manage-companion"] = () => ({ installed: false });
  }
  harness = createFeatureRuntimeHarness(feature, { providers });
  await harness.start();
  t.after(() => harness.stop());
  for (const player of ["spotify", "tidal", "soundcloud", "youtube"]) {
    assert.equal(
      (
        await harness.request("song.player.preferences.v1", "select", {
          player,
        })
      ).ok,
      true,
    );
    const before = lookups.length;
    const result = await harness.request("song.queue.submit.v1", "submit", {
      requestId: player,
      requesterId: "viewer-" + player,
      requesterName: "Viewer",
      query: "Artist song",
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(lookups.slice(before), [player]);
    assert.equal(result.entry.candidate.provider, player);
    if (player !== "youtube")
      assert.equal(
        (
          await harness.request("song.playback.driver.v1", "pull", {
            driverId: "stale-youtube-tab",
            providers: ["youtube"],
          })
        ).action,
        null,
      );
    for (const [other, capability, method] of [
      ["spotify", "song.spotify.player.v1", "submit"],
      ["tidal", "song.tidal.experimental.v1", "submit"],
      ["soundcloud", "song.soundcloud.player.v1", "submit-query"],
    ]) {
      if (other !== player)
        assert.equal(
          (await harness.request(capability, method, { query: "Artist song" })).code,
          "player_inactive",
        );
    }
  }
  switchDuringLookup = true;
  const interrupted = await harness.request("song.queue.submit.v1", "submit", {
    requestId: "interrupted",
    requesterId: "other",
    query: "Artist song",
  });
  assert.equal(interrupted.reason, "player_inactive");
  assert.equal((await harness.request("song.queue.read.v1", "status", {})).counts.queued, 4);
});

test("a managed lease cannot cross providers and switching suspends it without deleting requests", () => {
  const queue = createSongQueue({
    requestProviders: ["youtube", "soundcloud"],
  });
  queue.submit({
    requestId: "one",
    requesterId: "viewer",
    query: "Song",
    candidate: {
      provider: "youtube",
      providerItemId: "abcdefghijk",
      title: "Song",
      durationMs: 1000,
    },
  });
  queue.moderate({ action: "playback_start" });
  assert.equal(
    queue.pull({ driverId: "same-tab", providers: ["youtube"] }).action.candidate.provider,
    "youtube",
  );
  assert.equal(queue.pull({ driverId: "same-tab", providers: ["soundcloud"] }).action, null);
  queue.configurePlaybackSource({ source: "soundcloud", suspend: true });
  assert.equal(queue.playbackStatus().managed, null);
  assert.equal(queue.status().counts.queued, 1);
});

test("inactive native workers hold requests rather than dispatching them", async () => {
  const queue = createSongQueue({ requestProviders: ["spotify", "tidal"] });
  let calls = 0;
  const context = {
    callCapability: async () => {
      calls++;
      return { ready: true, capacity: { available: 10 } };
    },
  };
  for (const provider of ["spotify", "tidal"])
    queue.submit({
      requestId: provider,
      requesterId: provider,
      query: provider,
      candidate: {
        provider,
        providerItemId: provider === "spotify" ? "A".repeat(22) : "123",
        title: provider,
        durationMs: 1000,
      },
    });
  const spotify = require("../features/song-request/dist/spotify-player")({
    queue,
    context,
    changed() {},
    isSelected: async () => false,
  });
  const tidal = require("../features/song-request/dist/experimental-tidal")({
    queue,
    context,
    changed() {},
    isSelected: async () => false,
  });
  await spotify("flush");
  await tidal("flush");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(queue.status().counts.queued, 2);
  spotify.stop();
  tidal.stop();
});
