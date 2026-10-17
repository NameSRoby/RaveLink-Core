/**
 * Build the self-contained provider workspace. Script order is intentional:
 * provider marks/helpers load before installers, then player-providers wires
 * them into the page. Keep the cascade in player-providers.css in source order.
 */
const path = require("node:path");
const { read, replaceBlock, syncFile } = require("./lib/embedded-assets");
const root = path.resolve(__dirname, "../features/song-request/ui");
const scripts = [
  "provider-marks.js",
  "player-branding.js",
  "player-provider-errors.js",
  "player-provider-notices.js",
  "player-tidal-queue.js",
  "player-moderation.js",
  "player-soundcloud.js",
  "player-now-playing.js",
  "player-volume.js",
  "player-spotify-account.js",
  "player-spotify.js",
  "player-providers.js",
];
const styles = ["player-branding.css", "player-providers.css", "player-now-playing.css"];
const css = styles.map((file) => read(path.join(root, file))).join("\n");
const script = scripts.map((file) => read(path.join(root, file))).join("\n");
syncFile(
  path.join(root, "player.html"),
  (content) =>
    replaceBlock(
      content,
      "<!-- PLAYER PROVIDERS START -->",
      "<!-- PLAYER PROVIDERS END -->",
      `\n<style>\n${css}\n</style>\n<script>\n${script}\n</script>\n`,
    ),
  { check: process.argv.includes("--check") },
);
