// [TITLE] Test Module: test/mod-platform.storage-service.test.js
// [TITLE] Purpose: verify isolated atomic quota-bound mod state

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createStorage = require("../src/capabilities/mod-platform/host/mod-storage-service");

function manifest(storage = true, storageBytes = 128) {
  return {
    id: "example.storage",
    permissions: { storage },
    resources: { storageBytes },
  };
}

test("storage atomically isolates JSON values and reports metadata only", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-mod-storage-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const storage = createStorage({ dataRoot: root });
  assert.equal((await storage.get(manifest(), "prefs")).found, false);
  assert.equal((await storage.set(manifest(), "prefs", { mode: "dark" })).ok, true);
  assert.equal((await storage.set(manifest(), "prefs", { mode: "light" })).ok, true);
  assert.deepEqual((await storage.get(manifest(), "prefs")).value, {
    mode: "light",
  });
  const status = await storage.status(manifest());
  assert.deepEqual(status.keys, ["prefs"]);
  assert.equal(JSON.stringify(status).includes("light"), false);
  assert.equal((await storage.remove(manifest(), "prefs")).removed, true);
});

test("storage rejects missing grants, unsafe keys, quota overflow, and links", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-mod-storage-deny-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const storage = createStorage({ dataRoot: root });
  assert.equal(
    (await storage.set(manifest(false), "prefs", {})).error,
    "storage_permission_denied",
  );
  assert.equal((await storage.set(manifest(), "../escape", {})).error, "invalid_storage_key");
  assert.equal(
    (await storage.set(manifest(true, 4), "prefs", "too-large")).error,
    "storage_quota_exceeded",
  );
  const modRoot = path.join(root, "example.storage");
  await fs.promises.mkdir(modRoot, { recursive: true });
  try {
    await fs.promises.symlink(path.join(root, "outside"), path.join(modRoot, "prefs.json"), "file");
  } catch {
    return;
  }
  assert.equal((await storage.get(manifest(), "prefs")).error, "storage_entry_invalid");
});
