/**
 * Refresh or verify exact first-party feature inventories after source changes.
 * Every payload file is hashed after LF normalization; the manifest is excluded
 * from its own inventory. This is build metadata, never a replacement for the
 * runtime verifier's size, path, permission, and inventory checks.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const check = process.argv.includes("--check");

for (const feature of ["song-request", "twitch-integration"]) {
  const directory = path.join(root, "features", feature);
  const filename = path.join(directory, "ravelink.feature.json");
  const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
  const files = {};
  function walk(relative = "") {
    for (const entry of fs
      .readdirSync(path.join(directory, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && entry.name === "ravelink.feature.json") continue;
      if (entry.isSymbolicLink()) throw Error(`Feature links are forbidden: ${feature}/${file}`);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isFile()) throw Error(`Unsupported feature file: ${feature}/${file}`);
      const absolute = path.join(directory, file);
      const bytes = fs.readFileSync(absolute);
      const normalized = /\.(?:js|cjs|html|css|json|md|txt)$/.test(file)
        ? Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"))
        : bytes;
      if (check && !bytes.equals(normalized))
        throw Error(`Feature text must use LF bytes: ${feature}/${file}`);
      if (!check && !bytes.equals(normalized)) fs.writeFileSync(absolute, normalized);
      files[file] = crypto.createHash("sha256").update(normalized).digest("hex");
    }
  }
  walk();
  if (check) {
    const declared = manifest.integrity?.files || {};
    const actual = Object.keys(files).sort();
    if (
      JSON.stringify(actual) !== JSON.stringify(Object.keys(declared).sort()) ||
      actual.some((file) => files[file] !== declared[file])
    )
      throw Error(`Feature inventory is stale: ${feature}`);
  } else {
    manifest.integrity = { ...manifest.integrity, files };
    fs.writeFileSync(filename, JSON.stringify(manifest, null, 2) + "\n");
  }
}
console.log(`[FEATURES] Integrity inventories ${check ? "verified" : "updated"}.`);
