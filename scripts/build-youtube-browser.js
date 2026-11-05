/** Build dependency-free WebExtensions from the same authored files.
 * Firefox uses an event page; Chromium uses a service worker. No Chrome-only
 * execution/injection APIs are used, and tokens are never compiled into a bundle.
 */
const fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, ".."),
  source = path.join(root, "integrations/youtube-browser/extension");
function build(destination = path.join(root, "dist/youtube-browser")) {
  const outputs = [];
  for (const browser of ["firefox", "chromium"]) {
    const target = path.join(destination, browser);
    fs.mkdirSync(target, { recursive: true });
    for (const file of fs.readdirSync(source))
      fs.copyFileSync(path.join(source, file), path.join(target, file));
    const manifest = {
      manifest_version: 3,
      name: "RaveLink YouTube Music companion",
      version: "0.3.0",
      description:
        "Pairs one YouTube Music tab with your local RaveLink song requests or test console.",
      permissions: ["storage", "activeTab", "scripting"],
      host_permissions: ["https://music.youtube.com/*", "http://127.0.0.1/*"],
      action: { default_popup: "popup.html" },
      background:
        browser === "firefox"
          ? { scripts: ["native-service.js", "background.js"] }
          : { service_worker: "background.js" },
      content_scripts: [
        {
          matches: ["http://127.0.0.1/*"],
          js: ["pairing.js"],
          run_at: "document_idle",
          all_frames: false,
        },
        {
          matches: ["https://music.youtube.com/*"],
          js: ["site-adapter.js", "content.js"],
          run_at: "document_idle",
          all_frames: false,
        },
      ],
      ...(browser === "firefox"
        ? {
            browser_specific_settings: {
              gecko: {
                id: "youtube-browser@ravelink.local",
                strict_min_version: "128.0",
                data_collection_permissions: { required: ["none"] },
              },
            },
          }
        : { minimum_chrome_version: "120" }),
    };
    fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    outputs.push(target);
  }
  return outputs;
}
if (require.main === module)
  build().forEach((folder) => console.log(`[YOUTUBE BROWSER] ${path.relative(root, folder)}`));
module.exports = { build };
