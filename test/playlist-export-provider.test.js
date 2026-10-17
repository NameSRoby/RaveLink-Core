const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const exportsProvider = require("../src/capabilities/feature-platform/providers/playlist-export-provider");
test("CSV exports are bounded, listed after completion, cannot escape their folder, and open that exact folder", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ravelink-csv-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let opened;
  const provider = exportsProvider({
    root,
    openFolder: (folder) => {
      opened = folder;
    },
  });
  const begin = await provider.action({
    action: "begin",
    name: "../../Favourite tracks",
  });
  assert.equal(begin.ok, true);
  assert.equal((await provider.action({ action: "begin" })).code, "export_busy");
  assert.equal(
    (
      await provider.action({
        action: "append",
        id: begin.id,
        offset: 4,
        chunk: "wrong",
      })
    ).code,
    "export_chunk_invalid",
  );
  const chunk = "\ufefftitle,artists\r\nSong,Artist";
  assert.equal(
    (
      await provider.action({
        action: "append",
        id: begin.id,
        offset: 0,
        chunk,
      })
    ).ok,
    true,
  );
  assert.deepEqual((await provider.action({ action: "list" })).files, []);
  const saved = await provider.action({ action: "finish", id: begin.id });
  assert.equal(saved.ok, true);
  assert.equal(path.dirname(path.resolve(root, saved.file.name)), root);
  assert.equal(await fs.readFile(path.join(root, saved.file.name), "utf8"), chunk);
  const restarted = exportsProvider({ root });
  assert.equal((await restarted.action({ action: "list" })).files[0].name, saved.file.name);
  await provider.action({ action: "open" });
  assert.equal(opened, root);
  const second = await provider.action({ action: "begin" });
  assert.equal(
    (
      await provider.action({
        action: "append",
        id: second.id,
        offset: 0,
        chunk: "x".repeat(24001),
      })
    ).code,
    "export_chunk_invalid",
  );
  await provider.action({ action: "cancel", id: second.id });
  assert.equal((await fs.readdir(root)).length, 1);
});
