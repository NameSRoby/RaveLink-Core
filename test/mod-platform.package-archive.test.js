// [TITLE] Test Module: test/mod-platform.package-archive.test.js
// [TITLE] Purpose: verify bounded adversarial ZIP admission and atomic package installation

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createModPackageManager = require("../src/capabilities/mod-platform/packages/mod-package-manager");
const {
  extractZipArchive,
} = require("../src/capabilities/mod-platform/packages/mod-package-archive");
const { createPackage } = require("./helpers/mod-package-fixture");
const { createZip } = require("./helpers/zip-fixture");

async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-package-archive-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return { root, archive: path.join(root, "package.zip") };
}

async function writeZipFromDirectory(source, archive) {
  const entries = [];
  async function walk(directory) {
    for (const item of await fs.promises.readdir(directory, {
      withFileTypes: true,
    })) {
      const absolute = path.join(directory, item.name);
      const relative = path.relative(source, absolute).split(path.sep).join("/");
      if (item.isDirectory()) await walk(absolute);
      else
        entries.push({
          name: relative,
          data: await fs.promises.readFile(absolute),
        });
    }
  }
  await walk(source);
  await fs.promises.writeFile(archive, createZip(entries));
}

test("ZIP package installs through verified staging and remains disabled", async (t) => {
  const paths = await fixture(t);
  const source = path.join(paths.root, "source");
  await createPackage(source);
  await writeZipFromDirectory(source, paths.archive);
  const manager = createModPackageManager({
    modsRoot: path.join(paths.root, "mods"),
    runtimeRoot: path.join(paths.root, "runtime", "mods"),
  });
  const installed = await manager.installArchive(paths.archive);
  assert.equal(installed.ok, true);
  assert.equal(installed.operation, "installed");
  assert.equal(installed.enabled, false);
  assert.equal(installed.approval.needsApproval, true);
  assert.equal(
    fs.existsSync(path.join(paths.root, "mods", "example.package-mod", "dist", "main.js")),
    true,
  );
});

test("ZIP admission rejects traversal, links, and portable-name hazards", async (t) => {
  const paths = await fixture(t);
  const cases = [
    [{ name: "../escape.js", data: "bad" }],
    [{ name: "linked.js", data: "target", mode: 0o120777 }],
    [{ name: "CON.txt", data: "bad" }],
    [{ name: "stream:name", data: "bad" }],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    await fs.promises.writeFile(paths.archive, createZip(cases[index]));
    const result = await extractZipArchive(paths.archive, path.join(paths.root, `out-${index}`));
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(path.join(paths.root, `out-${index}`)), false);
  }
});

test("ZIP admission rejects duplicate, case-colliding, and conflicting paths", async (t) => {
  const paths = await fixture(t);
  const cases = [
    [
      { name: "a.js", data: "1" },
      { name: "a.js", data: "2" },
    ],
    [
      { name: "A.js", data: "1" },
      { name: "a.js", data: "2" },
    ],
    [
      { name: "folder", data: "1" },
      { name: "folder/a.js", data: "2" },
    ],
  ];
  const errors = ["archive_duplicate_path", "archive_case_collision", "archive_path_conflict"];
  for (let index = 0; index < cases.length; index += 1) {
    await fs.promises.writeFile(paths.archive, createZip(cases[index]));
    const result = await extractZipArchive(
      paths.archive,
      path.join(paths.root, `collision-${index}`),
    );
    assert.equal(result.error, errors[index]);
  }
});

test("ZIP admission enforces entry, file, expanded-byte, depth, and ratio budgets", async (t) => {
  const paths = await fixture(t);
  const checks = [
    {
      entries: [
        { name: "a", data: "a" },
        { name: "b", data: "b" },
      ],
      limits: { maxEntries: 1 },
      error: "archive_entry_count_limit",
    },
    {
      entries: [{ name: "a", data: "12345", store: true }],
      limits: { maxFileBytes: 4 },
      error: "archive_file_too_large",
    },
    {
      entries: [
        { name: "a", data: "123" },
        { name: "b", data: "456" },
      ],
      limits: { maxExpandedBytes: 5 },
      error: "archive_expanded_size_limit",
    },
    {
      entries: [{ name: "a/b/c", data: "1" }],
      limits: { maxDepth: 2 },
      error: "archive_depth_limit",
    },
    {
      entries: [{ name: "a", data: "a".repeat(4096) }],
      limits: { maxCompressionRatio: 5 },
      error: "archive_compression_ratio_limit",
    },
  ];
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    await fs.promises.writeFile(paths.archive, createZip(check.entries));
    const result = await extractZipArchive(
      paths.archive,
      path.join(paths.root, `budget-${index}`),
      { limits: check.limits },
    );
    assert.equal(result.error, check.error);
  }
});

test("ZIP extraction is not installation and invalid package integrity leaves no mod", async (t) => {
  const paths = await fixture(t);
  await fs.promises.writeFile(
    paths.archive,
    createZip([
      { name: "ravelink.mod.json", data: "{}" },
      { name: "dist/main.js", data: "tampered" },
    ]),
  );
  const modsRoot = path.join(paths.root, "mods");
  const manager = createModPackageManager({
    modsRoot,
    runtimeRoot: path.join(paths.root, "runtime", "mods"),
  });
  const result = await manager.installArchive(paths.archive);
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(modsRoot), false);
});
