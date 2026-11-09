# Windows setup and offline dependencies

The 0.7.6a installer carries its prerequisites. Version 0.7.6 included only
the WebView2 bindings/loader; the browser runtime itself is now bundled too.

| Component                                              | How it is supplied                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node and production JavaScript dependencies            | Bundled; no npm installation on the user's PC.                                                                                                                                                                |
| WebView2 SDK bindings and native loader                | Bundled under `runtime/desktop`.                                                                                                                                                                              |
| WebView2 browser runtime                               | Microsoft's full x64 Evergreen Standalone Installer is embedded in Setup. Setup checks both machine and user installations, installs offline when missing, verifies the result, and blocks launch on failure. |
| Music-to-Light capture helper                          | Bundled when selected, with the C runtime statically linked. No Rust or Visual C++ redistributable installation.                                                                                              |
| Windows desktop host and Windows audio/media controls  | Use the .NET Framework and Windows APIs already supplied by supported Windows versions.                                                                                                                       |
| Twitch and Song Request                                | Verified, inactive package inventories are bundled. Setup installs selected packages without network requests; the remaining packages stay available in Packages.                                             |
| Spotify/TIDAL companions and YouTube browser extension | Their first-party integration files are bundled. Preparing a companion still requires the user's separately installed player, or a supported browser for the extension.                                       |

The minimum Windows version remains Windows 10 x64 build 19041. Application
audio capture requires build 20348 or later; Windows 11 is recommended.
[.NET Framework 4.8 is included in supported Windows builds](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-10).
A damaged or stripped Windows installation may require Windows component repair;
installing another framework package cannot repair an operating-system component.

Microsoft recommends the
[Evergreen Standalone Installer for offline deployment](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#offline-deployment).
The prerequisite manifest pins its Microsoft download URL, size, and SHA-256.
The build additionally verifies its Microsoft Authenticode signature. No runtime
installer is executed on the build machine; only its bytes are
staged. Setup installs it only if absent, per-user by default, and never removes
the shared runtime when RaveLink is uninstalled.

Portable ZIPs include the same full installer under
`optional-components/prerequisites/MicrosoftEdgeWebView2RuntimeInstallerX64.exe`.
Run that file once if WebView2 is missing. Existing browser and LAN access remain
available independently of the desktop viewer.

Account sign-in, streaming services, online song searches, updates, and downloads
of third-party mods need their respective services. OBS, Discord, Spotify and
TIDAL are external applications, not silently installed by RaveLink. No accounts,
credentials, device configuration, installed features, or machine-specific data
are copied into a release.

## Build and verification

`scripts/restore-windows-prerequisites.ps1` obtains the pinned offline installer
into the ignored build cache and verifies it without running it. A normal
`scripts/package-release.ps1` build stages that installer and verified first-party
feature inventories. `scripts/build-windows-setup.js` embeds the offline runtime
in Inno Setup and installs optional features with `--offline`.

Use `-OutputDirectory dist/offline-setup-validation` for an isolated package build
and `RAVELINK_SETUP_DIST` pointing to that same directory for its installer.
This leaves previously published artifacts untouched. Build tools, source-test
fixtures, and the prerequisite download cache are not consumer application data.
