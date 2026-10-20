/** Run every deterministic builder in read-only mode; stop at the first drift. */
const path = require("node:path");
const { spawnSync } = require("node:child_process");
for (const script of [
  "build-song-overlay-ui.js",
  "build-song-player-providers.js",
  "build-playlist-transfers.js",
  "build-spotify-desktop.js",
  "build-tidal-desktop.js",
  "build-music-to-light-ui.js",
  "refresh-feature-integrity.js",
]) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), "--check"], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    break;
  }
}
