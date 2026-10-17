const test = require("node:test");
const assert = require("node:assert/strict");
const { createFeatureRuntimeHarness } = require("./support/feature-runtime-harness");
const feature = require("../features/song-request/dist/main");

const submission = {
  requestId: "request-1",
  requesterId: "viewer-1",
  query: "YouTube track",
  candidate: {
    provider: "youtube",
    providerItemId: "dQw4w9WgXcQ",
    title: "YouTube track",
    artists: [],
    durationMs: 0,
  },
};

test("SoundCloud source uses confirmed local metadata without starting a Windows observer or changing playback", async (t) => {
  const controls = [];
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers: {
      "ravelink.storage.v1/get": async (input) => ({
        ok: true,
        value: input.key === "player-preferences-v1" ? { player: "soundcloud" } : undefined,
      }),
      "media.windows.now-playing.v1/control": async (input) => {
        controls.push(input);
        return { ok: false, supported: false, lifecycle: "unavailable" };
      },
    },
  });
  await harness.start();
  t.after(() => harness.stop());
  const select = (source) =>
    harness.request("song.observer.admin.v1", "control", {
      action: "select",
      source,
    });
  assert.equal((await select("soundcloud")).lifecycle, "local");
  assert.deepEqual(
    controls.map((row) => row.action),
    ["stop"],
  );
  assert.equal((await harness.request("song.observer.admin.v1", "status", null)).ok, true);
  await harness.request("song.observer.admin.v1", "control", {
    action: "start",
  });
  assert.equal(controls.length, 1, "local source status/start never launch a Windows worker");
  const sound = {
    id: 123,
    title: "SoundCloud fixture",
    user: { username: "Artist" },
    album: "Fixture album",
    artwork_url: "https://i1.sndcdn.com/artworks-fixture-large.jpg",
    duration: 180000,
  };
  await harness.request("song.soundcloud.player.v1", "submit", {
    requestId: "source-fixture",
    sound,
  });
  await harness.request("song.soundcloud.player.v1", "start", {});
  const lease = (
    await harness.request("song.playback.driver.v1", "pull", {
      driverId: "fixture",
      providers: ["soundcloud"],
    })
  ).action;
  await harness.request("song.playback.driver.v1", "acknowledge", {
    driverId: "fixture",
    leaseId: lease.leaseId,
    state: "started",
    positionMs: 12000,
    durationMs: 180000,
  });
  const playback = await harness.request("song.playback.read.v1", "status", null);
  assert.equal(playback.primary.candidate.title, sound.title);
  assert.equal(playback.primary.candidate.album, sound.album);
  assert.equal(playback.primary.candidate.artworkUrl, sound.artwork_url);
  assert.equal(playback.primary.positionMs, 12000);
  await select("youtube");
  const other = await harness.request("song.playback.read.v1", "status", null);
  assert.equal(other.primary, null, "a selected local source must not display a different player");
  assert.equal(other.managed.status, "playing", "changing overlay source never stops music");
  await select("soundcloud");
  assert.equal(
    (await harness.request("song.playback.read.v1", "status", null)).primary.candidate.provider,
    "soundcloud",
  );
});

test("local completion never attempts a second Twitch settlement and failed reward sync is visible", async (t) => {
  let settlements = 0;
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers: {
      "twitch.redemptions.v1/settle": async () => {
        settlements++;
        return { ok: true };
      },
      "twitch.rewards.manage.v1/set-paused": async () => ({
        ok: false,
        error: "twitch_not_connected",
      }),
    },
  });
  await harness.start();
  t.after(() => harness.stop());
  const entry = await harness.request("song.queue.submit.v1", "submit", submission);
  assert.equal(
    (
      await harness.request("song.queue.admin.v1", "settle", {
        entryId: entry.entry.id,
        outcome: "played",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await harness.request("song.queue.admin.v1", "moderate", {
        action: "pause",
      })
    ).paused,
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const status = await harness.request("song.queue.read.v1", "status", null);
  assert.equal(status.integrations.rewardPause.lastError, "twitch_not_connected");
  assert.equal(status.integrations.rewardPause.failed, 1);
  assert.equal(settlements, 0);
});

test("Song Request works when every optional host adapter is absent", async () => {
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
  });
  await harness.start();
  const accepted = await harness.request("song.queue.submit.v1", "submit", submission);
  assert.equal(accepted.ok, true);
  assert.equal((await harness.request("song.queue.read.v1", "status", null)).counts.queued, 1);
  await harness.stop();
});

