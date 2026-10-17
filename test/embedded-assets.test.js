const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { replaceBlock, syncFile } = require("../scripts/lib/embedded-assets");

test("embedded assets require unique ordered boundaries and preserve surrounding text", () => {
  assert.equal(
    replaceBlock("before<start>old<end>after", "<start>", "<end>", "new"),
    "before<start>new<end>after",
  );
  for (const value of ["missing", "<end><start>", "<start>x<end><start>", "<start>x<end><end>"]) {
    assert.throws(() => replaceBlock(value, "<start>", "<end>", "new"), /one ordered/);
  }
});

test("embedded check mode detects drift without touching the file and rebuilds idempotently", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-embedded-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "page.html");
  const transform = (text) => replaceBlock(text, "<start>", "<end>", "\nnew\n");
  fs.writeFileSync(file, "before\r\n<start>old<end>after");
  const before = fs.readFileSync(file);
  assert.throws(() => syncFile(file, transform, { check: true }), /stale/);
  assert.deepEqual(fs.readFileSync(file), before);
  syncFile(file, transform);
  const built = fs.readFileSync(file);
  syncFile(file, transform);
  syncFile(file, transform, { check: true });
  assert.deepEqual(fs.readFileSync(file), built);
});
