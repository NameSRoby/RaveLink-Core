const test = require("node:test");
const assert = require("node:assert/strict");
const { createSongQueue, DEFAULTS, SNAPSHOT_VERSION } = require("../features/song-request/dist/domain");

function request(id, requester = "viewer-1", candidate = {}) {
  return { requestId: id, requesterId: requester, query: `Track ${id}`, candidate };
}

test("manual queue enforces replay, duplicate, requester, duration, and queue limits", () => {
  let at = 1700000000000;
  const queue = createSongQueue({ now: () => at++ });
  assert.equal(queue.submit(request("a")).code, "accepted");
  assert.equal(queue.submit(request("a")).reason, "request_replay");
  assert.equal(queue.submit(request("b", "viewer-2", { title: "Track a" })).reason, "item_duplicate");
  assert.equal(queue.submit(request("c", "viewer-1")).ok, true);
  assert.equal(queue.submit(request("d", "viewer-1")).ok, true);
  assert.equal(queue.submit(request("e", "viewer-1")).ok, true);
  assert.equal(queue.submit(request("h", "viewer-1")).ok, true);
  assert.equal(queue.submit(request("i", "viewer-1")).reason, "requester_limit");
  assert.equal(queue.submit(request("f", "viewer-3", { durationMs: DEFAULTS.maxDurationMs + 1 })).reason, "duration_limit");
  queue.configure({ limits: { maxQueue: 3 } });
  assert.equal(queue.submit(request("g", "viewer-3")).reason, "queue_full");
});

test("role limits, local moderation, song bans, volume cap, and self actions are deterministic", () => {
  let at = 1000;
  const queue = createSongQueue({ now: () => at });
  const submit = (id, user, role = "viewer", name = user) => queue.submit({
    ...request(id, user, { provider: "youtube", providerItemId: `${id}__________`.slice(0, 11), title: id }),
    requesterRole: role,
    requesterName: name
  });
  for (let index = 0; index < 5; index += 1) assert.equal(submit(`view${index}`, "viewer-1").ok, true);
  assert.equal(submit("view5", "viewer-1").reason, "requester_limit");
  for (let index = 0; index < 10; index += 1) assert.equal(submit(`vip${index}`, "vip-1", "vip", "CoolVIP").ok, true);
  assert.equal(submit("vip10", "vip-1", "vip", "CoolVIP").reason, "requester_limit");
  for (let index = 0; index < 12; index += 1) assert.equal(submit(`mod${index}`, "mod-1", "moderator", "ChannelMod").ok, true);
  assert.equal(queue.status().moderation.recentRequesters.length, 3);
  assert.equal(queue.moderate({ action: "timeout", requesterName: "CoolVIP", minutes: 5, removePending: true }).ok, true);
  assert.equal(submit("vip-after", "vip-1", "vip", "CoolVIP").reason, "requester_timed_out");
  at += 300001;
  assert.equal(submit("vip-after-2", "vip-1", "vip", "CoolVIP").ok, true);
  const song = submit("blockme", "song-user");
  assert.equal(queue.moderate({ action: "block_song", entryId: song.entry.id }).songBlocked, true);
  assert.equal(queue.submit({ ...request("blockme2", "other", song.entry.candidate), requesterName: "Other" }).reason, "song_blocked");
  assert.equal(queue.moderate({ action: "volume", value: 75 }).volume.outputPercent, 30);
  queue.configure({ volumeFloorPercent: 20, volumeCeilingPercent: 60 });
  assert.equal(queue.moderate({ action: "volume", value: 75 }).volume.outputPercent, 50);
  assert.equal(queue.configure({ volumeFloorPercent: 70, volumeCeilingPercent: 60 }).code, "volume_range_invalid");
  const own = submit("owntrack", "owner");
  assert.equal(queue.selfManage({ action: "remove", requesterId: "different" }).reason, "entry_not_found");
  assert.equal(queue.selfManage({ action: "remove", requesterId: "owner" }).entryId, own.entry.id);
});

