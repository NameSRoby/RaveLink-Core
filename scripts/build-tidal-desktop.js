/**
 * Assemble the TIDAL companion from reviewed RaveLink sources. The renderer is
 * runtime + adapter + polling in that order; adapter.cjs also remains importable
 * by Node tests. Refuse a changed adapter export instead of generating bad code.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "../integrations/tidal-desktop");
const output = path.join(root, "dist");
const adapterSource = fs.readFileSync(path.join(root, "adapter.cjs"), "utf8");
const exportMarker = "exports.createAdapter = function createAdapter";
if (!adapterSource.includes(exportMarker)) throw Error("TIDAL adapter export is missing");
const adapter = adapterSource.replace(exportMarker, "function createAdapter");
const files = new Map([
  [
    "renderer.js",
    fs.readFileSync(path.join(root, "renderer-runtime.js"), "utf8") +
      "\n" +
      adapter +
      "\n" +
      fs.readFileSync(path.join(root, "renderer-poll.js"), "utf8"),
  ],
  [
    "package.json",
    JSON.stringify(
      {
        name: "ravelink-tidal-companion",
        version: "0.1.7",
        main: "injector.cjs",
        private: true,
      },
      null,
      2,
    ) + "\n",
  ],
]);
for (const file of [
  "injector.cjs",
  "preload.cjs",
  "transform.cjs",
  "native-bridge.cjs",
  "LICENSE.TidaLuna",
  "LICENSE.RaveLink",
  "NOTICE.md",
])
  files.set(file, fs.readFileSync(path.join(root, file)));
const inventory = Object.fromEntries(
  [...files]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, value]) => [file, crypto.createHash("sha256").update(value).digest("hex")]),
);
files.set("integrity.json", JSON.stringify({ version: "0.1.7", files: inventory }, null, 2) + "\n");
if (fs.existsSync(output)) {
  for (const entry of fs.readdirSync(output)) {
    if (!files.has(entry)) throw Error("Unexpected TIDAL bundle file: " + entry);
  }
}
if (process.argv.includes("--check")) {
  for (const [file, value] of files) {
    if (
      !fs.existsSync(path.join(output, file)) ||
      !fs.readFileSync(path.join(output, file)).equals(Buffer.from(value))
    )
      throw Error("TIDAL bundle stale: " + file);
  }
} else {
  fs.mkdirSync(output, { recursive: true });
  for (const [file, value] of files) fs.writeFileSync(path.join(output, file), value);
  console.log("Built self-contained RaveLink TIDAL companion 0.1.7.");
}
