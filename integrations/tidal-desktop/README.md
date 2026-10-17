# Bundled RaveLink TIDAL companion

RaveLink maintains this small Windows companion locally. It needs the regular
TIDAL Desktop app, not TidaLuna or an external plugin installer. No account tokens,
audio files, DRM code, TIDAL binaries, or upstream plugin platform are packaged.
Live desktop and account acceptance are tracked separately from automated checks.

The external Luna plugin download and its separate operator page are retired.
Use the bundled companion's Player setup below. The authenticated bridge URLs
and `song.tidal.experimental.v1` capability keep their existing names for
compatibility; removing the old distribution does not remove live queue support.

Song lookup uses each user's TIDAL OAuth authorization with PKCE. RaveLink ships
only its public client ID, no developer secret or maintainer account token, and
uses no hosted credential server. User tokens are encrypted on the local PC.
Direct track URLs/IDs do not require the separate catalog sign-in.

## Setup from the Player

1. Restart Core after updating Song Request to 0.28.0, then reload the browser.
2. Open Song Request → Player and choose TIDAL. The local integration starts automatically.
3. Close TIDAL. In the selected player's Setup subtab, under Connect the desktop player, choose Install companion.
4. Start TIDAL normally. Play something locally to initialize its queue, then
   refresh the companion status in RaveLink.
5. For text lookup, choose Sign in with TIDAL and finish authorization in the
   TIDAL popup. Check connection tests catalog access. Account tokens are saved
   encrypted with Windows DPAPI and can be removed with Disconnect account.
6. Submit an artist/song name or a TIDAL track URL/ID, requests are sent automatically, and choose
   Use TIDAL for now playing under Connection options to show Windows media metadata.

Install refuses a running TIDAL process or an existing Luna/other loader. The
Microsoft Store version is unsupported. Uninstall companion requires TIDAL closed
and restores the original archive. It refuses changed files or an update collision
instead of deleting unrelated files. No process is killed automatically.

Client-ID overrides and callback diagnostics appear only in HUD Developer Mode.
The saved ID is never displayed; an override is blank, masked and write-only.
Normal setup uses the bundled public ID and the Sign in with TIDAL button.
Account/region, connection options and recent deliveries expand on demand.
Catalog country is a named dropdown of supported locations, not a free-text code.

The pairing-file path and Core address are saved locally in the companion's
configuration. The scoped token stays in Core's pairing file and is read only by
the native transport. There are no environment variables to set. Enabling the
integration lasts for the Core session; selecting TIDAL starts it again after a restart.

## Command line alternative

From the RaveLink directory, with TIDAL closed for install/uninstall:

```powershell
npm.cmd run tidal:companion -- status
npm.cmd run tidal:companion -- install
npm.cmd run tidal:companion -- uninstall
```

The manager discovers the latest `%LOCALAPPDATA%/TIDAL/app-*/resources` directory.
Use `--resources "PATH TO resources"` for a custom installation and
`--pairing-file "PATH SHOWN BY RAVELINK"` for a custom runtime directory. An
alternate loopback port can be supplied with `--core-url http://127.0.0.1:PORT`.
After TIDAL updates, the new version needs installation again. Old version
directories are not silently modified. The UI discovers the latest version;
the CLI can explicitly uninstall an older one using `--resources`.

## Maintenance boundary

`npm.cmd run build:tidal-desktop` builds the complete local bundle with built-in
Node modules. Source and compiled payload ship in `integrations/tidal-desktop`.
There is no upstream download/build step. The existing Luna companion remains an
optional legacy path using the same authored adapter and Core protocol.

The bootstrap preserves `app.asar` as `ravelink-original.asar`, starts the original
TIDAL entry point, and adds a narrow Electron preload. Only the main frame on
`desktop.tidal.com` or `listen.tidal.com` can use the two-method native bridge.
Trusted `/assets/*.js` responses get a small Redux hook prefix/transform. The
original CSP, HTML, imports, login flow and module loader are retained.
The action finder and middleware-store pattern were checked against the public
TIDAL desktop assets on 2026-10-14. Missing hooks leave the companion not ready;
unrelated actions are untouched. Core journals uncertain writes without replay.