test("moderation, requester undo, settlement, and live response toggles are deterministic", () => {
  const queue = createSongQueue({ now: () => 42 });
  const first = queue.submit(request("a"));
  queue.configure({ responses: { accepted: false, skipped: false } });
  assert.equal(Object.hasOwn(queue.submit(request("b", "viewer-2")), "responseIntent"), false);
  assert.equal(queue.undo({ requesterId: "viewer-2" }).code, "removed");
  assert.equal(queue.moderate({ action: "pause" }).paused, true);
  assert.equal(queue.submit(request("c", "viewer-3")).reason, "intake_paused");
  queue.moderate({ action: "resume" });
  queue.moderate({ action: "block", requesterId: "viewer-3" });
  assert.equal(queue.submit(request("blocked", "viewer-3")).reason, "requester_blocked");
  queue.moderate({ action: "unblock", requesterId: "viewer-3" });
  assert.equal(queue.settle({ entryId: first.entry.id, outcome: "played" }).outcome, "played");
  assert.equal(queue.status().counts.queued, 0);
  assert.equal(queue.submit(request("d", "viewer-4", { title: "Track a" })).reason, "item_duplicate");
});

test("skipped and removed songs can be requested again while played songs remain guarded", () => {
  const queue = createSongQueue({ now: () => 42 });
  const skipped = queue.submit(request("skip-a"));
  queue.moderate({ action: "skip", entryId: skipped.entry.id });
  assert.equal(queue.submit(request("skip-b", "viewer-2", skipped.entry.candidate)).ok, true);

  const removed = queue.submit(request("remove-a", "viewer-3"));
  queue.moderate({ action: "remove", entryId: removed.entry.id });
  assert.equal(queue.submit(request("remove-b", "viewer-4", removed.entry.candidate)).ok, true);
});

test("server playlist yields to the FIFO request queue and resumes afterward", () => {
  const queue = createSongQueue({ now: () => 42, random: () => 0.75 });
  const first = queue.submit(request("first", "viewer-1", {
    provider: "youtube", providerItemId: "dQw4w9WgXcQ", title: "First"
  }));
  assert.equal(queue.status().playlistState.total, 1);
  queue.moderate({ action: "playback_start" });
  const queued = queue.pull({ driverId: "youtube-ui", providers: ["youtube"] });
  assert.equal(queued.action.entryId, first.entry.id);
  assert.equal(queued.action.origin, "queue");
  queue.acknowledge({ driverId: "youtube-ui", leaseId: queued.action.leaseId, state: "ended" });

  queue.moderate({ action: "playlist_play" });
  const background = queue.pull({ driverId: "youtube-ui", providers: ["youtube"] });
  assert.equal(background.action.origin, "playlist");
  const urgent = queue.submit(request("urgent", "viewer-2", {
    provider: "youtube", providerItemId: "M7lc1UVf-VE", title: "Urgent"
  }));
  assert.equal(urgent.preemptedPlaylist, true);
  assert.equal(queue.playbackStatus().managed, null);
  const priority = queue.pull({ driverId: "youtube-ui", providers: ["youtube"] });
  assert.equal(priority.action.entryId, urgent.entry.id);
  assert.equal(priority.action.origin, "queue");
  queue.acknowledge({ driverId: "youtube-ui", leaseId: priority.action.leaseId, state: "ended" });
  assert.equal(queue.pull({ driverId: "youtube-ui", providers: ["youtube"] }).action.origin, "playlist");
});

test("managed playback waits for an explicit operator start", () => {
  const queue = createSongQueue({ requestProviders: ["youtube"] });
  queue.submit({ requestId: "manual-start", requesterId: "viewer", query: "song", candidate: { provider: "youtube", providerItemId: "abcdefghijk", title: "Song" } });
  assert.equal(queue.pull({ driverId: "player", providers: ["youtube"] }).action, null);
  assert.equal(queue.moderate({ action: "playback_start" }).ok, true);
  assert.equal(queue.pull({ driverId: "player", providers: ["youtube"] }).action.candidate.title, "Song");
});

test("versioned snapshots restore bounded state and reject corruption", () => {
  const original = createSongQueue({ now: () => 100 });
  original.submit(request("a"));
  const snapshot = original.exportSnapshot();
  const restored = createSongQueue({ now: () => 200 });
  assert.deepEqual(restored.importSnapshot(snapshot), { ok: true, restored: 1 });
  assert.equal(restored.status().queue[0].requestId, "a");
  assert.equal(snapshot.version, SNAPSHOT_VERSION);
  assert.deepEqual(restored.importSnapshot({ version: 99 }), { ok: false, error: "snapshot_invalid" });
  assert.equal(restored.status().counts.queued, 1);
});

