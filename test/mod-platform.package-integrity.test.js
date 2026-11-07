// [TITLE] Test Module: test/mod-platform.package-integrity.test.js
// [TITLE] Purpose: verify complete bounded SHA-256 package admission

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  scanPackageDirectory,
  verifyPackageDirectory,
} = require("../src/capabilities/mod-platform/packages/mod-package-integrity");
const { createPackage } = require("./helpers/mod-package-fixture");

test("package verifier accepts an exact complete SHA-256 inventory", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-package-valid-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await createPackage(root);
  const result = await verifyPackageDirectory(root);
  assert.equal(result.ok, true);
  assert.equal(result.manifest.id, "example.package-mod");
  assert.deepEqual(
    result.files.map((row) => row.path),
    ["dist/main.js", "ravelink.mod.json"],
  );
});

test("package verifier rejects modified and undeclared payload files", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-package-tamper-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await createPackage(root);
  await fs.promises.writeFile(path.join(root, "dist", "main.js"), "tampered\n", "utf8");
  let result = await verifyPackageDirectory(root);
  assert.equal(result.error, "integrity_hash_mismatch");

  await createPackage(root);
  await fs.promises.writeFile(path.join(root, "extra.txt"), "undeclared\n", "utf8");
  result = await verifyPackageDirectory(root);
  assert.equal(result.error, "integrity_inventory_mismatch");
  assert.deepEqual(result.undeclared, ["extra.txt"]);
});

test("package scanner enforces file count and per-file limits", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-package-limits-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await createPackage(root);
  let result = await scanPackageDirectory(root, { maxFiles: 1 });
  assert.equal(result.error, "package_file_count_limit");
  result = await scanPackageDirectory(root, { maxFileBytes: 10 });
  assert.equal(result.error, "package_file_too_large");
});

test("package scanner rejects symbolic links when supported by the host", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-package-link-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await createPackage(root);
  const target = path.join(root, "dist", "main.js");
  const link = path.join(root, "linked.js");
  try {
    await fs.promises.symlink(target, link, "file");
  } catch {
    try {
      await fs.promises.symlink(path.join(root, "dist"), path.join(root, "linked-dir"), "junction");
    } catch {
      t.skip("symbolic link and junction creation are unavailable on this account");
      return;
    }
  }
  const result = await scanPackageDirectory(root);
  assert.equal(result.error, "package_link_not_allowed");
});
