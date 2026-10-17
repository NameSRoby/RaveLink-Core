# Product direction and JavaFX preparation

Reviewed 2026-10-17 against the 0.7.1b implementation and repository health work.
This is the current scope decision. Older dated designs describe history or
research; their unfinished checkboxes do not automatically become release work.

## What is worth completing

| Area | Decision | Reason and next useful outcome |
| --- | --- | --- |
| Hue, WiZ and Govee lighting | Keep and harden | This is Core's purpose. Verify cancellation, restoration, mixed-brand output and fixture recovery on hardware. Keep Govee's Alpha label until its acceptance warrants a change. |
| Fixtures, groups, profiles, color language | Keep | Reuse the server owners from every client. Add native contracts for discovery/pairing and profile administration before building those JavaFX screens. |
| StreamElements widget | Keep transport only | It remains a useful intake path. Chat policy and credentials stay with their optional owners; do not rebuild a second chatbot in the widget. |
| Song Request and OBS overlays | Keep and stabilize | Preserve moderation, requester attribution, layout editing, artwork updates and scrolling. Browser playback and OBS remain browser surfaces where required. |
| YouTube, Spotify, TIDAL and SoundCloud | Maintain existing paths | These are implemented workflows, not speculative roadmap entries. Preserve provider-specific limitations and degraded states. Desktop companions need compatibility checks when provider apps change. |
| Playlists and transfers | Complete current workflow quality | Keep Spotify import/export, reviewed matching, multi-selection, select-all, backtracking, separate/merged destination choices, cancellation and verified write outcomes. Do not equate a matched local collection with a provider account write. |
| Twitch Integration | Keep and harden | OAuth recovery, chat replies, reward ownership, duplicate suppression and settlement are existing product behavior. Prove reconnect/revocation and uncertain delivery on a real account. |
| Feature and mod infrastructure | Keep with separate trust boundaries | Installation, supervision, contracts, permissions and rollback are shared infrastructure. Native management is useful; arbitrary native mod panels are not required for the first client. |
| Updates, diagnostics and Windows supervision | Keep and reuse | JavaFX must use the same server/update owners. Preserve explicit stop, retained-data choices and recovery without Java. |
| Resource limits and tests | Continue targeted work | Fix measured owner/cache/deadline gaps. Short automated measurements do not replace overnight idle, outage and reconnect evidence. |

Provider support in this table describes source implementation. It does not
certify service terms, general API access, every account tier, live acceptance or
production containment. Keep those limitations visible rather than advertising
unsupported account operations. No new provider is needed to start JavaFX.

## Work to stop carrying as active development

| Area | Decision | Code and data treatment |
| --- | --- | --- |
| Clip Studio preview | Remove from the offered product | Remove the empty Projects package, contract, catalog entry, installer option and dedicated placeholder tests. Preserve the design notes. Existing installed packages and user data are not deleted by this source cleanup. |
| Clip analysis/rendering/models | Shelve | No decoder/model dependency, worker, native view, file access or processing contract until a separate product decision defines a useful first version and its cost. |
| Music-to-Light | Research only | Preserve the concept, but remove its automatic admission as the next major feature. First prove hardware cadence and a small metadata-only use case. No audio worker or UI scaffolding now. |
| MIDI, Rave Engine, general Automation, Setup Doctor, donation/speech services | Remain retired | Do not recreate their routes, packages, compatibility shims or repair backlog. Existing bounded effects, diagnostics and manual profiles retain their own owners. |
| External Luna plugin distribution and its operator page | Retire as superseded | The bundled TIDAL companion owns installation. Remove the old builder, launcher, assets, redundant adapter alias and legacy setup controls. Keep the authenticated bridge and existing capability IDs used by the current companion. |
| Extra providers, liked-song adapters, SoundCloud account writes/native Next Up, advanced animation/Hype/composite actions | Defer | They add backend and acceptance work without helping native-client feasibility. No speculative server stubs or JavaFX navigation entries. Keep implemented shared primitives that current workflows use. |
| Native third-party mod panel framework | Defer | First deliver native package management. Keep existing isolated browser contributions available through the recovery HUD; do not move untrusted code into the Java process. |

Shelved design notes are inexpensive and retain useful decisions. An empty
installable feature costs users setup time and adds catalog, packaging, tests and
UI obligations without providing the advertised outcome. That is why the preview
is removed while the design is retained.

## JavaFX is a client migration

