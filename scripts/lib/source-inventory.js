/** Canonical authored sources, excluding local state, vendor code, and rebuilt companions. */
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "../..");
const SOURCE_ROOTS = [
  "src",
  "public/core",
  "features/song-request",
  "features/twitch-integration",
  "features/clip-studio",
  "integrations",
  "desktop",
  "packages",
  "scripts",
  "test",
];
const GENERATED_PAGES = new Set([
  "features/song-request/ui/player.html",
  "features/song-request/ui/server-playlist.html",
  "features/song-request/ui/overlay-editor.html",
  "features/song-request/ui/obs-overlay.html",
]);

function sourceFiles(roots = SOURCE_ROOTS, root = ROOT) {
  const files = [];
  function walk(relative) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (["node_modules", "vendor", "bin", "obj"].includes(entry.name)) continue;
      const file = `${relative}/${entry.name}`;
      if (/^integrations\/[^/]+\/dist(?:\/|$)/.test(file)) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  roots.forEach(walk);
  return files.sort();
}

module.exports = { ROOT, SOURCE_ROOTS, GENERATED_PAGES, sourceFiles };
