/** Reviewed bundled adapters use the same exact-inventory verifier as other mods. */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const prettier = require("prettier");
const base = path.resolve(__dirname, "../packages/bundled-mods"),
  check = process.argv.includes("--check");
async function main() {
  for (const slug of ["discord-controls", "twitch-clips"]) {
    const directory = path.join(base, slug),
      manifestPath = path.join(directory, "ravelink.mod.json");
    const current = fs.readFileSync(manifestPath, "utf8"),
      manifest = JSON.parse(current),
      files = {};
    function walk(relative = "") {
      for (const entry of fs
        .readdirSync(path.join(directory, relative), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const file = relative ? relative + "/" + entry.name : entry.name;
        if (file === "ravelink.mod.json") continue;
        if (entry.isSymbolicLink()) throw Error("Bundled mod links are forbidden");
        if (entry.isDirectory()) {
          walk(file);
          continue;
        }
        const target = path.join(directory, file),
          bytes = fs.readFileSync(target);
        const normalized = /\.(js|json|md|txt)$/.test(file)
          ? Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"))
          : bytes;
        if (check && !bytes.equals(normalized)) throw Error("Bundled text must use LF: " + file);
        if (!check && !bytes.equals(normalized)) fs.writeFileSync(target, normalized);
        files[file] = crypto.createHash("sha256").update(normalized).digest("hex");
      }
    }
    walk();
    if (check) {
      const keys = Object.keys(files).sort(),
        declared = manifest.integrity?.files || {};
      if (
        JSON.stringify(keys) !== JSON.stringify(Object.keys(declared).sort()) ||
        keys.some((key) => files[key] !== declared[key])
      )
        throw Error("Bundled inventory is stale: " + slug);
    }
    manifest.integrity = { algorithm: "sha256", files };
    const options = await prettier.resolveConfig(manifestPath);
    const generated = await prettier.format(JSON.stringify(manifest), {
      ...options,
      filepath: manifestPath,
    });
    if (check && current !== generated) throw Error("Bundled manifest is not canonical: " + slug);
    if (!check && current !== generated) fs.writeFileSync(manifestPath, generated, "utf8");
  }
  console.log("[BUNDLED MODS] Integrity inventories " + (check ? "verified." : "updated."));
}
main().catch((error) => {
  console.error("[BUNDLED MODS] " + error.message);
  process.exitCode = 1;
});
