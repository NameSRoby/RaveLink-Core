# Repository health review - 0.7.6 - 2026-11-07

This release covers maintained Core services, Music-to-Light, overlay editing,
the Windows desktop bridge, customizable dashboard controls, OBS, status widgets,
bundled mods, optional feature packages and release assembly. RaveLink branding
and local-data paths are retained.

## Changes reviewed

- One Core-owned OBS connection, source-first action construction, exact scene
  collection/source matching, protected passwords and no uncertain command replay.
  OBS setup is visible on the Dashboard, with explicit one-click local import.
- Shared live button status, bounded provider reads and local widget clocks avoid
  polling multiplication across phones, tablets and desktop windows.
- Cold Windows helpers receive a bounded initialization allowance. After readiness,
  ordinary command deadlines stay short; queued or expired requests cannot send
  input after cancellation. Slow initialization and a helper that never becomes
  ready have separate regression cases.
- Fullscreen paging packs complete rows using measured space, shares slider docks
  with edit mode, and changes pages without a drag animation. Touch faders wait
  for movement in their own direction; screen swipes cannot send volume writes.
  Native mixer writes reuse their confirmed snapshot rather than immediately
  making another full read. Request-volume writes wait for actual macro completion.
- TIDAL mixer writes use its saved native volume rather than a temporary session
  override; the explicitly enabled bridge persists across Core restarts. Player
  polling cannot overwrite active adjustments, concurrent writes coalesce, and
  percentages support exact entry. Pointer release is observed even when swiping
  transfers capture from a fader to the pager.
- Request-mode changes read Twitch's saved mode, preserve command permissions
  and queue pause, and pause the managed paid song reward before enabling chat.
- Private shared image/video backdrops use one media surface clipped to button
  faces. Media stays in runtime, and video playback stops when hidden or removed.
- Feature capability dispatch uses a bounded outbound queue aligned with declared
  concurrency and deadlines. Dispatch happens once; uncertain writes are not replayed.
  This fixes command starvation during concurrent player background work.
- Fullscreen screen protection releases on exit/background and handles browser
  refusal without retry loops. HTTP LAN uses bundled silent compatibility media.
  Manual Rave / restore is an owner-confirmed toggle; only manual admission may
  retain an untimed capture lease. Viewer and automatic durations remain bounded.
- Now Playing automatically follows the available player; silent or absent sources
  withdraw stale observations and recover with bounded retries.
- Direct Windows mixer controls discover current devices and app sessions. Generic
  system/microphone targets follow the current defaults. Discord lifecycle control
  was removed; existing mute/deafen buttons migrate to native keyboard macros.
  The legacy accessibility adapter stays disabled by default, without status polling.
- The button icon catalog loads only when opened, works offline and saves bounded
  raster media through the normal private media store. Reusable artwork is generic.
- Light profiles use a fixture-selection inspector and contribute discovered bulb
  actions with fixture-derived LED previews. Preview colors follow shared/individual
  settings without copying device bindings into source. Custom backlights remain explicit.
- Viewer controls group advanced settings and readiness details. Command guides
  export Twitch panel Markdown or bounded Discord message parts as well as plain text.
- Timestamps capture press time against confirmed stream timing. Local marks do not
  create Twitch writes. Remote markers require explicit optional authorization.
- Optional account groups preserve existing grants and default choices. Read-only
  totals and user-triggered account mutations retain separate owners.
- Requester hash/role helpers were extracted without changing queue identities,
  replay policy or migrations. Release metadata uses 0.7.6 to preserve existing updater compatibility;
  package and Windows file versions remain valid.

## Publication boundary

Clip-title policy is enforced once in Core for chat, deck and mod callers.
Offline English filtering defaults to fixed `****` replacement, with bounded
literal custom word lists, allowed exceptions and rejection mode. Rejected titles
cannot create a job or consume cooldown, and draft previews cannot save settings
or create clips. Legacy clipping preferences adopt safe defaults without losing
chat choices. Private word lists remain outside publication.

The source tree is assembled from an explicit inventory. Downloads contain only
consumer runtime material, production dependencies, licenses and selected online
feature installers. Runtime preferences, personal scene buttons, OBS bindings,
account grants, credentials, clips, timestamps, captures, exports, logs, screenshots
of the operator workspace and development tools are excluded. Tests use synthetic
fixtures and belong in the source checkout, not the installed application. Generic
button artwork and its upstream notices may be redistributed.

## Validation

| Check                            | Result                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maintained regression suite      | 1,059 passed; no failures                                                                                                                                                       |
| Sanitized-source acceptance      | 1,176 passed, five optional skips; 21 targeted acceptance checks also passed                                                                                                    |
| Music domain / native Rust       | 273 passed with five optional skips / 19 passed                                                                                                                                 |
| Production-path simulations      | 2,400 cases, 124,032 frames; no invalid-output failures                                                                                                                         |
| Dependency audit                 | Zero production or development vulnerabilities                                                                                                                                  |
| Source health                    | Formatting, lint, imports, generated assets, package inventories and structural budgets passed                                                                                  |
| Resource budgets                 | All four profiles passed absolute and applicable baseline gates; active Core RSS 77.7-83.2 MiB, startup 305-1,559 ms and shutdown below 83 ms in the measured run               |
| Artifact privacy and consistency | Installer and both ZIPs contain the same 4,418 application files; private credential values were checked against candidate contents without printing them                       |
| Offline install and source setup | Standard ZIP, self-contained ZIP, extracted installer and source bootstrap passed; native helper ABI, all profiles, bundled mods, LAN controls and restart persistence verified |
| Upgrade and rollback             | Real updater Apply/Rollback in an isolated NoLaunch fixture preserved layout, media and clip preferences                                                                        |
| Local CodeQL                     | Actions: zero findings; C#: zero findings across all five production C# sources; JavaScript: three reviewed OBS protocol/test warnings described below                          |
| Hosted checks                    | Full Windows regression, source health and three-language CodeQL are required before release publication                                                                        |

The local CodeQL password-hash rule flags the OBS 5 challenge-response exchange
in obs-client and its two independent protocol fixtures. OBS requires
SHA-256 plus its supplied salt and per-connection challenge; these hashes are
transient authentication messages, not stored password hashes. The saved OBS
password uses Windows user protection (DPAPI). The fixtures use synthetic values.
See the [OBS authentication protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md#authentication).
These protocol-specific findings are reviewed separately from password-storage
issues. The default security query suites remain enabled.

The C# analysis build includes the Core Audio helper normally compiled by
PowerShell, as well as the four desktop-host sources. Private SARIF, test logs,
source fingerprints and capture data remain outside the published tree. Test
totals overlap across suites and must not be added as a combined test count.

## Practical limits

Local tests and protocol fixtures do not establish compatibility with every
Windows audio driver or future OBS build. Keyboard macros send host PC input
without claiming to know the receiving application's state. OBS requires its WebSocket server to be enabled. Network
controls run on the Windows PC hosting Core; account connections and bindings
are configured separately on each installation. Twitch writes require a valid
grant and eligible live broadcast. Experimental adaptive lighting cadence stays
separate from the accepted steady-rate baseline.
