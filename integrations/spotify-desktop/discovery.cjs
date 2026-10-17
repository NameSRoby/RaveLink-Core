/**
 * Discovery.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
const fs = require("node:fs"),
  path = require("node:path");
const { spawnSync } = require("node:child_process");
module.exports = function discoverSpotify(options = {}) {
  const roots = [];
  const appData = options.appData === undefined ? process.env.APPDATA : options.appData;
  if (appData) roots.push(path.join(appData, "Spotify"));
  if ((options.platform || process.platform) === "win32") {
    const result = (options.spawn || spawnSync)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$spotifyDiscoveryRoots=@(); Get-Process Spotify -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Path) { $spotifyDiscoveryRoots+=(Split-Path -Parent $_.Path) } }; Get-AppxPackage -Name SpotifyAB.SpotifyMusic -ErrorAction SilentlyContinue | ForEach-Object { $spotifyDiscoveryRoots+=$_.InstallLocation }; @($spotifyDiscoveryRoots | Select-Object -Unique) | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 32768 },
    );
    if (result.status === 0) {
      try {
        const parsed = JSON.parse(result.stdout || "[]");
        for (const root of Array.isArray(parsed) ? parsed : [parsed])
          if (typeof root === "string" && root.length < 1000 && path.isAbsolute(root))
            roots.push(root);
      } catch {}
    }
  }
  const seen = new Set(),
    found = [];
  for (const root of roots) {
    const absolute = path.resolve(root),
      key = absolute.toLowerCase(),
      appsPath = path.join(absolute, "Apps");
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (
        !fs.lstatSync(path.join(absolute, "Spotify.exe")).isFile() ||
        !fs.lstatSync(path.join(appsPath, "xpui.spa")).isFile()
      )
        continue;
      found.push({
        appsPath,
        executable: path.join(absolute, "Spotify.exe"),
        protectedStore: /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(absolute),
        preferredMode: "sidecar",
      });
    } catch {}
  }
  return found;
};
