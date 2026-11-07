# Application API map

Use this map to choose the supported integration surface in Core 0.7.6.
[Mod authors](MOD_AUTHOR_GUIDE.md) should use the
[mod API](MOD_API_REFERENCE.md); HTTP access is not automatically granted to a mod.
All examples below refer to the Core PC's localhost instance, normally port 5050.
Full controls can also be deliberately shared on a private LAN. Treat those
devices as trusted operators. None of these interfaces is a public internet API.

## Versioned Core client API

External clients should first read `GET /system/client-api`, then negotiate with
`POST /system/client-api/negotiate`, for example:

```json
{ "apiMajor": 1, "minimumMinor": 0, "requiredOperations": ["health", "fixtures.list"] }
```

Load `GET /system/client-api/contracts` or the identical
[published JSON contract](contracts/core-client-api-v1.json) for every request and
response schema, deadline, retry disposition and size bound. The
[protocol guide](architecture/core-client-api-v1.md) covers compatibility, errors
and restart handling. Required operations can be unavailable in another composition.

All operation paths are `/api/core/v1/<operation-id>`:

| Operation            | HTTP | Purpose                                                  | Read-only |
| -------------------- | ---- | -------------------------------------------------------- | --------- |
| `health`             | GET  | Composition/version and capability health                | Yes       |
| `fixtures.list`      | GET  | Redacted fixture inventory                               | Yes       |
| `fixtures.edit`      | POST | Explicit local fixture edit projection                   | Yes       |
| `fixtures.upsert`    | POST | Create/update validated configuration                    | No        |
| `fixtures.delete`    | POST | Remove a fixture                                         | No        |
| `fixtures.test`      | POST | Bounded connectivity test                                | Yes       |
| `lights.apply`       | POST | Governed light operation using the existing output owner | No        |
| `widget.status`      | GET  | Widget/security status                                   | Yes       |
| `widget.get`         | POST | Retrieve widget output with the supplied token           | Yes       |
| `widget.rebuild`     | POST | Regenerate widget and rotate its token                   | No        |
| `widget.clear-token` | POST | Clear widget authorization                               | No        |
| `updates.status`     | GET  | Available, staged and rollback state                     | Yes       |
| `updates.configure`  | POST | Save update preferences                                  | No        |
| `updates.check`      | POST | Explicit release check                                   | No        |
| `updates.download`   | POST | Stage and verify the selected release                    | No        |
| `updates.apply`      | POST | Request hosted update                                    | No        |
| `updates.rollback`   | POST | Request hosted rollback                                  | No        |

GET operations have no payload; POST operations use the contract's object schema.
Requests are at most 64 KiB; replies at most 512 KiB, depth 12 and 16,384 values.
Browser Origin must match the serving origin. Invalid input is rejected before
effects; invalid owner replies can return 502 with an unknown write outcome.
Retry only operations explicitly marked read-only, honor 429 `Retry-After`, and
never replay a write after a timeout/disconnection. Refresh capabilities after
a changed `serverInstanceId`. The JSON contract is the authoritative field list.

## Dashboard operator API

These routes support the first-party dashboard. They use existing owners and
local/same-origin admission, including the explicitly enabled private LAN gateway.
They are not the versioned external-client compatibility contract. Most replies
are `{ok:true,value:...}`; errors are `{ok:false,error:<code>}`. Handle conflicts
and rate limiting; do not assume every action exists on every PC.

