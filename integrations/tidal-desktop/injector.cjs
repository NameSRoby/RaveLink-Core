/**
 * Injector.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
// Runs inside TIDAL's Electron runtime; no separate Electron dependency is shipped.
const electron = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { transform } = require("./transform.cjs");
const { createNativeBridge } = require("./native-bridge.cjs");
const bundle = __dirname;
function diagnostic(stage, error) {
  try {
    const filename = path.join(process.resourcesPath, "ravelink-tidal-startup.log");
    if (fs.existsSync(filename) && fs.statSync(filename).size > 65536)
      fs.writeFileSync(filename, "");
    const code = String(error?.code || error?.name || "")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 60);
    fs.appendFileSync(filename, `${new Date().toISOString()} ${stage}${code ? " " + code : ""}\n`);
  } catch {
    /* Diagnostics must never prevent TIDAL startup. */
  }
}
diagnostic("bootstrap-start");
const original = path.join(process.resourcesPath, "ravelink-original.asar");
const manifest = JSON.parse(fs.readFileSync(path.join(original, "package.json"), "utf8"));
let bridge;
try {
  bridge = createNativeBridge(
    JSON.parse(fs.readFileSync(path.join(bundle, "config.json"), "utf8")),
  );
} catch (error) {
  diagnostic("companion-config-disabled", error);
}
const runtime = fs.readFileSync(path.join(bundle, "renderer.js"), "utf8");
const trusted = (url) => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      ["desktop.tidal.com", "listen.tidal.com"].includes(parsed.hostname) &&
      !parsed.port
    );
  } catch {
    return false;
  }
};
const windows = new Set();
// Observe real Electron windows instead of replacing its module exports. TIDAL's
// cached/named imports can otherwise bypass a BrowserWindow proxy entirely.
electron.app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "window") return;
  const id = contents.id;
  windows.add(id);
  diagnostic("window-created");
  contents.on("destroyed", () => windows.delete(id));
  contents.on("did-finish-load", () => diagnostic("window-loaded"));
  contents.on("did-fail-load", () => diagnostic("window-load-failed"));
});
electron.ipcMain.handle("ravelink-tidal-command", (event, method, payload) => {
  if (
    !windows.has(event.sender.id) ||
    event.senderFrame !== event.sender.mainFrame ||
    !trusted(event.senderFrame.url)
  )
    throw new Error("tidal_sender_invalid");
  if (!bridge) throw new Error("tidal_companion_config_invalid");
  return bridge.call(method, payload);
});
// Prepending to TIDAL's own permitted asset preserves its CSP and module loader.
electron.app
  .whenReady()
  .then(async () => {
    electron.protocol.handle("https", async (request) => {
      const response = await electron.net.fetch(request, {
        bypassCustomProtocolHandlers: true,
      });
      const url = new URL(request.url);
      if (!trusted(request.url) || !/^\/assets\/[\w.-]+\.js$/.test(url.pathname) || !response.ok)
        return response;
      const source = await response.text();
      if (source.length > 16000000)
        return new Response(source, {
          status: response.status,
          headers: response.headers,
        });
      const patched = transform(source);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.delete("etag");
      return new Response(runtime + "\n" + patched.code, {
        status: response.status,
        headers,
      });
    });
    await electron.session.defaultSession.clearStorageData({
      origin: "https://desktop.tidal.com",
      storages: ["cachestorage"],
    });
  })
  .catch((error) => {
    diagnostic("protocol-hook-disabled", error);
  });
// Add a sandbox-compatible preload without replacing TIDAL's own preload.
electron.app.on("ready", () => {
  try {
    const session = electron.session.defaultSession,
      preload = path.join(bundle, "preload.cjs");
    if (session.registerPreloadScript)
      session.registerPreloadScript({ type: "frame", filePath: preload });
    else session.setPreloads([...session.getPreloads(), preload]);
  } catch (error) {
    diagnostic("preload-hook-disabled", error);
  }
});
const originalRequire = Module.createRequire(path.join(original, "package.json"));
electron.app.setAppPath(original);
electron.app.setName(manifest.name);
const entry = path.resolve(original, manifest.main);
if (!entry.startsWith(original + path.sep)) throw new Error("tidal_entry_invalid");
diagnostic("original-entry-start");
try {
  originalRequire(entry);
} catch (error) {
  diagnostic("original-entry-failed", error);
  throw error;
}
