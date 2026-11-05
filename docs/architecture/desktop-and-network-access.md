# Windows desktop and local network access

RaveLink-Core.exe now hosts the existing website in a WebView2 WinForms window.
There is one frontend and one Core instance. The ordinary loopback URL remains
available; a separate, explicitly enabled LAN gateway serves the same UI and APIs.

## Desktop lifetime

The existing mutex, tray, restart/exit events, server job, update handshake and
shutdown deadline remain with CoreApplicationContext. The window is a viewer:
it adds no Node access, lighting logic, or generic native command bridge.
`--background` does not initialize WebView2. Closing hides the viewer while Core
continues running. Exit disposes the viewer and drains Core as before.

The frame uses the app icon and dark palette, follows valid theme color updates,
and supports native resizing, DPI scaling, Back/Forward, Reload, F11 full screen,
clipboard actions, Save As downloads, and browser fallback. Window placement
persists in `runtime/desktop-window.json`, checked against connected monitors.
WebView profiles use an installation/port-specific folder under
`%LOCALAPPDATA%/RaveLink/Core/WebView2`, outside managed release files.

Top-level browsing is restricted to the exact loopback origin. HTTP(S) external
links open in the system browser. Short-lived child WebViews preserve the
`window.open('about:blank')` handle used by existing asynchronous sign-in flows;
their later external navigation transfers to the system browser. Local child
pages can stay in an app window. Native file/shell schemes are not launched.
The only native web message accepts three bounded theme colors from the current
top-level document. Host objects and unnecessary permissions are disabled.

The SDK version and package/file hashes are pinned in `webview2-sdk.json`.
`restore-webview2.ps1` validates existing files or downloads/verifies the NuGet
archive, extracting only the two managed libraries, x64 loader, and license.
The release adds less than 1 MB of bindings; the separately installed Evergreen
Runtime receives Microsoft updates. A missing runtime leaves Core/browser access
working and offers an installation link. See Microsoft's
[distribution model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
and [WebView2 security guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security).

## Optional LAN gateway

The LAN dialog defaults off. Enabling it starts a second HTTP listener, normally
port 5051, with full operator controls for private-network peers. Its addresses
come from current private IPv4 interfaces. Anyone on that network who knows the
address can use those controls; it is not an authenticated internet endpoint.
The original listener and desktop window continue using localhost, normally 5050.

The gateway accepts private/link-local IPv4 peers and local tests. Host headers
must name one of this machine's actual private interface addresses and its LAN
port. Browser Origin must match; null origins, cross-site browser requests, public
peers, and arbitrary DNS names are rejected. Forwarded-address and hop headers
are stripped. Upstream is fixed to 127.0.0.1 and the known Core port. Streaming
HTTP responses remain streamed; no extra controller or business logic is added.
Existing operator guards, capability checks, token checks and browser-origin
rules still run at Core. Global `allowRemoteWrite` remains unchanged.

Network settings persist in `runtime/system/network-sharing.json`. Starting an
enabled gateway after launch is lifecycle-owned. A failed bind retains the
previous working listener and settings. Switching ports starts the replacement
before closing the old listener; disable/shutdown closes clients, including SSE.
Turning sharing off never closes localhost. The gateway supports IPv4 HTTP;
it does not configure router forwarding, Windows Firewall, HTTPS or mDNS.
Windows may require permission for Private-network traffic.

LAN HTTP pages use a browser copy-command fallback when the secure Clipboard API
is unavailable. OAuth providers requiring registered loopback redirect addresses
must be connected on the Core computer; their already-connected controls remain
usable over LAN. Audio capture and fixture access still happen on the Core PC.

## Verification

Native tests compile and run the actual WinForms/WebView2 window against a dry-run
Core. They verify rendering, theme synchronization, profile retention on reload,
popup WindowProxy behavior, blocked file navigation, and hide/show reuse. Existing
host tests verify restart, cancellation and the blocked-UI exit deadline.
LAN tests exercise full operator writes, Host/Origin rejection, streaming cleanup,
saved activation, port conflicts, shared state, and phone/desktop browser layouts.
Updater tests preserve browser/window data while replacing/restoring the loader.
Physical access from another LAN device remains subject to that PC's firewall.