| Method/path                                  | Purpose/input                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/control-deck`                      | Current revision, pages/layout/widgets, running work and feedback.                                                          |
| `GET /api/control-deck/catalog`              | Available action IDs, schemas, defaults, slider/navigation metadata and current states.                                     |
| `PUT /api/control-deck`                      | `{revision,value}`; save a complete validated configuration. A stale revision returns conflict. Saving does not execute it. |
| `GET /api/control-deck/state`                | Current shared live snapshot.                                                                                               |
| `GET /api/control-deck/events`               | SSE live snapshots; share one connection per visible client, close it when hidden/unneeded.                                 |
| `POST /api/control-deck/buttons/:id/execute` | `{trigger:"press"}` or `"hold"`; sliders may supply a validated `value`. Executes only the saved action.                    |
| `POST /api/control-deck/cancel`              | `{runId?}`; cancel queued/request-owned macro work. Cannot undo completed effects.                                          |
| `POST /api/control-deck/media`               | Raw PNG/JPEG/GIF, at most 2 MiB; stores validated private media and returns its ID/URL.                                     |
| `POST /api/control-deck/screen-media`        | Private screen backdrop: raw PNG/JPEG/GIF up to 8 MiB, or MP4/WebM up to 16 MiB. Returns a content-addressed ID.             |
| `GET /api/control-deck/media/:id`            | Read immutable private raster/video media by its digest ID. No filesystem path input.                                      |
| `GET /api/control-deck/integrations`         | Current connection/permission availability.                                                                                 |
| `GET /api/control-deck/timestamps`           | Up to 1,000 local stream timestamps.                                                                                        |
| `POST /api/control-deck/timestamps`          | Create a local timestamp using confirmed stream timing.                                                                     |
| `DELETE /api/control-deck/timestamps/:id`    | Remove one local timestamp.                                                                                                 |

Discover IDs and parameter schemas from the live catalog rather than embedding
machine-specific IDs in a mod or client. Contributed actions use
`mod:<mod-id>:<action-id>`, OBS actions use a generated `obs:` ID, and audio targets
use discovered opaque keys. A macro step is
`{actionId,params,delayMs}`. A saved button includes `id`, `title`, `kind`, `steps`
and optional alternate/hold sequences and appearance. The
[configuration validator](../src/domains/control-deck/control-deck-config.js)
contains exact limits; the [deck guide](CONTROL_DECK.md) explains the UI workflow.

Saved light profiles contribute `lighting.profile:<profile-id>` actions. Discover
them from the catalog; calling them applies the saved profile through its existing
owner. `profileLighting` supplies one `{color,level}` preview per included fixture,
with no device identifiers. A button's `appearance.profileBacklight` is `"auto"`
by default; `"custom"` uses its normal static/cycling color instead. White LED
preview colors approximate the saved temperature; physical output uses the
fixture's dedicated temperature command. State feedback overrides decorative colors.

### Native Windows operations

| Method/path or action                   | Behavior                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /api/control-deck/windows/audio`   | Discover current output/input devices and per-app sessions.                                   |
| `POST /api/control-deck/windows/audio`  | Validated mixer command through the Core Audio owner; read the live target keys first.        |
| `POST /api/control-deck/windows/hotkey` | `{shortcut:"F13"}` or another supported key/modifier combination. Sends input on the Core PC. |
| `POST /api/control-deck/windows/media`  | `{key:"playPause"}`; also accepts `next`, `previous` or `stop`.                                |
| `native.hotkey`                         | F1–F24, letters/digits, supported named keys and Ctrl/Shift/Alt/Win combinations.             |
| `native.text`                           | Type bounded literal text; no shell evaluation.                                               |
| `native.open`                           | Explicit HTTP(S) URL or existing absolute Windows path; no command-line shell string.         |
| `native.media`                          | Validated media-key action, including mute/volume keys.                                       |
| `native.player.next` / `native.player.previous` | Targeted selected-native-player commands with empty parameters; separate from request moderation. |
| `native.player.playPause`               | Targeted native play/pause using current playback state; no global-key fallback.               |
| `native.audio.volume:<key>`             | Slider with `{level:0..100}`.                                                                 |
| `native.audio.mute:<key>`               | Toggle confirmed Windows mixer mute.                                                          |
| `native.audio.controls:<key>`           | Open the controls popup for the discovered target.                                            |

System/microphone targets follow the current default devices. App controls follow
application identity across process restarts; do not persist a PID as identity.
Keys target the host desktop, including from a phone; they do not confirm an
external application's state. RaveLink does not manage Discord's lifecycle.

