/** Rebuild shared renderer/designer blocks in the two self-contained overlay pages. */
const path = require("node:path");
const { read, replaceBlock, syncFile } = require("./lib/embedded-assets");
const root = path.resolve(__dirname, "../features/song-request/ui");
const options = { check: process.argv.includes("--check") };
for (const page of ["overlay-editor.html", "obs-overlay.html"]) {
  syncFile(
    path.join(root, page),
    (content) => {
      const groups = [
        [
          "SONG_OVERLAY",
          [
            ["style", "overlay-renderer.css"],
            ["script", "overlay-renderer.js"],
          ],
        ],
      ];
      if (page === "overlay-editor.html")
        groups.push([
          "SONG_DESIGNER",
          [
            ["style", "designer.css"],
            ["script", "designer-controls.js"],
          ],
        ]);
      for (const [group, assets] of groups) {
        for (const [tag, source] of assets) {
          const marker = `${group}_${tag.toUpperCase()}`;
          content = replaceBlock(
            content,
            `<!-- ${marker}_START -->`,
            `<!-- ${marker}_END -->`,
            `\n<${tag}>\n${read(path.join(root, source)).trim()}\n</${tag}>\n`,
          );
        }
      }
      return content;
    },
    options,
  );
}
