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
            ["script", ["overlay-palette.js", "overlay-renderer.js"]],
          ],
        ],
      ];
      if (page === "overlay-editor.html")
        groups.push([
          "SONG_DESIGNER",
          [
            ["style", "designer.css"],
            ["script", ["designer-controls.js", "designer-canvas.js"]],
          ],
        ]);
      for (const [group, assets] of groups) {
        for (const [tag, source] of assets) {
          const marker = `${group}_${tag.toUpperCase()}`;
          const contentSources = Array.isArray(source) ? source : [source];
          const embedded = contentSources
            .map((file) => read(path.join(root, file)).trim())
            .join("\n\n");
          content = replaceBlock(
            content,
            `<!-- ${marker}_START -->`,
            `<!-- ${marker}_END -->`,
            `\n<${tag}>\n${embedded}\n</${tag}>\n`,
          );
        }
      }
      return content;
    },
    options,
  );
}