Deck layout supports `sliderOrientation` (`vertical` or `horizontal`),
`sliderDock` (`start`: left/top; `end`: right/bottom), and `sliderPlacement`
(`dock` or `page`). These are shared deck settings, not per-button placement.
Optional `layout.screen` is `{mediaId,brightness,fit}`: brightness is 10–100 and
fit is `cover` or `contain`. IDs come only from the private screen-media upload.
`layout.sliderSnap` defaults false and `layout.sliderIncrement` is an integer
1–100 (default 5). A button's `appearance.sliderSnap` is `inherit`, `off` or `on`,
with its own `sliderIncrement` for the last choice. External state is not quantized;
snapping applies only to operator input and preserves both range endpoints.
Widget type `queue` is the current requester; `next-request` is the separate
upcoming request widget. Neither treats a missing requester as a known person.

### OBS operations

OBS Studio 28+ includes obs-websocket v5. Enable its server in OBS; no extra plugin
is required. Core owns one shared connection, protects saved credentials on the
host and returns only password-presence/status information to browsers.

| Method/path                                   | Purpose/input                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /api/control-deck/obs?refresh=true`      | Snapshot and optional bounded inventory refresh.                                                      |
| `PUT /api/control-deck/obs/connection`        | `{host,port,enabled,password?}`; omitted password preserves the saved credential.                     |
| `POST /api/control-deck/obs/local`            | Explicitly import this PC's saved OBS WebSocket settings and connect.                                 |
| `POST /api/control-deck/obs/disconnect`       | Disable the shared connection.                                                                        |
| `GET /api/control-deck/obs/browse`            | `kind=scene                                                                                           | filters | audio`, `name`and optional`group=true`; read available controls. |
| `GET /api/control-deck/obs/preview?scene=...` | Small read-only scene snapshot; never switches the program scene.                                     |
| `POST /api/control-deck/obs/buttons`          | `{target,previewImage?}`; create an action for a validated discovered target. It does not execute it. |

Target kinds are `scene`, `preview`, `source-toggle`, `source-show`, `source-hide`,
`mute-toggle`, `mute`, `unmute`, `volume`, `filter-toggle`, `filter-enable`,
`filter-disable`, `studio-toggle`, `transition`, `transition-choice`,
`record-toggle`, `stream-toggle`, `virtualcam-toggle` and `replay-save`.
See the [target validator](../src/domains/control-deck/obs-targets.js) for fields.
Visibility normally stores an exact scene/group/source instance. `scope:"all"`
with `sourceName` dynamically targets every matching scene/group instance;
mixed visibility toggles to shown everywhere, then hidden everywhere on the next
press. Audio and filters already affect a shared source across scenes. Targets
remain scoped to the original scene collection. No uncertain command is replayed
after reconnect. Never distribute an author's scene bindings or OBS password.

### Twitch clip setup

`POST /api/control-deck/integrations/twitch-clips/configure` saves chat clipping
preferences such as `chatEnabled` and `chatAccess`, plus a partial
`titleModeration` policy. Defaults:

```json
{"enabled":true,"mode":"mask","useDefaultList":true,"blockedWords":[],"allowedWords":[]}
```

`mode` is `mask` (fixed `****` replacement) or `reject`. Lists contain at most
128 literal whole words/phrases of 64 characters each; case is ignored, Unicode
compatibility forms are normalized, and allowed phrases override contained matches.
The default list covers English profanity and common disguises. Settings remain
local. `POST /api/control-deck/integrations/twitch-clips/preview` accepts
`{title,titleModeration?}` and returns `{accepted,title,matched,error?}` using the
draft policy without saving, creating a clip or consuming cooldown. Custom titles
are checked in Core for chat, buttons and capability consumers; reject mode returns
`twitch_clip_title_rejected`. An omitted/empty title uses Twitch's broadcast title.

Compatibility `authorize`
and `poll` routes remain, but the UI uses the main Twitch Connection permission
chooser. Grant only the selected features' OAuth scopes. A clip action remains
unavailable if its account/scope/live-broadcast requirements are missing.
The legacy Discord `/integrations/discord/bind` route is compatibility-only;
new generic key buttons do not need it.

## Music-to-Light operator API

These trusted operator routes retain capture/output permissions, current source
ownership, fixture leases, calibration and restoration. A contributed mod/panel
cannot grant itself audio capture or fixture output through them.

| Method/path                                                              | Purpose                                                                                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/music-to-light/operator`                                       | Current design, permissions, source/fixture selection and session status.                                                        |
| `GET /api/music-to-light/pipeline`                                       | Bounded analysis/render/output diagnostics.                                                                                      |
| `GET /api/music-to-light/catalog`                                        | Current profiles, baseline, palette/recipe choices and compatibility rules.                                                      |
| `GET /api/music-to-light/effects` / `library`                            | Saved effects / song automation library.                                                                                         |
| `POST /api/music-to-light/call`                                          | `{capability,method,payload}` using the controller contracts below.                                                              |
| `PUT /api/music-to-light/permissions`                                    | `{value:{capture,output}}`; explicit operator grants.                                                                            |
| `PUT /api/music-to-light/source` / `sources`                             | `{value:...}`; current source or remembered source slots.                                                                        |
| `PUT /api/music-to-light/fixtures` / `contrast`                          | `{value:...}`; validated fixture bindings or contrast settings.                                                                  |
| `POST /api/music-to-light/effects/save` / `policy` / `delete` / `rename` | Explicit saved-effect administration. Delete uses `{id}`.                                                                        |
| `POST /api/music-to-light/songs/save` / `delete` / `policy` / `review`   | Song automation library administration and submission review.                                                                    |
| `POST /api/music-to-light/rave/start`                                    | Explicit manual Rave request. `{ "untilStopped": true }` holds it until Stop / restore; omitting this retains configured timing. |

