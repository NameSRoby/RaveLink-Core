const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createStorage = require("../src/shared/storage/quota-json-storage");

test("first-party storage can exceed the mod key ceiling while retaining byte and path limits", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-storage-pages-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = {
    id: "song-request",
    permissions: { storage: true },
    resources: { storageBytes: 8192 },
  };
  const featureRoot = path.join(root, manifest.id);
  fs.mkdirSync(featureRoot);
  for (let index = 0; index < 250; index++)
    fs.writeFileSync(path.join(featureRoot, `page-${index}.json`), "[]");
  const ordinary = createStorage({ dataRoot: root });
  assert.equal((await ordinary.set(manifest, "next", [])).error, "storage_key_limit");
  const firstParty = createStorage({ dataRoot: root, maximumKeys: 8192 });
  assert.equal((await firstParty.set(manifest, "next", [])).ok, true);
  const firstPage = await firstParty.status(manifest);
  const nextPage = await firstParty.status(manifest, { offset: 250 });
  assert.equal(firstPage.keys.length, 250);
  assert.equal(firstPage.page.total, 251);
  assert.equal(firstPage.page.hasMore, true);
  assert.equal(nextPage.page.hasMore, false);
  assert.equal(new Set([...firstPage.keys, ...nextPage.keys]).size, 251);
  assert.ok(Buffer.byteLength(JSON.stringify(firstPage)) < 65536);
  assert.equal(
    (await firstParty.set(manifest, "huge", "x".repeat(8192))).error,
    "storage_quota_exceeded",
  );
  assert.equal((await firstParty.set(manifest, "../escape", [])).error, "invalid_storage_key");
});

test("the host key ceiling is bounded and cannot be raised through a workload manifest", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-storage-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = {
    id: "example.test",
    maximumKeys: 9999,
    permissions: { storage: true },
    resources: { storageBytes: 1024 },
  };
  const storage = createStorage({ dataRoot: root, maximumKeys: 1 });
  assert.equal((await storage.set(manifest, "first", [])).ok, true);
  assert.equal((await storage.set(manifest, "second", [])).error, "storage_key_limit");
  assert.equal((await storage.set(manifest, "first", [1])).ok, true);
});
