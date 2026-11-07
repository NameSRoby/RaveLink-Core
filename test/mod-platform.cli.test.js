// [TITLE] Test Module: test/mod-platform.cli.test.js
// [TITLE] Purpose: verify developer validation and round-trip-safe ZIP packaging

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { packageMod, validate } = require("../scripts/ravelink-mod");
const {
  extractZipArchive,
} = require("../src/capabilities/mod-platform/packages/mod-package-archive");
const {
  verifyPackageDirectory,
} = require("../src/capabilities/mod-platform/packages/mod-package-integrity");

test("template validates and packager emits a production-admissible ZIP", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-mod-cli-"));
  t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));
  const template = path.join(__dirname, "..", "packages", "mod-sdk", "starter");
  assert.equal((await validate(template)).manifest.id, "example.button");
  const archive = path.join(temp, "template.zip");
  const packaged = await packageMod(template, archive);
  assert.equal(packaged.ok, true);
  const extracted = path.join(temp, "extracted");
  assert.equal((await extractZipArchive(archive, extracted)).ok, true);
  assert.equal((await verifyPackageDirectory(extracted)).manifest.id, "example.button");
  assert.equal((await packageMod(template, archive)).error, "package_output_exists");
});

test("packager rejects outputs inside source and tampered packages", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-mod-cli-bad-"));
  t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));
  const template = path.join(__dirname, "..", "packages", "mod-sdk", "starter");
  assert.equal(
    (await packageMod(template, path.join(template, "bad.zip"))).error,
    "package_output_inside_source",
  );
  await fs.promises.cp(template, path.join(temp, "source"), {
    recursive: true,
  });
  await fs.promises.appendFile(path.join(temp, "source", "main.js"), "// tampered\n");
  assert.equal((await validate(path.join(temp, "source"))).error, "integrity_hash_mismatch");
});