test("playback source switches between YouTube and observed Windows media sessions", () => {
  const queue = createSongQueue({ now: () => 100 });
  assert.equal(queue.playbackStatus().primary, null);
  assert.equal(queue.configurePlaybackSource({ source: "spotify" }).playbackSource, "spotify");
  assert.equal(queue.observe({ provider: "spotify", sourceId: "Spotify.exe", available: true, title: "美波 - カワキヲアメク", artists: ["美波"], status: "playing" }).ok, true);
  assert.equal(queue.playbackStatus().primary.title, "美波 - カワキヲアメク");
  assert.equal(queue.configurePlaybackSource({ source: "apple-music" }).playbackSource, "apple-music");
  assert.equal(queue.playbackStatus().primary, null);
  assert.equal(queue.configurePlaybackSource({ source: "unsupported" }).ok, false);
  const restored = createSongQueue();
  assert.equal(restored.importSnapshot(queue.exportSnapshot()).ok, true);
  assert.equal(restored.playbackStatus().playbackSource, "apple-music");
});

test("legacy snapshots migrate implicit Song Request responses to off", () => {
  const legacy = createSongQueue().exportSnapshot();
  legacy.version = 3;
  legacy.responses = Object.fromEntries(Object.keys(legacy.responses).map(kind => [kind, true]));
  const restored = createSongQueue();
  assert.equal(restored.importSnapshot(legacy).ok, true);
  assert.equal(Object.values(restored.status().responses).some(Boolean), false);
});

test("version 6 snapshots remain readable after the chat response upgrade", () => {
  const legacy = createSongQueue().exportSnapshot();
  legacy.version = 6;
  const restored = createSongQueue();
  assert.deepEqual(restored.importSnapshot(legacy), { ok: true, restored: 0 });
});

test("version 7 snapshots preserve chat toggles and adopt strict catalog defaults", () => {
  const legacy = createSongQueue().exportSnapshot();
  legacy.version = 7;
  legacy.responses.queued = true;
  delete legacy.catalogPolicy;
  const restored = createSongQueue();
  assert.equal(restored.importSnapshot(legacy).ok, true);
  assert.equal(restored.status().responses.queued, true);
  assert.equal(restored.status().catalogPolicy.minimumSubscribers, 100000);
  assert.equal(restored.status().catalogPolicy.minimumViews, 50000);
  assert.equal(restored.status().catalogPolicy.allowNonMusic, false);
});

test("overlay configuration is bounded, versioned, and preserves the classic default", () => {
  const queue = createSongQueue({ now: () => 100 });
  const initial = queue.overlayStatus();
  assert.equal(initial.config.preset, "classic");
  assert.equal(initial.config.version, 3);
  assert.equal(initial.config.anchor, "top-left");
  assert.equal(initial.config.width, 320);
  assert.equal(initial.config.autoHeight, true);
  assert.equal(initial.config.height, 130);
  assert.equal(initial.config.opacity, 78);
  assert.deepEqual(initial.config.segments[0].blocks.map(row => row.kind), ["label", "title", "artists", "meta", "progress", "queue"]);
  const changed = queue.configureOverlay({ config: {
    ...initial.config, preset: "custom", separated: true, radius: 999, gap: -2, height: 9999, scale: 200,
    accent: "url(javascript:bad)", segments: [
      { id: "cover", name: "Cover", kind: "artwork", enabled: true, align: "center", size: "compact", style: { surface: "#112233", opacity: 65 } },
      { id: "cover", kind: "artwork" }, { id: "evil", kind: "html" }
    ]
  } });
  assert.equal(changed.revision, 1);
  assert.equal(changed.config.radius, initial.config.radius);
  assert.equal(changed.config.gap, initial.config.gap);
  assert.equal(changed.config.height, initial.config.height);
  assert.equal(changed.config.scale, initial.config.scale);
  assert.equal(changed.config.accent, initial.config.accent);
  assert.deepEqual(changed.config.segments.map(row => row.id), ["cover"]);
  assert.deepEqual(changed.config.segments[0].blocks.map(row => row.kind), ["artwork"]);
  assert.equal(changed.config.segments[0].style.surface, "#112233");
  assert.equal(changed.config.segments[0].style.opacity, 65);
  const restored = createSongQueue();
  assert.equal(restored.importSnapshot(queue.exportSnapshot()).ok, true);
  assert.equal(restored.overlayStatus().config.separated, true);
  const legacySnapshot = createSongQueue().exportSnapshot();
  legacySnapshot.overlay = { ...legacySnapshot.overlay, version: 2, anchor: "bottom-left", width: 660, gap: 9, blockGap: 4, padding: 16, opacity: 90 };
  const migrated = createSongQueue();
  assert.equal(migrated.importSnapshot(legacySnapshot).ok, true);
  assert.deepEqual(
    (({ anchor, width, gap, blockGap, padding, opacity }) => ({ anchor, width, gap, blockGap, padding, opacity }))(migrated.overlayStatus().config),
    { anchor: "top-left", width: 320, gap: 6, blockGap: 3, padding: 10, opacity: 78 }
  );
  const priorCompactSnapshot = createSongQueue().exportSnapshot();
  priorCompactSnapshot.overlay = { ...priorCompactSnapshot.overlay, version: 2, width: 560, radius: 0, opacity: 0 };
  const compactMigrated = createSongQueue();
  assert.equal(compactMigrated.importSnapshot(priorCompactSnapshot).ok, true);
  assert.equal(compactMigrated.overlayStatus().config.width, 320);
});

