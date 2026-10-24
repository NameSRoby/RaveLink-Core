# RaveLink Core developer guide

This guide describes the running application and the constraints a change must
preserve. Start with the relevant flow below, then read the module notes beside
the implementation. The installation instructions and feature list remain in
[README.md](../README.md). The maintenance findings are recorded in
[REPOSITORY_HEALTH.md](REPOSITORY_HEALTH.md).

## Fixture output ownership

`src/domains/fixtures/fixture-output-runtime.js` composes the lease broker into
Core. Static commands, profiles, dynamic effects and taught-color previews all
share its fixture lanes. Core exposes governed adapter facades; keep raw state
writers private to composition. A server restart is needed to load source changes.
The fixture ownership tests record the implementation contract; hardware
acceptance remains separate from synthetic regression coverage.

Adapters must read actual state, report delivery/failure honestly and restore
native power/color modes. Each fixture's queue keeps an actual operation in
flight after a caller timeout; releasing it early permits a late frame to
overwrite restoration. Pending intents are replaceable and rechecked at
dispatch. Manual takeover invalidates tokens before entering this same lane.
Never add a second transport queue around the broker without verifying those
ordering guarantees. Governed Hue output defaults to fixture-scoped REST;
explicit Entertainment sessions require a server-owned area lifetime, reject
overlapping bridge claims and address only verified selected channels. Hue
HTTP 200 replies containing API errors or missing field acknowledgements count
as failures. WiZ UDP submission remains transport submission, not a bulb receipt.
Core disables delayed WiZ retransmissions so adapter timers cannot outlive frame
ownership. Native WiZ restoration retains off-bulb color/scene fields and measured
low brightness rather than applying the artistic minimum. Physical application
of those fields still needs device acceptance. Duplicate registry IDs resolving
to one physical bulb are blocked and counted in diagnostics, rather than getting
independent ownership lanes.

Temporary programs use native reads, including dynamic-only fixtures; command
caches do not supply baselines. Govee reads documented LAN status into RGB or
white native state; restoration writes latent state even when off and checks
the reported result, retrying one lost update. LAN status cannot identify or
recreate Govee app animations or segmented scenes. Effects and taught previews share Core's trusted
`core.effects` replacement namespace; external features must use bounded owner
admission and opaque tokens, not `replaceOwned`. Native-state changes, route-mode
changes and removal invalidate outstanding ownership. Shutdown closes admission,
restores through the same lanes, then closes transports. Hard process termination
cannot guarantee restoration.

`test/fixture-output-runtime.test.js` exercises composition with controlled device
adapters, including profile takeover during an in-flight frame, rapid replacement,
stale preview timers, native-mode restoration, transport changes, failed starts
and Hue area isolation. These are not physical hardware acceptance results.

## Source ownership and generated files

| Directory                             | Responsibility                                                           | Important boundary                                                        |
| ------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `src/app/core`                        | Compose the lighting server and register HTTP routes                     | Must work without features or mods                                        |
| `src/app/optional`                    | Explicit feature, mod, and combined startup profiles                     | Importing a shared helper must not activate an optional host              |
| `src/app/runtime`                     | HTTP lifecycle, request security, outbound admission                     | Own process-wide policy, not provider behavior                            |
| `src/domains`                         | Lighting, fixture configuration, colors, widget intake, updates          | Services own state; route handlers translate HTTP                         |
| `src/adapters/brands`                 | Hue, WiZ, and Govee transport details                                    | Hardware-specific protocols stay behind adapters                          |
| `src/capabilities/supervised-runtime` | Shared child-process and IPC machinery                                   | Enforce limits before dispatching workload data                           |
| `src/capabilities/feature-platform`   | First-party installation, UI relay, provider brokering                   | Features receive capabilities, not arbitrary host access                  |
| `src/capabilities/mod-platform`       | Separately reviewed third-party workload policy                          | Reuse the supervisor, retain distinct grants and approvals                |
| `src/shared`                          | Small cross-domain validation, storage, security, and package helpers    | Helpers must not start services as a side effect                          |
| `features/*/dist`                     | Authored, readable feature worker modules                                | Despite the name, these files are source and must be reviewed             |
| `features/*/ui`                       | Self-contained feature pages and readable UI fragments                   | Rebuild embedded copies after editing shared fragments                    |
| `public/core`                         | The HUD, feature navigation, lighting controls, shared browser transport | Browser ES modules and classic scripts have different load rules          |
| `integrations`                        | Spotify and TIDAL desktop companions and their host adapters             | Runtime code extracted from an installed client stays local               |
| `desktop/windows-host`                | WinForms tray host and Node process ownership                            | The host launches the server; it does not implement application policy    |
| `scripts`                             | Reproducible builds, installation helpers, and source checks             | Build scripts must fail on drift instead of silently retaining old output |
| `test`                                | Unit, HTTP, browser, companion, and updater regression tests             | Use temporary data and fake providers; never require a personal account   |