test("intake pause synchronizes only the managed Song Request Twitch reward", async () => {
  const updates = [];
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers: {
      "twitch.rewards.manage.v1/set-paused": async (payload) => {
        updates.push(payload);
        return { ok: true };
      },
    },
  });
  await harness.start();
  assert.equal(
    (
      await harness.request("song.queue.admin.v1", "moderate", {
        action: "pause",
      })
    ).paused,
    true,
  );
  assert.equal(
    (
      await harness.request("song.queue.admin.v1", "moderate", {
        action: "resume",
      })
    ).paused,
    false,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [
    { purpose: "song_request", paused: true },
    { purpose: "song_request", paused: false },
  ]);
  await harness.stop();
});

test("hosted Song Request accepts only playable YouTube references", async () => {
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
  });
  await harness.start();
  const rejected = await harness.request("song.queue.submit.v1", "submit", {
    requestId: "spotify-request",
    requesterId: "viewer-1",
    query: "Spotify track",
    candidate: {
      provider: "spotify",
      providerItemId: "track-1",
      title: "Spotify track",
    },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "youtube_reference_required");
  assert.equal((await harness.request("song.queue.read.v1", "status", null)).counts.queued, 0);
  await harness.stop();
});

test("hosted mode restores and writes bounded snapshots without requiring response adapters", async () => {
  let saved = null;
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers: {
      "ravelink.storage.v1/get": async () => ({
        ok: true,
        found: false,
        value: null,
      }),
      "ravelink.storage.v1/set": async (payload) => {
        if (payload.key === "queue-state-v1") saved = payload.value;
        return { ok: true };
      },
    },
  });
  await harness.start();
  await harness.request("song.queue.submit.v1", "submit", submission);
  await harness.stop();
  assert.equal(saved.version, 12);
  assert.equal(saved.volumeFloorPercent, 0);
  assert.equal(saved.volumeCeilingPercent, 40);
  assert.equal(saved.queue.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 2 * 1024 * 1024);
});

test("completed chat requests are archived only when history is enabled and survive restart", async () => {
  const storage = new Map();
  const providers = {
    "ravelink.storage.v1/get": async (payload) => ({
      ok: true,
      found: storage.has(payload.key),
      value: storage.get(payload.key),
    }),
    "ravelink.storage.v1/set": async (payload) => {
      storage.set(payload.key, structuredClone(payload.value));
      return { ok: true };
    },
    "ravelink.storage.v1/remove": async (payload) => ({
      ok: true,
      removed: storage.delete(payload.key),
    }),
  };
  const first = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers,
  });
  await first.start();
  const initial = await first.request("song.playlist.read.v1", "status", null);
  const chat = initial.collections.find((row) => row.purpose === "chat-history");
  assert.equal(chat.name, "Chat Requests");
  assert.equal(initial.history.enabled, false);
  await first.request("song.playlist.admin.v1", "mutate", {
    action: "configure_history",
    enabled: true,
    destinationId: chat.id,
  });
  const accepted = await first.request("song.queue.submit.v1", "submit", {
    requestId: "played-chat-request",
    requesterId: "viewer",
    requesterRole: "viewer",
    query: "Track",
    candidate: {
      provider: "youtube",
      providerItemId: "dQw4w9WgXcQ",
      title: "Track",
      artists: [],
      durationMs: 120000,
    },
  });
  await first.request("song.queue.admin.v1", "moderate", {
    action: "playback_start",
  });
  const pulled = await first.request("song.playback.driver.v1", "pull", {
    driverId: "test-player",
    providers: ["youtube"],
  });
  await first.request("song.playback.driver.v1", "acknowledge", {
    driverId: "test-player",
    leaseId: pulled.action.leaseId,
    state: "ended",
  });
  assert.equal(accepted.ok, true);
  await first.stop();
  assert.equal(storage.get("queue-state-v1").playlistPageCount, 0);
  assert.equal(storage.get("queue-state-v1").playlist, undefined);
  const collection = storage
    .get("playlist-library-index-v1")
    .collections.find((row) => row.purpose === "chat-history");
  assert.equal(collection.pageCount, 1);
  assert.equal(storage.get(`library-page-${collection.id}-0000`).length, 1);
  assert.equal(storage.has("playlist-page-000000"), false);

  const second = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers,
  });
  await second.start();
  const restored = await second.request("song.playlist.read.v1", "status", {
    offset: 0,
    limit: 10,
  });
  assert.equal(restored.page.total, 1);
  assert.equal(restored.tracks[0].candidate.title, "Track");
  assert.equal(restored.history.enabled, true);
  await second.stop();
});

