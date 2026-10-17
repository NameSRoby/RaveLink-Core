const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const standalone = fs.existsSync(path.join(__dirname, "renderer-bootstrap.cjs"));
const root = standalone ? __dirname : path.resolve(__dirname, "../integrations/spotify-desktop"),
  output = standalone ? root : path.join(root, "dist");
const modules = [
  "catalog.cjs",
  "playlist-reader.cjs",
  "desktop-adapter.cjs",
  "native-facade.cjs",
  "connection-worker.cjs",
  "renderer-bootstrap.cjs",
];
// A fixed module inventory keeps this a small, auditable bundle with replaceable sources.
const entries = modules.map(
  (file) =>
    JSON.stringify("./" + file) +
    ":function(require,module,exports){\n" +
    fs.readFileSync(path.join(root, file), "utf8") +
    "\n}",
);
const renderer =
  '(function(){"use strict";const modules={' +
  entries.join(",\n") +
  '},cache={};function load(id){if(cache[id])return cache[id].exports;if(!modules[id])throw Error("spotify_bundle_module_missing");const module={exports:{}};cache[id]=module;modules[id](load,module,module.exports);return module.exports;}const config=globalThis.__ravelinkSpotifyConfig;delete globalThis.__ravelinkSpotifyConfig;load("./renderer-bootstrap.cjs")(globalThis,config?{connection:config}:{});})();\n';
const files = new Map([
  ["renderer.js", renderer],
  [
    "platform-hook.cjs",
    fs.readFileSync(
      path.join(root, standalone ? "platform-hook.cjs" : "vendor/spicetify/platform-hook.cjs"),
    ),
  ],
  [
    "LICENSE.Spicetify",
    fs.readFileSync(path.join(root, standalone ? "LICENSE.Spicetify" : "vendor/spicetify/LICENSE")),
  ],
  [
    "NOTICE.md",
    fs.readFileSync(path.join(root, standalone ? "NOTICE.md" : "vendor/spicetify/NOTICE.md")),
  ],
]);
// Include every linked module so the adapted component can be modified and rebuilt.
for (const file of modules) files.set(file, fs.readFileSync(path.join(root, file)));
files.set("build-spotify-desktop.js", fs.readFileSync(__filename));
const manifest = {
  version: "0.1.0-prototype",
  installable: false,
  upstream: "8c92e3067de9659caca4c9da7979da3897458e27",
  files: Object.fromEntries(
    [...files].map(([file, value]) => [
      file,
      crypto.createHash("sha256").update(value).digest("hex"),
    ]),
  ),
};
files.set("integrity.json", JSON.stringify(manifest, null, 2) + "\n");
if (fs.existsSync(output))
  for (const file of fs.readdirSync(output))
    if (!files.has(file)) throw Error("Unexpected Spotify bundle file: " + file);
if (process.argv.includes("--check")) {
  for (const [file, value] of files)
    if (
      !fs.existsSync(path.join(output, file)) ||
      !fs.readFileSync(path.join(output, file)).equals(Buffer.from(value))
    )
      throw Error("Spotify bundle stale: " + file);
} else {
  fs.mkdirSync(output, { recursive: true });
  for (const [file, value] of files) fs.writeFileSync(path.join(output, file), value);
  console.log("Built minimal Spotify prototype: no Spicetify executable, UI or package manager.");
}
