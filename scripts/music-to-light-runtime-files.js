/** Runtime dependency inventory, derived from the two Core-owned music entry
 * points. Deferred literal requires count too; compiler/test/simulation trees do
 * not become application payload merely because they share a source directory.
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { parse } = require("espree");
const ROOT = path.resolve(__dirname, "..");
const MUSIC = "integrations/music-to-light/";
const ENTRIES = [
  "src/domains/music-to-light/music-to-light.service.js",
  "src/app/core/register-music-to-light.routes.js",
];
function runtimeFiles(root = ROOT, entries = ENTRIES) {
  const base = path.resolve(root),
    seen = new Set(),
    files = [];
  function visit(filename) {
    if (seen.has(filename)) return;
    seen.add(filename);
    const relative = path.relative(base, filename).split(path.sep).join("/");
    if (relative.startsWith("../") || path.isAbsolute(relative))
      throw Error("music_runtime_dependency_outside_source");
    if (relative.startsWith(MUSIC)) files.push(relative.slice(MUSIC.length));
    if (!/\.[cm]?js$/.test(filename)) return;
    const ast = parse(fs.readFileSync(filename, "utf8"), {
      ecmaVersion: "latest",
      sourceType: "commonjs",
    });
    const resolve = createRequire(filename).resolve;
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "Identifier" &&
        node.callee.name === "require"
      ) {
        const specifier = node.arguments[0];
        if (specifier?.type !== "Literal" || typeof specifier.value !== "string") {
          if (relative.startsWith(MUSIC)) throw Error("music_runtime_dynamic_require:" + relative);
        } else if (specifier.value.startsWith(".")) {
          let dependency;
          try {
            dependency = resolve(specifier.value);
          } catch {
            throw Error("music_runtime_missing_dependency:" + relative + ":" + specifier.value);
          }
          visit(dependency);
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") walk(value);
      }
    }
    walk(ast);
  }
  entries.forEach((entry) => visit(path.resolve(base, entry)));
  return files.sort();
}
async function verifyRuntime(target, source = ROOT) {
  const root = path.resolve(target),
    files = runtimeFiles(source);
  for (const relative of files) {
    const file = path.join(root, MUSIC, relative);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error("music_runtime_invalid_file:" + relative);
  }
  // Resolve in the staged tree as well: a complete source checkout must never
  // conceal an omitted relative module or JSON profile in the actual download.
  runtimeFiles(root);
  const catalog = require(path.join(root, MUSIC, "native-catalog.cjs"));
  const createMapper = require(path.join(root, MUSIC, "mapper.cjs"));
  const createRenderer = require(path.join(root, MUSIC, "profile-renderer.cjs"));
  const createHost = require(
    path.join(root, "src/domains/music-to-light/music-to-light.service.js"),
  );
  for (const look of catalog.looks) {
    const fixture = { id: "runtime-check", role: "all", position: 0, raveBehavior: "reactive" };
    const mapper = createRenderer(
      createMapper({ ...catalog.baseline, ...look.design }, { random: () => 0.37 }),
      [fixture],
    );
    mapper.update(
      { endFrame: 960, discontinuities: 0, rms: 0.05, signal: "signal", invalidSamples: 0 },
      20,
    );
    const frame = mapper.render(20, fixture);
    if (!frame || !Number.isFinite(frame.brightness)) throw Error("music_runtime_invalid_render");
  }
  const host = createHost({ installed: false });
  try {
    if (!host.view().design) throw Error("music_runtime_invalid_host");
  } finally {
    await host.shutdown();
  }
  return files.length;
}
if (require.main === module) {
  if (process.argv[2] === "--check") {
    verifyRuntime(process.argv[3] || ROOT)
      .then((count) => {
        console.log(`[MUSIC-RUNTIME] ${count} runtime dependencies and native profiles verified.`);
      })
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  } else console.log(runtimeFiles().join("\n"));
}
module.exports = { runtimeFiles, verifyRuntime };
