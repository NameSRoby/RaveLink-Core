const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createSongQueue } = require("../features/song-request/dist/domain");
const presets = require("../features/song-request/dist/overlay-presets");
test("overlay profiles support save, rename, conflict checks, restart and deletion without clearing the design", () => {
  const q = createSongQueue({ now: () => 123456 });
  assert.equal(q.overlayStatus().config.followAppColors, true);
  let saved = q.overlayProfile({
    action: "save",
    name: "My ribbon",
    config: presets.get("ribbon"),
    expectedRevision: 0,
  });
  assert.equal(saved.ok, true);
  const id = saved.profile.id;
  assert.equal(
    q.overlayProfile({
      action: "save",
      name: "MY RIBBON",
      config: saved.config,
    }).code,
    "overlay_profile_name_exists",
  );
  assert.equal(
    q.configureOverlay({ config: presets.get("classic"), expectedRevision: 0 }).code,
    "overlay_revision_conflict",
  );
  const before = q.exportSnapshot();
  assert.equal(q.overlayProfile({ action: "load", id }).profile.name, "My ribbon");
  assert.deepEqual(q.exportSnapshot(), before, "loading never applies or persists a design");
  saved = q.overlayProfile({
    action: "save",
    id,
    name: "Renamed",
    config: { ...saved.config, followAppColors: false, accent: "#abcdef" },
    expectedRevision: 1,
  });
  assert.equal(saved.profiles.length, 1);
  assert.equal(saved.profile.id, id);
  const restored = createSongQueue();
  assert.equal(restored.importSnapshot(q.exportSnapshot()).ok, true);
  assert.equal(restored.overlayStatus().activeProfileId, id);
  assert.equal(restored.overlayProfile({ action: "load", id }).profile.config.accent, "#abcdef");
  const design = restored.overlayStatus().config;
  assert.equal(
    restored.overlayProfile({
      action: "delete",
      id,
      expectedRevision: saved.revision,
    }).ok,
    true,
  );
  assert.deepEqual(restored.overlayStatus().config, design);
  assert.equal(restored.overlayStatus().profiles.length, 0);
  assert.equal(restored.overlayProfile({ action: "load", id }).code, "overlay_profile_not_found");
});
test("preset catalog and saved profile metadata remain bounded", () => {
  execFileSync(process.execPath, ["scripts/build-song-overlay-ui.js", "--check"]);
  assert.equal(presets.list().length, 10);
  for (const id of ["ribbon", "broadcast", "split-panels", "spotlight", "two-column"])
    assert.ok(presets.get(id).width <= 460, id + " stays compact");
  assert.equal(presets.get("split-panels").separated, true);
  assert.equal(presets.get("broadcast").providerColors, true);
  const q = createSongQueue();
  for (let i = 0; i < 16; i++)
    assert.equal(
      q.overlayProfile({
        action: "save",
        name: "Profile " + i,
        config: presets.get("classic"),
      }).ok,
      true,
    );
  assert.equal(
    q.overlayProfile({
      action: "save",
      name: "Overflow",
      config: presets.get("classic"),
    }).code,
    "overlay_profile_limit",
  );
  assert.ok(Buffer.byteLength(JSON.stringify(q.overlayStatus())) < 12000);
  assert.ok(q.overlayStatus().profiles.every((p) => !p.config));
});
test("sixteen detailed profiles persist in separate bounded frames and clean replaced generations", async () => {
  const {
    createOverlayProfileStorage,
  } = require("../features/song-request/dist/overlay-profile-storage");
  const rows = new Map();
  const context = {
    callCapability: async (_cap, method, payload) => {
      assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 32000);
      if (method === "set") {
        rows.set(payload.key, structuredClone(payload.value));
        return { ok: true };
      }
      if (method === "get")
        return {
          ok: true,
          found: rows.has(payload.key),
          value: rows.get(payload.key),
        };
      rows.delete(payload.key);
      return { ok: true };
    },
  };
  const q = createSongQueue({ now: () => 123456 });
  const config = {
    ...presets.get("classic"),
    segments: Array.from({ length: 8 }, (_, i) => ({
      id: "segment-" + i,
      name: "Segment " + i,
      enabled: true,
      direction: "column",
      align: "left",
      size: "wide",
      blocks: Array.from({ length: 4 }, (_, j) => ({
        id: "piece-" + i + "-" + j,
        kind: "title",
        style: { font: "cjk", color: "#abcdef", size: "display", bold: true },
      })),
    })),
  };
  for (let i = 0; i < 16; i++)
    assert.equal(q.overlayProfile({ action: "save", name: "Profile " + i, config }).ok, true);
  const storage = createOverlayProfileStorage(context),
    snapshot = q.exportSnapshot();
  const staged = await storage.prepare(snapshot);
  assert.equal(staged.overlayProfiles, undefined);
  await storage.committed(staged);
  assert.equal(rows.size, 16);
  assert.deepEqual(
    (await createOverlayProfileStorage(context).restore(staged)).overlayProfiles,
    snapshot.overlayProfiles,
  );
  q.overlayProfile({ action: "delete", id: q.overlayStatus().profiles[0].id });
  const updated = await storage.prepare(q.exportSnapshot());
  await storage.committed(updated);
  assert.equal(rows.size, 15);
});