The Spotify and TIDAL `integrations/*/dist` trees are generated companion payloads.
Their readable sources and build scripts are retained for inspection and rebuilds.
The player, playlist, overlay editor, and OBS overlay HTML files contain generated
blocks because feature content runs in sandboxed frames. They are deliberately
self-contained. A byte-identical generated copy is not an independent module to
delete. The builders define the authoritative fragment order and verify the copies.

The overlay builder embeds `overlay-palette.js` before `overlay-renderer.js`, then
`designer-controls.js` before `designer-canvas.js` in the editor. Canvas geometry
uses overlay pixels, not preview pixels. Segment resize scales child frames and
their saved `contentScale` from a gesture snapshot; do not multiply the previous
pointer event's rounded frames. Size locks prevent direct size edits, ratio locks
preserve proportions, and container-only resizing deliberately retains children.
OBS consumes the same saved frames and content scales as the preview.

Preset layouts follow the familiar cover/title/artist/progress hierarchy seen in
[Amuse](https://docs.6klabs.com/docs/widgets/amuse) and
[LocalSpotifyWidget](https://github.com/BertHcoder/LocalSpotifyWidget). These are
layout references, not copied assets or implementation. Keep artwork unobscured,
reserve a separate box for countdown text beside the progress bar, and check long
track names at the preset's native dimensions rather than only gallery thumbnails.
Surface and accent effects must not change text contrast or displace information.
Server colors remain live; provider and cover accents override only the accent.
Cover sampling uses a bounded CORS probe and falls back to provider/theme colors
when pixel access fails. A late image must never recolor a later track. Color fade
is optional and respects reduced motion; it must not restart marquee animations.

Compatibility re-exports under the mod platform preserve older import paths while
delegating implementation to the shared supervisor. Keep those wrappers until
their callers and supported integration contract have been migrated together.
Do not identify dead files by filename frequency alone: manifests, HTML builders,
child-process entrypoints, and serialized browser functions are also entry paths.

## Startup and shutdown

The dashboard delegates quick actions to the existing music, fixture-profile,
Song Request and Twitch owners. Its reward route accepts managed purposes rather
than caller-supplied reward IDs, reports partial updates, and keeps song rewards
closed when intake cannot be verified open. Dashboard layout settings contain
validated identifiers from `src/domains/system/dashboard-catalog.json`; editing
previews presentation without invoking live controls. Keep new actions in that
catalog and cover owner admission and layout persistence in `test/dashboard.test.js`.

Each process entrypoint selects a profile and calls `start-core-server.js`.
`create-core-server.js` composes services and HTTP routes; the shared process
lifecycle handles listening, SIGINT, SIGTERM, host shutdown requests, and listen
errors. The lighting-only entrypoint never imports feature or mod extensions.

The lifecycle registry records an owner, an identifier, a type, and a stop hook
for bounded background work. It drains in reverse registration order so dependent
services stop before their dependencies. Concurrent shutdown requests share one
promise; a flag alone is insufficient while a stop hook is awaiting I/O. A failed
hook is reported and subsequent hooks still run. The process has a final deadline
because an external worker or socket can refuse to close.

A service that adds a watcher, timer, child process, stream, or network socket must
also define who closes it. Avoid module-level startup or recurring work just to
provide a status value. Importing a module should normally define behavior only.

## Request security and the feature UI relay

`request-security.middleware.js` distinguishes loopback/operator requests from
widget intake. Routes that change configuration must retain their intended local
origin policy and request budget. Widget tokens are not operator credentials.
Never weaken a failed intake request by retrying it through a less protected API.

A feature page has two layers: a same-origin parent shell and a sandboxed child
document. `feature-ui-relay.js` is an ordinary browser function serialized with
`toString()` into that shell. Its dependencies must be inside the function body;
a Node closure will not exist in the browser. Browser-only globals are expected
there even though the containing file is a CommonJS module.

The relay checks the message channel and exact sending window. Messages coming
from the HUD also check the host origin where that flow requires it. Sandboxed
documents can have an opaque `null` origin, so origin alone cannot authenticate a
child frame. Capability calls must belong to that page's declared allowlist;
the host still performs capability/contract checks after the HTTP request arrives.
Response identifiers allow the child to match concurrent calls to their promises.

Subscribe to the shared event transport and install message listeners before
assigning the iframe's `src`. Local pages can execute their first request before
the parent's next task. Reversing this ordering used to drop the initial refresh.
Capability-specific timeouts allow long provider/transfer work without making
ordinary display reads wait for the longest budget.

## Supervised workers, contracts, and packages

The generic process supervisor owns startup handshake deadlines, bounded queues,
request cancellation, crash tracking, protocol violations, and child termination.
Feature and mod adapters supply their own manifest validation and permissions.
Do not merge their trust policies merely because they share process mechanics.

IPC envelopes and data contracts are validated separately. The envelope bounds
the transport, deadline, identity, and message shape. A capability contract bounds
the particular method payload. Validate both before invoking a provider. A timeout
or cancellation does not prove an external write did not happen.

Package verification rejects unsafe paths, links, case collisions, oversized files,
oversized inventories, and unsupported manifest permissions. Every payload file
must have an exact SHA-256 entry and every declared entry must exist. The verifier
uses a set for inventory membership so missing-file checks do not become quadratic.
Remote downloads remain pinned to one immutable revision: a moving branch can mix
cached files from different versions and invalidate the package inventory.

## State, quotas, and secrets

`json-file-store.js` writes a new temporary file and renames it into place, with
an optional backup of the previous primary. Reading can recover from the backup.
Atomic replacement prevents a partially written primary; it is not a transaction
covering unrelated files. Services that update several records must define their
own recovery order and commit point.

`quota-json-storage.js` serializes mutations per workload so two writes cannot
both pass the same byte quota using stale usage. It validates the directory and
entries rather than trusting a permanent in-memory usage cache. Filesystem state
can change outside the process. Keep its link/path checks when optimizing I/O.

Third-party mods retain the 250-key ceiling. The first-party feature host allows
up to 8,192 small keys: 21 maximum-size library collections need up to 5,250 pages,
and a transfer can need another 2,000. The workload cannot raise this host policy
through its manifest. The 8 MiB maximum byte quota still applies, so these are
independent upper bounds, not a guarantee that every maximum-size object fits.
Five-row transfer pages keep matched-track metadata below the IPC frame budget;
do not increase page size from row count alone without measuring serialized bytes.
Extended first-party storage status returns at most 250 keys plus pagination
metadata. Pass an `offset` to inspect the remaining keys without exceeding IPC.

Windows DPAPI protects supported local secrets. OAuth tokens, bridge pairing
tokens, runtime exports, observed client files, logs, and machine paths never
belong in source packages, tests, documentation examples, or release assets.
Public OAuth client identifiers are identifiers, not embedded client secrets.

## Song requests, providers, and playback

The feature domain owns the request queue, requester restrictions, replay policy,
driver leases, and normalized playback state. Provider integrations resolve catalog
metadata and execute provider-specific operations through host capabilities.
Request acceptance, delivery to a desktop queue, and observed playback are distinct
events. Do not acknowledge playback simply because a provider accepted an append.

Portable tracks retain provider identity and occurrence identity. Two copies of
the same song can be intentional; deleting duplicates by title, URL, or provider
track ID changes playlist semantics. Occurrence IDs let moderation remove the
right queue entry. Cross-provider link resolution first resolves the source link's
metadata, then searches the chosen playback provider; it does not treat a foreign
provider URL as an untrusted free-text search string.

The Windows media observer accepts a selected application's snapshot and forwards
only bounded, normalized metadata and artwork. The title and thumbnail can arrive
at different times. Artwork identity must include the actual thumbnail content,
not only the title; also allow a corrected image for the same song. Provider/source
checks prevent another media application from overwriting the selected player.

Chat response policy belongs to the native feature, not the StreamElements widget.
The widget is a transport-only event forwarder. Deduplicate provider/event delivery
before emitting a response, and base success/error text on the actual acceptance
outcome. Missing playback controls must not turn an already accepted request into
a reported submission failure.

## Playlist transfers and uncertain writes

The transfer coordinator owns one durable job. Reading, matching, writing,
paused, canceled, review, complete, and uncertain states have different mutation
rules. Source selection and destination changes must obey those rules rather than
replace an in-progress job. Multi-playlist input keeps each source playlist's ID
and name; identical names do not mean identical playlists.

The batch reader persists its next source index before opening that source.
Restarting after a failed lookup must not append the previous playlist's final
page twice. Source cursors and row pages are persisted as the read advances.
The review UI retains stable original row indices even when sorting by confidence
or filtering to unmatched tracks. Copy only the displayed rows during ordinary
paging; cloning 10,000 rows for a five-row display adds avoidable allocation.

Matching compares title, artist, duration, recording edition, and ISRC where
available. A live/remix/cover mismatch must remain reviewable even with a strong
title match. Automatic selection respects the confidence threshold and preserves
manual choices. Provider backoff belongs to the provider response; repeated polling
must not bypass it by immediately launching a fallback search.

The writer persists `intent` before create/append. If the response disappears, the
remote operation may already have succeeded. Such a job becomes `uncertain` and
requires reconciliation; do not automatically replay a write. Read the destination
and compare the ordered occurrence list with the expected prefix. Spotify create
recovery can require an explicit destination link because inferring a newly created
playlist from its name is ambiguous. Completion requires verified destination data.

The UI offers separate destination playlists or a merged destination. Back/Continue
must preserve source selection and reviewed matches when still applicable. Select
all means all loaded playlists, not an unsupported claim about unseen account pages.

## Desktop companions

The Spotify companion captures the minimal native platform facade and connects
to the local host bridge with a pairing token, client identity, session, and leased
commands. The renderer deduplicates command IDs and retries dropped receipts rather
than re-executing writes. A timeout does not cancel the native operation. Read-only
search/playlist history can be evicted; uncertain write receipts must remain until
the bounded history is full, at which point the bridge refuses more work.

Both companions depend on external desktop-client internals. Their unit tests
exercise reviewed adapters and recorded shapes, not a guarantee that every future
Spotify/TIDAL release exposes those internals. Keep unsupported shapes explicit,
bounded, and reviewable. Never include locally extracted proprietary application
code in a rebuilt companion or release. Retain upstream licenses and notices.

## Lighting and dynamic effects

Fixture services own layouts, groups, profiles, and saved configuration. Brand
adapters implement network/device protocols. Hue Entertainment session keys include
bridge, credentials, and area so one broken stream does not contaminate a different
group. Treat session cleanup and optional dependency loading as transport concerns.

The Twitch light-effect service serializes ownership of an active dynamic program.
A newer redemption replaces the previous effect through its cancellation/drain
boundary. Checking a cancellation flag is insufficient if an earlier asynchronous
hardware write is still running. Preserve restoration behavior after completion
and shutdown, and do not let two timers independently own the same fixtures.

Capture a bulb's actual state before its first effect frame, including power and
the active color mode. Hue reads use the per-light state endpoint; WiZ reads use
`getPilot` and translate its `state` boolean to the adapter's `on` field. A bulb
excluded from the normal active route still needs its own baseline. Do not assume
that the last direct color command touched it. If a required physical baseline
cannot be read, leave that bulb unchanged and report the unavailable baseline.

Frames and restoration share one per-fixture transport queue. A return waits for
an in-flight frame and checks ownership again before writing. Preserve the first
baseline across rapid replacements and while an animated return is pending;
otherwise an intermediate effect color becomes the supposed previous state.
Static colors and profiles drain superseded frames before sending their writes.

Effects sample the current program time for every brand. Do not add a start lead,
per-fixture latency offsets or a future Hue target to compensate for a different
transport. Natural network/device latency is accepted. Spatial phase offsets and
chase gaps are intentional program behavior and remain independent of transport
latency. Legacy saved latency offsets are ignored. Effect behavior controls live
under Viewer Controls; read-only routing diagnostics, protection and presets live
under Light Commands, without a separate Light Lab workspace.

Twitch settlement is journaled separately from the lighting action. An interrupted
action is reviewed, never blindly replayed after restart. Persist the first decision
before sending fulfillment/cancellation, deduplicate in-flight operations, and require
inspection when the remote result is unknown. Confirmed entries can be retired;
unresolved entries must not be evicted to make room for new redemptions.

## Windows host and updates

The WinForms tray host owns a single-instance mutex, an exit event, the managed
Node process, and its Windows job object. The `v0.6` text in the mutex/event names
is a compatibility identifier: changing it per release would allow two versions
to compete for the same local server. Assembly/product versions are separate.

Update installation distinguishes managed application files from mutable user
state. Health confirmation and rollback must preserve features, credentials,
configuration, and runtime data. Do not infer a successful update from a process
existing; verify the expected healthy version. The C# CodeQL job builds the actual
`net48` WinForms project on Windows so framework symbols resolve during analysis.

Windows PowerShell helpers explicitly select their host's own standard module
directory. A Node process launched from PowerShell 7 can otherwise pass incompatible
module paths into `powershell.exe`, breaking JSON, encryption, and updater cmdlets.
Keep the helpers independent of parent-shell module configuration; see Microsoft's
[module-path inheritance documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath).

## Editing, rebuilding, and checking a change

Use Node 24 for the maintained checks. Install development dependencies with
`npm ci`; runtime-only installs can omit them. Browser tests need Playwright's
Chromium (`npx playwright install chromium`) and should use temporary state.

1. Edit authored modules and add a behavioral regression test for a changed rule.
2. Run `npm run format` and `npm run lint`.
3. Rebuild changed pages/companions with `npm run build:generated`.
4. Run `npm run verify:health` to check formatting, static imports/duplicates,
   generated bytes, and feature inventories without modifying them.
5. Run `npm test`; HTTP/browser tests cover composition and sandboxed pages.
6. Review the diff and retain licenses/notices. Keep runtime data outside Git.

The formatter expands JS/CSS/JSON and authored HTML consistently. Generated page
blocks are checked by their builders rather than a competing formatter. C#, the
Windows scripts, and browser-code template strings require language-aware review;
the JavaScript formatter cannot certify those languages. Existing large modules
are measured by tokens and branches, not physical line count: explanatory comments
and readable wrapping should not be penalized as extra implementation complexity.

Static checks detect unused local bindings, unreachable statements, malformed
imports, and whole-file token duplicates. They cannot prove that a dynamic
capability is unused, detect every similar algorithm, validate hardware behavior,
or replace a review of cancellation and recovery logic. Delete an exported path
only after checking its runtime registrations, manifests, builders, and tests.

## Simulated Govee LAN fixtures

Run `node --test test/govee-lan.adapter.test.js test/govee-lan.simulation.test.js test/govee-features.simulation.test.js`
for stateful RGB/RGBW peer simulations over real loopback UDP. The helper is
`test/support/govee-lan-simulator.cjs`. Automated tests remap the documented LAN
ports onto isolated ephemeral ports and intercept discovery destinations; they
never broadcast to physical lights. Device IDs and SKU labels are synthetic and
do not certify a particular model or firmware.

The scenarios cover discovery and deduplication, power, retained off-state,
brightness and RGB bounds, temperature, unsupported white on an RGB-only peer,
concurrent reads, malformed/oversized/wrong-source replies, offline/reconnect,
queue limits, shutdown, asynchronous socket failures, dry-run and a reproducible
128-command sweep. Feature simulations exercise the real adapter and shared
broker with profiles, viewer effects, Music-to-Light/Rave, dim/steady/off roles,
manual takeover and verified restoration. Govee LAN fixtures use a conservative
eight-frame-per-second music budget (three UDP commands per RGB frame), rather
than a Hue Entertainment stream. No app scenes, segments or cloud API are
invented by the simulator. Compatible LAN models are supported with an explicit
model/firmware notice; simulation does not certify physical hardware behavior.

For manual inspection in an isolated Core test installation, run
`node test/support/govee-lan-simulator.cjs --serve` and add its printed loopback
fixtures manually. This opt-in mode uses control port 4003 and response port 4002;
it must not share the receiver port with another test instance. Its discovery
listener stays on loopback rather than announcing fake devices on a real LAN.
Stop the simulator with Ctrl+C. Never copy simulated fixtures into release state.

## Native Music-to-Light controls

Music-to-Light lives under Lights and works in Core-only mode. The native
service starts no capture or output until explicitly granted and started.
Core's lifecycle drains its session before the shared fixture broker and
transports. No optional feature worker or package is needed.

Core-owned same-origin routes handle capture/output grants, exact source
selection and independent music fixture selection. Null/external origins are
denied. Session/styles/source DTOs remain versioned and schema validated for
future JavaFX parity; they carry no PCM, credentials or transport details.
Portable designs persist separately from private remembered app identity, grants
and fixture roles. Restoring preferences never starts capture. Each command
resolves fresh native process identity before using the selected app.

The native DOM region in index.html is built from music-to-light.html with
node scripts/build-music-to-light-ui.js. No iframe is mounted. The UI renders
actual mapped values and bounded history, plus the measured dBFS input level.
It pauses polling when the tab is hidden. Keep preset role/color defaults useful
and keep calibration explicit rather than normalizing each song automatically.
`music-pipeline.js` presents authoritative pipeline choices and duration;
`music-fixture-controls.js` edits reactive/theatre/steady/off roles. Neither helper
has audio or fixture-output authority. See the scenario architecture document for
shared capture leases, song-clock fallback and non-reactive scene restoration.

Run npm run test:music-probe and test/music-to-light.native.test.js. Browser and
lifecycle tests use synthetic capture and fixture states. Physical camera/audio
checks are operator-authorized, bounded, local-only experiments; never include
footage, source identities or native recovery state in a publication. Native
artifact provenance/license distribution and long listening/resource acceptance
remain release gates.

## Chat command permissions and player controls

The operator edits the shared policy under Song Request > Player > Moderation.
The song.chat.commands.v1 capability forwards only status/configure to the narrow
twitch.commands.host.v1 provider; replies contain only connection readiness and
the normalized command matrix. They never expose credentials or change reward
intake settings. The Twitch feature panel points to this editor.

Twitch badges and broadcaster identity establish command roles. The encrypted
monitor configuration stores a fixed command/role matrix; normalization drops
unknown keys and preserves explicit false grants. Broadcasters retain access.
The command's grant and its anyone's-song grant are independent: enabling remove
for viewers never grants access to other requesters' songs. Ownership uses the
same requester hash as queue admission and desktop handoff receipts.

The host router forwards bounded command arguments; the Song Request worker
selects the active player. Named removals match only eligible pending requests,
prefer exact titles, and reject ambiguous matches. Native requests may have left
the local queue, so include active handoff receipts and preserve occurrence IDs.
Skipping must guard the current UID against a song change during the round trip.
Repeated Twitch message IDs must not execute a second control operation.

Chat pause/resume controls playback. Operator intake pause/resume remains a
separate queue policy. Browser players consume a monotonic control revision;
Windows TIDAL playback uses an explicit provider-targeted WinRT operation, never
a global media-key toggle. The bounded helper is canceled during host shutdown.
Spotify uses its selected official/desktop transport. A running desktop renderer
must reload an updated companion before it can accept newly supported commands.
Logical volume is mapped through the user's configured output range and is saved
only after native acceptance. Do not test by changing real playback or posting
live Twitch messages; use fake providers, synthetic events and browser fixtures.

Native chat stays subscribed in StreamElements reward mode when authorized.
Reward subscriptions and delivery remain exclusive to the chosen reward intake
transport. This separation prevents changing reward transport from silently
turning off moderator commands or delivering a redemption twice.

Chat information queries use song.chat.commands.v1/query. The router binds !queue to the authenticated chatter ID and owns the single explicit reply; automatic outcome toggles do not silence requested information. The worker reads the selected provider and merges confirmed native queueOrder entry IDs with locally waiting requests, deduplicating occurrence IDs and excluding the current item. Native ordering comes from observed queue UIDs (or official Spotify queue occurrences), not handoff insertion order. Unconfirmed deliveries prevent exact-position claims. Public messages contain only bounded song metadata and positions; never serialize provider state, account details, requester hashes or IDs into chat. Query handlers must remain read-only.