Companion 0.1.1 preserves access to `app.asar.unpacked` through an owned junction
at `ravelink-original.asar.unpacked`; uninstall removes the junction only. This
keeps native helpers and unpacked modules accessible without moving their original
directory. Window ownership uses Electron's real `web-contents-created` event,
including apps whose cached imports bypass a constructor proxy. Bounded startup
stages/error codes are logged to `resources/ravelink-tidal-startup.log`; no
credentials, command payloads or full error messages are logged.

Private app internals remain a compatibility dependency even though Luna is no
longer required. A TIDAL update may require changes to the transformer or queue
adapter. Test source hooks, metadata resolution, queue/current-item preservation,
pairing boundaries, install recovery and actual desktop playback before calling
a new app version supported. The existing title/artist confirmation proves
playback start, not full completion or exact recording identity.

Text input uses TIDAL's official server API with a user OAuth token:
`GET /v2/searchResults?filter[query]=...`, then individual track/artist reads for the first
five linked track IDs. Core applies the existing song confidence, typo, version
and saved maximum duration rules. The companion validates the selected ID using
the desktop metadata loader. It performs no text search. YouTube subscriber/view
thresholds do not apply to TIDAL. Searches are limited to ten per minute, with a
bounded ten-minute cache and shared duplicate lookups. API requests reject
redirects and use fixed TIDAL hosts, response limits and deadlines. Tokens stay
outside the feature process; user tokens are encrypted in the native vault.

Add to queue appends in FIFO order after upcoming manual requests and before the underlying playlist. Successive requests keep their submission order. It preserves
the currently playing item and the relative order/identity of all existing queue
entries. Queue mutation is asynchronous; the companion waits for confirmation
instead of assuming dispatch is synchronous. No clear, playback-start or playlist
replacement command is sent. The initial maximum song length remains ten minutes;
change it under Request limits & song length to allow longer tracks.

For the RaveLink app registration, add the exact redirect URI
`http://127.0.0.1:5050/auth/tidal/callback` and enable `search.read`. A custom app
ID override and the actual callback address are available in Developer Mode;
the saved ID is never displayed. A custom Core port requires that exact URI registered with
TIDAL. No client secret is accepted. Live sign-in and catalog access remain an
acceptance gate; the current API specification has ambiguous internal-scope
annotations on search. RaveLink reports access denial without a secret fallback.

Upgrade to companion 0.1.5 by quitting TIDAL completely (including its tray icon),
then choosing Update companion in Setup and reopening TIDAL. This preserves
uninstall ownership checks, original files and unpacked-resource recovery. The
updated adapter accepts the current device-state object, rejects remote playback,
and uses the normal single-track insertion action with queue replacement off.
Metadata replies are correlated to the requested track. Catalog authorization is independent of
desktop login. Embeds are excluded; the companion supplies native queue insertion.

Older unconfirmed deliveries remain held. Under Recently sent to TIDAL, check
the app's queue and playback history, then choose Not in TIDAL · allow retry only
for an absent request. This unlocks its Add to queue button without resending it.
Failures reported before dispatch are recorded as not sent and can be retried
without an uncertain-delivery review. No uncertain write is automatically replayed.

Licenses and credits: [NOTICE.md](NOTICE.md),
[TidaLuna Ms-PL](LICENSE.TidaLuna), [RaveLink Apache-2.0](LICENSE.RaveLink).

Companion 0.1.5 reports upcoming manual-request UIDs/count and the current native UID to Core. Core and the adapter both enforce ten upcoming requests while preserving the playlist. Remaining requests stay in RaveLink; native queue changes wake the FIFO delivery worker without a UI timer. The count excludes history, the playing item and underlying playlist entries. Queue reports contain no account credentials or media bytes.

Companion 0.1.6 adds exact-UID native removal and skipping for Song Request moderation. Quit TIDAL completely, update the companion in Player > TIDAL > Setup, then reopen TIDAL. Core confirms removal before reporting success, preserves unrelated playlist items and requires review when an older delivery has no recorded UID.
