/**
 * Preload.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
// Runs only inside TIDAL's Electron runtime.
const { contextBridge, ipcRenderer } = require("electron");
if (
  process.isMainFrame &&
  /^https:\/\/(?:desktop|listen)\.tidal\.com(?:\/|$)/.test(location.href)
) {
  contextBridge.exposeInMainWorld("__ravelinkTidalBridge", {
    call: (method, payload) => ipcRenderer.invoke("ravelink-tidal-command", method, payload),
  });
}