The [controller contract](../integrations/music-to-light/contracts/music-controller-v1.contracts.json)
contains every payload/response schema: `music.sources.v1/list`,
`music.session.v1/status|start|stop` and
`music.styles.v1/configure|export|calibrate`. Source selection uses discovered
identities, not copied PIDs from another PC. Preview does not send fixture output.
Calibration captures the selected source without changing playback volume.
Output permission and a compatible selected fixture remain required to start
real lights. `stop` releases owned output through restoration; do not replace it
with raw black frames or an independent adapter queue. Advanced library payloads
remain defined by the [controller owner](../src/domains/music-to-light)
and current first-party UI, not a separate stable external-client API.

## Network sharing

| Method/path                               | Behavior                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /api/network-sharing`                | Enabled/active state, port and current private IPv4 addresses; do not log or broadcast the address list.    |
| `PUT /api/network-sharing`                | `{enabled:boolean,port:1024..65535}`; explicitly open/close the private gateway.                            |
| `GET /api/network-sharing/qr.svg?url=...` | Local QR encoding of an active advertised LAN URL only. No external QR service.                             |
| `POST /api/network-sharing/firewall`      | Explicit Core-PC-only Windows setup, denied through a LAN Host. May request Windows administrator approval. |

The desktop/localhost listener remains loopback. Sharing accepts private IPv4
peers and validates the requested Host and browser Origin. The Windows rule is
limited to the installed runtime, Private profiles and `LocalSubnet`, with edge
traversal blocked. It grants no Public-profile inbound access. Outgoing optional
provider requests remain separately governed. Link/QR details stay hidden until
revealed, and hide again when the settings panel closes. Install in the same
folder across updates to reuse the program rule. Managed firewall policy or an
existing Block rule can still prevent access; setup does not override those rules.

## Optional feature contracts

Feature methods are supervised broker APIs, not automatically available mod
capabilities. Features must be installed, enabled and compatible, and their
provider/account permissions must be satisfied. Their full payload/response/event
schemas are published in the linked JSON files. Use these contracts instead of
scraping UI state or bypassing the existing queue/reward owners.

The [Song Request contracts](../features/song-request/contracts/song-request-v1.contracts.json)
cover these capabilities:

| Capability                                             | Methods                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `song.playlist.read.v1` / `song.playlist.admin.v1`     | `status` / `mutate`                                                                                     |
| `song.queue.read.v1` / `song.queue.submit.v1`          | `status` / `submit`, `undo`, `self`                                                                     |
| `song.queue.admin.v1`                                  | `moderate`, `configure`, `settle`                                                                       |
| `song.queue.events.v1`                                 | Event contracts in JSON                                                                                 |
| `song.playback.read.v1` / `song.playback.driver.v1`    | `status` / `pull`, `acknowledge`                                                                        |
| `song.playback.observe.v1` / `song.playback.events.v1` | `observe` / event contracts                                                                             |
| `song.observer.admin.v1`                               | `status`, `control`                                                                                     |
| `song.overlay.read.v1` / `song.overlay.admin.v1`       | `status`, `preset` / `configure`, `profile`                                                             |
| `song.overlay.events.v1`                               | Event contracts in JSON                                                                                 |
| `song.catalog.read.v1` / `song.catalog.admin.v1`       | `status` / `configure`, `clear`                                                                         |
| `song.tidal.experimental.v1`                           | `status`, `submit`, `handoff`, `monitor`, `enable`, `companion`, `catalog`, `review`, `flush`, `volume` |
| `song.playlist.transfer.v1`                            | `action`                                                                                                |
| `song.player.preferences.v1`                           | `status`, `select`                                                                                      |
| `song.soundcloud.player.v1`                            | `submit`, `start`, `release`, `import-start`, `import-append`, `import-save`, `submit-query`            |
| `song.spotify.player.v1`                               | `status`, `flush`, `monitor`, `submit`, `setup`, `control`, `lookup`, `review`                          |
| `song.chat.commands.v1`                                | `status`, `configure`, `query`                                                                          |
| `song.youtube.browser.v1`                              | `status`, `setup`, `control`, `review`, `moderate`, `flush`, `monitor`                                  |

The [Twitch Integration contracts](../features/twitch-integration/contracts/twitch-integration-v1.contracts.json)
cover:

| Capability                  | Methods                                             |
| --------------------------- | --------------------------------------------------- |
| `twitch.connection.read.v1` | `status`                                            |
| `twitch.oauth.admin.v1`     | `configure`, `clear`, `begin`, `poll`, `disconnect` |
| `twitch.monitor.admin.v1`   | `configure`                                         |
| `twitch.rewards.read.v1`    | `inspect`                                           |
| `twitch.rewards.admin.v1`   | `create`                                            |
| `twitch.redemptions.v1`     | `settle`, `review`, `reconcile`                     |
| `twitch.chat.send.v1`       | `send`                                              |
| `twitch.rewards.catalog.v1` | `list`                                              |

Do not bypass current player ownership, lease acknowledgements, exact recording
identities, managed-reward scope, cooldowns or redemption settlement. Experimental
capability names describe availability, not permission to enable a provider.
Native/UI controls and optional providers retain their own side-effect policies.

## Reference sources and diagnostics

- [Mod SDK and all shipped host capability APIs](MOD_API_REFERENCE.md).
- [Mod setup, runnable example and packaging](MOD_AUTHOR_GUIDE.md).
- [User workflows](USER_GUIDE.md) and [button customization](CONTROL_DECK.md).
- [Core HTTP implementation](../src/app/core) and
  [mod administration implementation](../src/capabilities/mod-platform/http/register-mod-platform.routes.js).
- [Request/response conformance tests](../test/core-client-api.http.test.js).

Log operation IDs, bounded error codes and timing. Keep account tokens, full
credentials, private addresses, user queues, device bindings, album/user artwork
and generated token-bearing widget output out of public bug reports and releases.