test("completed playlist imports transfer in bounded pages and survive restart", async () => {
  const storage = new Map();
  const writes = [];
  const imported = Array.from({ length: 350 }, (_, index) => ({
    provider: "youtube",
    providerItemId: index.toString(36).padStart(11, "0"),
    title: `Imported ${index}`,
    artists: ["Artist"],
    durationMs: 120000,
  }));
  const providers = {
    "ravelink.storage.v1/get": async (payload) => ({
      ok: true,
      found: storage.has(payload.key),
      value: storage.get(payload.key),
    }),
    "ravelink.storage.v1/set": async (payload) => {
      writes.push(payload.key);
      storage.set(payload.key, structuredClone(payload.value));
      return { ok: true };
    },
    "ravelink.storage.v1/remove": async (payload) => ({
      ok: true,
      removed: storage.delete(payload.key),
    }),
    "youtube.catalog.host.v1/import-playlist-start": async () => ({
      ok: true,
      jobId: "job-1",
      state: "running",
      playlistId: "PL1234567890abc",
    }),
    "youtube.catalog.host.v1/import-playlist-status": async () => ({
      ok: true,
      jobId: "job-1",
      state: "complete",
      playlistId: "PL1234567890abc",
      title: "Imported List",
      count: imported.length,
      truncated: false,
      error: "",
    }),
    "youtube.catalog.host.v1/import-playlist-page": async (payload) => ({
      ok: true,
      items: imported.slice(payload.offset, payload.offset + payload.limit),
      total: imported.length,
    }),
  };
  const first = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers,
  });
  await first.start();
  assert.equal(
    (
      await first.request("song.playlist.admin.v1", "mutate", {
        action: "import",
        url: "https://www.youtube.com/playlist?list=PL1234567890abc",
      })
    ).ok,
    true,
  );
  const transferring = await first.request("song.playlist.read.v1", "status", {
    offset: 0,
    limit: 10,
  });
  assert.equal(transferring.import.state, "transferring");
  assert.equal(transferring.import.transferred, 300);
  const complete = await first.request("song.playlist.read.v1", "status", {
    offset: 0,
    limit: 10,
  });
  assert.equal(complete.import.state, "complete");
  assert.equal(complete.page.total, 0);
  const importedCollection = complete.collections.find((row) => row.name === "Imported List");
  assert.equal(importedCollection.count, 350);
  const selected = await first.request("song.playlist.admin.v1", "mutate", {
    action: "select",
    collectionId: importedCollection.id,
  });
  assert.equal(Object.hasOwn(selected, "tracks"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(selected)) < 1024);
  await first.stop();
  assert.equal(
    storage.get("playlist-library-index-v1").collections.find((row) => row.name === "Imported List")
      .pageCount,
    9,
  );

  writes.length = 0;
  const second = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers,
  });
  await second.start();
  const restored = await second.request("song.playlist.read.v1", "status", {
    offset: 340,
    limit: 10,
  });
  assert.equal(restored.page.total, 350);
  assert.equal(restored.tracks.length, 10);
  const deleted = await second.request("song.playlist.admin.v1", "mutate", {
    action: "delete",
    collectionId: restored.selectedId,
  });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.code, "playlist_deleted");
  assert.equal(Object.hasOwn(deleted, "tracks"), false);
  await second.request("song.queue.submit.v1", "submit", {
    requestId: "tail-write",
    requesterId: "operator",
    requesterRole: "moderator",
    query: "Tail",
    candidate: {
      provider: "youtube",
      providerItemId: "zzzzzzzzzzz",
      title: "Tail",
      artists: [],
      durationMs: 120000,
    },
  });
  await second.stop();
  assert.equal(writes.filter((key) => key.startsWith("library-page-")).length, 0);
});

test("overlay configuration has isolated read/admin contracts and emits bounded changes", async () => {
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
  });
  await harness.start();
  const initial = await harness.request("song.overlay.read.v1", "status", null);
  const changed = await harness.request("song.overlay.admin.v1", "configure", {
    config: { ...initial.config, radius: 12 },
  });
  assert.equal(changed.config.radius, 12);
  assert.ok(harness.events.some((event) => event.capability === "song.overlay.events.v1"));
  await harness.stop();
});

