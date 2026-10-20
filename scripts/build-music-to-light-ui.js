/** One authored music view, embedded as native DOM in Lights. No iframe/worker.
 * Only the marked region is replaced; formatting remains the shared policy.
 */
const fs = require("node:fs");
const path = require("node:path");
const prettier = require("prettier");
async function main() {
  const root = path.resolve(__dirname, "..");
  const template = fs.readFileSync(path.join(root, "public/core/music-to-light.html"), "utf8");
  const body = template.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1];
  if (!body) throw Error("music_template_body_missing");
  const file = path.join(root, "public/core/index.html"),
    current = fs.readFileSync(file, "utf8");
  const region = /<!-- MUSIC-TO-LIGHT:START -->[\s\S]*?<!-- MUSIC-TO-LIGHT:END -->/;
  if (!region.test(current)) throw Error("music_native_region_missing");
  const next = await prettier.format(
    current.replace(
      region,
      `<!-- MUSIC-TO-LIGHT:START --><div data-light-panel="music" hidden><div class="musicWorkspace" data-music-controls>${body}</div></div><!-- MUSIC-TO-LIGHT:END -->`,
    ),
    { ...(await prettier.resolveConfig(file)), filepath: file },
  );
  if (process.argv.includes("--check")) {
    if (next !== current) throw Error("music_native_ui_stale");
  } else fs.writeFileSync(file, next);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