Node remains authoritative for lighting, queues, credentials, OAuth, provider
adapters, supervision, persistence and updates. JavaFX owns presentation and
bounded client state. No server feature is rewritten in Java to make a screen
native. Closing a client must not stop a running server or interrupt playback.

There is no JavaFX application in the repository yet. `desktop/windows-host`
is the existing C# lifecycle shell. The first JavaFX deliverable is a measured
feasibility application, not a promise of full parity or a replacement launcher.
Choose and pin its toolchain in that implementation change; this review does not
claim a tested JDK/JavaFX combination.

The current Core client contract has 17 operations, defined in
`src/domains/system/core-client-contracts.js`: health; fixture list/edit/upsert/
delete/test; light apply; widget status/get/rebuild/clear-token; update status/
configure/check/download/apply/rollback. Negotiation advertises supported
operations and a server instance ID. It is not desktop authentication.

## Delivery order and exit criteria

1. **Finish scope and ownership cleanup.** Use this document as the current
   decision, keep the web HUD working, remove the preview and superseded setup
   paths, and pass package integrity, relevant regression and absence checks.
   Do not delete installed data or rotate the published feature pin as cleanup.
2. **Build a read-only feasibility client.** Generate/maintain typed models from
   the server schemas; implement negotiation, health, fixture listing and update
   status. Represent offline, incompatible, reconnecting and connected states
   separately. A changed server instance invalidates cached runtime state.
   Measure cold start, idle CPU/RSS, packaged runtime size and close/reconnect
   behavior against the web HUD. Establish pass/fail budgets before making the
   client the default. Stop or revise the approach if its cost is unjustified.
3. **Secure and complete the native contract slice.** Design per-install desktop
   channel authentication before enabling privileged native writes. Preserve
   browser origin/CSRF checks. Add versioned discovery/pairing, profiles/groups,
   settings/diagnostics and lifecycle contracts only when the next screen needs
   them. Specify event snapshots, bounds, reconnect and instance changes. The
   existing Core handshake does not promise a general Core SSE stream.
4. **Deliver native Core tasks.** Lights, fixtures, profiles, widget generation,
   diagnostics and update controls use the existing server owners. Mutations
   require explicit user intent; ambiguous timeouts do not trigger blind replay.
   Widget regeneration rotates a token. Clipboard access is explicit and secret
   material never enters preferences, logs or crash reports.
5. **Deliver native feature/mod management and optional views.** Keep first-party
   features distinct from untrusted mods. Add capability-discovered, lazy Song
   Request/Twitch views without provider logic in the shell. Preserve queue state
   and unsaved edits across navigation. Do not require a WebView to implement
   every screen, or rewrite the OBS renderer as a native control.
6. **Make a release decision from evidence.** Prove mixed-version negotiation,
   server-only operation, multiple clients, sleep/resume, server restart, clean
   non-admin install, upgrade/rollback and web recovery. Complete account and
   physical-light acceptance. Apply signing/containment requirements to the
   affected distribution; mocked tests do not satisfy those gates.

The read-only spike can proceed while connected account/hardware acceptance
continues. A known blocking defect in a current workflow still needs a fix; an
unimplemented future feature does not block the spike.

## Source ownership to preserve

- `src/app/core` composes Core and HTTP adapters; `src/domains` owns server
  behavior. Native routes delegate to those owners rather than copy them.
- `src/capabilities/feature-platform` owns feature supervision and brokered
  providers; `features/song-request` and `features/twitch-integration` remain
  optional source packages. An absent package cannot prevent Core startup.
- `integrations/spotify-desktop` and `integrations/tidal-desktop` own the working
  desktop companions. The `experimental` names in the TIDAL bridge/capability
  remain compatibility identifiers, not permission to revive the old installer.
- `public/core` remains the recovery HUD. Its relay, draft protection and event
  handling have active users; keep them until replacement and rollback are
  proven. Avoid a broad web redesign during native feasibility.
- Keep package integrity builders, relevant tests, notices and dependency
  ownership aligned with source removal. Do not remove a shared adapter because
  an old roadmap mentions it alongside a retired feature.

## How to keep this plan honest

Every new task should identify a retained user workflow, its server owner, the
smallest missing contract, a meaningful verification and any connected evidence
still needed. Mark implementation separately from live acceptance. Update the
scope table when decisions change instead of appending contradictory exceptions
to an old roadmap. Historical checklists remain evidence, not an active queue.

See [development ownership](DEVELOPMENT.md) and the
[repository health review](REPOSITORY_HEALTH.md) for implementation context.
