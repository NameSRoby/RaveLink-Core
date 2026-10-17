/** Assemble transfer UI fragments in dependency order; --check never writes. */
const path = require("node:path");
const { read, replaceBlock, syncFile } = require("./lib/embedded-assets");
const root = path.resolve(__dirname, "../features/song-request/ui");
const sources = [
  "provider-marks.js",
  "playlist-provider-ui.js",
  "playlist-transfer-flow.js",
  "playlist-browser.js",
  "playlist-link-imports.js",
  "playlist-workspace.js",
  "playlist-match-review.js",
  "playlist-community.js",
  "playlist-transfers.js",
];
const source = sources.map((file) => read(path.join(root, file))).join("\n");
syncFile(
  path.join(root, "server-playlist.html"),
  (content) =>
    replaceBlock(
      content,
      "// PLAYLIST_TRANSFERS_BEGIN",
      "// PLAYLIST_TRANSFERS_END",
      `\n${source}\n`,
    ),
  { check: process.argv.includes("--check") },
);