test("only canonical YouTube IDs produce allowlisted artwork", () => {
  const queue = createSongQueue({ now: () => 100 });
  const youtube = queue.submit(request("youtube-art", "viewer-art", {
    provider: "youtube", providerItemId: "dQw4w9WgXcQ", title: "Video"
  }));
  assert.equal(youtube.entry.candidate.artworkUrl, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  const manual = queue.submit(request("manual-art", "viewer-manual", {
    provider: "manual", providerItemId: "item", title: "Manual", artworkUrl: "https://tracker.example/pixel"
  }));
  assert.equal(manual.entry.candidate.artworkUrl, "");
});

test("worst-case paged status remains below the declared IPC frame", () => {
  const queue = createSongQueue({ now: () => 100 });
  for (let index = 0; index < 200; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const result = queue.submit({
      requestId: `request-${suffix}`,
      requesterId: `viewer-${suffix}`,
      query: `${"q".repeat(496)}${suffix}`,
      candidate: {
        providerItemId: `item-${suffix}`,
        title: `${"t".repeat(196)}${suffix}`,
        artists: Array.from({ length: 8 }, (_, artist) => `${artist}${"a".repeat(98)}`),
        durationMs: 600000
      }
    });
    assert.equal(result.ok, true);
  }
  const page = queue.status({ offset: 0, limit: 25 });
  assert.equal(page.queue.length, 25);
  assert.equal(page.page.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 65536);
  assert.ok(Buffer.byteLength(JSON.stringify(queue.exportSnapshot())) < 2 * 1024 * 1024);
});

test("driver pull is provider-filtered and ack is lease-bound", () => {
  let at = 1000;
  const queue = createSongQueue({ now: () => at });
  queue.submit(request("manual"));
  const youtube = queue.submit(request("youtube", "viewer-2", {
    provider: "youtube", providerItemId: "video-1", title: "Video"
  }));
  queue.moderate({ action: "playback_start" });
  const pulled = queue.pull({ driverId: "youtube-ui", providers: ["youtube"] });
  assert.equal(pulled.action.entryId, youtube.entry.id);
  assert.equal(queue.pull({ driverId: "other-ui", providers: ["youtube"] }).code, "idle");
  assert.equal(queue.acknowledge({ driverId: "youtube-ui", leaseId: "stale", state: "ended" }).code, "lease_stale");
  assert.equal(queue.acknowledge({ driverId: "youtube-ui", leaseId: pulled.action.leaseId, state: "started" }).code, "started");
  assert.equal(queue.playbackStatus().primary.candidate.provider, "youtube");
  assert.equal(queue.acknowledge({ driverId: "youtube-ui", leaseId: pulled.action.leaseId, state: "ended" }).outcome, "played");
  assert.equal(queue.status().queue[0].candidate.provider, "manual");
});
