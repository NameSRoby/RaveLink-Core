/** Packaging regression: exercise a staged source tree containing only runtime
 * dependencies, without accidentally resolving a sibling development checkout.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { runtimeFiles, verifyRuntime } = require("../scripts/music-to-light-runtime-files");
const ROOT = path.resolve(__dirname, "..");
test("music runtime inventory follows deferred imports and excludes development-only files", () => {
  const files = runtimeFiles();
  for (const file of [
    "native-catalog.cjs",
    "profile-renderer.cjs",
    "beat-palette.cjs",
    "profiles/accepted-color-led-v1.json",
    "profiles/reference-pulse-v1.json",
  ])
    assert(files.includes(file), file);
  assert(!files.includes("simulation.cjs"));
  assert(files.every((file) => !/(?:^|\/)(?:test|native|target)(?:\/|$)/.test(file)));
});
test("staged music runtime starts without source-only helpers and rejects an omitted dependency", async (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-music-runtime-"));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.cpSync(path.join(ROOT, "src"), path.join(target, "src"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(target, "package.json"));
  const music = path.join(target, "integrations/music-to-light");
  for (const file of runtimeFiles()) {
    const destination = path.join(music, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "integrations/music-to-light", file), destination);
  }
  // NODE_PATH supplies only external npm dependencies. Relative music imports
  // must resolve inside the staged payload even though the full checkout exists.
  const script = path.join(ROOT, "scripts/music-to-light-runtime-files.js");
  const result = spawnSync(process.execPath, [script, "--check", target], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NODE_PATH: path.join(ROOT, "node_modules") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /runtime dependencies and native profiles verified/);
  fs.unlinkSync(path.join(music, "beat-palette.cjs"));
  await assert.rejects(verifyRuntime(target), /ENOENT|music_runtime_missing_dependency/);
});