test("native text requests resolve through the optional YouTube catalog boundary", async () => {
  const calls = [];
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers: {
      "youtube.catalog.host.v1/status": async () => ({
        ok: true,
        configured: true,
        quota: { remaining: 8000 },
      }),
      "youtube.catalog.host.v1/configure": async (payload) => {
        calls.push(["configure", payload]);
        return { ok: true, configured: true };
      },
      "youtube.catalog.host.v1/resolve": async (payload) => {
        calls.push(["resolve", payload]);
        return {
          ok: true,
          candidate: {
            provider: "youtube",
            providerItemId: "M7lc1UVf-VE",
            title: "Resolved track",
            artists: ["Artist"],
            durationMs: 180000,
          },
        };
      },
    },
  });
  await harness.start();
  const configured = await harness.request("song.catalog.admin.v1", "configure", {
    apiKey: "fixture-catalog-key",
    policy: {
      allowNonMusic: true,
      minimumViews: 75000,
      derivatives: { cover: false },
    },
  });
  assert.equal(configured.configured, true);
  const status = await harness.request("song.catalog.read.v1", "status", null);
  assert.equal(status.policy.allowNonMusic, true);
  const accepted = await harness.request("song.queue.submit.v1", "submit", {
    requestId: "text-request",
    requesterId: "viewer-text",
    query: "Artist track",
  });
  assert.equal(accepted.entry.candidate.title, "Resolved track");
  assert.equal(calls[1][0], "resolve");
  assert.equal(calls[1][1].policy.minimumViews, 75000);
  await harness.stop();
});

test("native text lookup failures remain queue failures while direct IDs survive an absent catalog", async () => {
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers: {
      "youtube.catalog.host.v1/resolve": async () => ({
        ok: false,
        reason: "catalog_no_eligible_match",
      }),
    },
  });
  await harness.start();
  const rejected = await harness.request("song.queue.submit.v1", "submit", {
    requestId: "text-fail",
    requesterId: "viewer",
    query: "wrong video",
  });
  assert.equal(rejected.reason, "catalog_no_eligible_match");
  await harness.stop();

  const fallback = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
  });
  await fallback.start();
  assert.equal((await fallback.request("song.queue.submit.v1", "submit", submission)).ok, true);
  await fallback.stop();
});

test("managed playback uses a lease and only settles after player acknowledgement", async () => {
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
  });
  await harness.start();
  const accepted = await harness.request("song.queue.submit.v1", "submit", {
    requestId: "youtube-request-1",
    requesterId: "viewer-1",
    query: "Video",
    candidate: {
      provider: "youtube",
      providerItemId: "dQw4w9WgXcQ",
      title: "Video",
      artists: ["Artist"],
      durationMs: 212000,
    },
  });
  await harness.request("song.queue.admin.v1", "moderate", {
    action: "playback_start",
  });
  const pulled = await harness.request("song.playback.driver.v1", "pull", {
    driverId: "local-youtube",
    providers: ["youtube"],
  });
  assert.equal(pulled.code, "load");
  assert.equal(pulled.action.entryId, accepted.entry.id);
  assert.equal((await harness.request("song.queue.read.v1", "status", null)).counts.queued, 1);
  assert.equal(
    (
      await harness.request("song.playback.driver.v1", "acknowledge", {
        driverId: "local-youtube",
        leaseId: "wrong",
        state: "ended",
      })
    ).code,
    "lease_stale",
  );
  assert.equal(
    (
      await harness.request("song.playback.driver.v1", "acknowledge", {
        driverId: "local-youtube",
        leaseId: pulled.action.leaseId,
        state: "started",
        durationMs: 212000,
      })
    ).code,
    "started",
  );
  assert.equal(
    (await harness.request("song.playback.read.v1", "status", null)).primary.status,
    "playing",
  );
  assert.equal(
    (
      await harness.request("song.playback.driver.v1", "acknowledge", {
        driverId: "local-youtube",
        leaseId: pulled.action.leaseId,
        state: "ended",
        positionMs: 212000,
        durationMs: 212000,
      })
    ).outcome,
    "played",
  );
  assert.equal((await harness.request("song.queue.read.v1", "status", null)).counts.queued, 0);
  assert.ok(harness.events.some((event) => event.capability === "song.playback.events.v1"));
  await harness.stop();
});

