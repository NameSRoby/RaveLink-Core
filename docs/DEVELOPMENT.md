# RaveLink Core developer guide

This guide describes the running application and the constraints a change must
preserve. Start with the relevant flow below, then read the module notes beside
the implementation. The installation instructions and feature list remain in
[README.md](../README.md). The maintenance findings are recorded in
[REPOSITORY_HEALTH.md](REPOSITORY_HEALTH.md).

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

Compatibility re-exports under the mod platform preserve older import paths while
delegating implementation to the shared supervisor. Keep those wrappers until
their callers and supported integration contract have been migrated together.
Do not identify dead files by filename frequency alone: manifests, HTML builders,
child-process entrypoints, and serialized browser functions are also entry paths.

## Startup and shutdown

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