test("live response toggles suppress chat intent without widget regeneration", async () => {
  const sent = [];
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers: {
      "twitch.chat.send.v1/send": async (payload) => {
        sent.push(payload);
        return { ok: true };
      },
    },
  });
  await harness.start();
  await harness.request("song.queue.admin.v1", "configure", {
    responses: { queued: false },
  });
  await harness.request("song.queue.submit.v1", "submit", {
    ...submission,
    notifyChat: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  await harness.stop();
});

test("Song Request chat is silent until an outcome is explicitly enabled", async () => {
  const sent = [];
  const harness = createFeatureRuntimeHarness(feature, {
    featureId: "song-request",
    providers: {
      "twitch.chat.send.v1/send": async (payload) => {
        sent.push(payload);
        return { ok: true };
      },
    },
  });
  await harness.start();
  await harness.request("song.queue.submit.v1", "submit", submission);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  await harness.request("song.queue.admin.v1", "configure", {
    responses: { queued: true },
  });
  await harness.request("song.queue.submit.v1", "submit", {
    ...submission,
    requestId: "request-2",
    requesterId: "viewer-2",
    requesterName: "ViewerTwo",
    notifyChat: true,
    query: "Second track",
    candidate: {
      ...submission.candidate,
      providerItemId: "aqz-KE-bpKQ",
      title: "Second track",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /@ViewerTwo Queued "Second track" at position 2/);
  await harness.stop();
});

test("each unhealthy optional adapter is isolated from queue decisions", async (t) => {
  const optional = [
    "twitch.chat.send.v1/send",
    "widget.state.v1/publish",
    "diagnostics.publish.v1/record",
  ];
  for (const target of optional) {
    await t.test(target, async () => {
      const providers = {
        "ravelink.storage.v1/get": async () => ({
          ok: true,
          found: false,
          value: null,
        }),
        "ravelink.storage.v1/set": async () => ({ ok: true }),
      };
      for (const key of optional)
        providers[key] = async () =>
          key === target ? Promise.reject(new Error("adapter_unhealthy")) : { ok: true };
      const harness = createFeatureRuntimeHarness(feature, {
        featureId: "song-request",
        providers,
      });
      await harness.start();
      const accepted = await harness.request("song.queue.submit.v1", "submit", {
        requestId: `request-${target}`,
        requesterId: `viewer-${target}`,
        query: `Track ${target}`,
        candidate: {
          provider: "youtube",
          providerItemId: "dQw4w9WgXcQ",
          title: `Track ${target}`,
          artists: [],
          durationMs: 0,
        },
      });
      assert.equal(accepted.ok, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await harness.request("song.queue.read.v1", "status", null)).ok, true);
      await harness.stop();
    });
  }
});

test("chat named removal enforces ownership and playback pause preserves request intake", async (t) => {
  const harness = createFeatureRuntimeHarness(feature, { featureId: "song-request" });
  await harness.start();
  t.after(() => harness.stop());
  const add = (id, user, title) =>
    harness.request("song.queue.submit.v1", "submit", {
      ...submission,
      requestId: id,
      requesterId: user,
      candidate: { ...submission.candidate, title, providerItemId: id },
    });
  await add("aaaaaaaaaaa", "alice", "Alice song");
  await add("bbbbbbbbbbb", "bob", "Bob song");
  const self = (query) =>
    harness.request("song.queue.submit.v1", "self", {
      action: "remove",
      query,
      requesterId: "alice",
      notifyChat: true,
    });
  assert.equal((await self("Bob song")).ok, false);
  assert.equal((await self("Alice song")).ok, true);
  const pause = await harness.request("song.queue.admin.v1", "moderate", {
    action: "pause",
    notifyChat: true,
  });
  assert.equal(pause.playbackControl, "pause");
  assert.equal((await harness.request("song.queue.read.v1", "status", null)).paused, false);
  assert.equal(
    (await harness.request("song.playback.read.v1", "status", null)).control.paused,
    true,
  );
  assert.equal((await add("ccccccccccc", "alice", "New request")).ok, true);
  assert.equal(
    (
      await harness.request("song.queue.admin.v1", "moderate", {
        action: "remove",
        query: "Bob song",
        notifyChat: true,
      })
    ).ok,
    true,
  );
  await harness.request("song.queue.admin.v1", "moderate", { action: "resume", notifyChat: true });
  assert.equal(
    (await harness.request("song.playback.read.v1", "status", null)).control.paused,
    false,
  );
});
