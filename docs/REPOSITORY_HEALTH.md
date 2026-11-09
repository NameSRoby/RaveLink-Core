# Repository health review - 0.7.6a - 2026-11-09

This maintenance release preserves RaveLink branding, local settings and the
accepted Music-to-Light brightness response. The review covers Core services,
Windows setup, mod discovery and UI, lighting parsing, consumer packages and
source publication. Test fixtures do not use the operator's accounts or devices.

## Fixes and cleanup

- Rave color lists parse complete names, taught names and descriptors; typo
  matching follows saved preferences. Invalid entries reject the request rather
  than silently discarding a color. Explicit requested palettes override saved
  profile/random/fixture palettes only on routed lights. Single-color output
  remains that color. Ember now has distinct crimson, gold, orange and violet.
- The full signed Microsoft WebView2 installer is pinned and bundled. Setup checks
  machine and user installations, installs offline only when needed, verifies the
  result and blocks launch on failure. Node and production dependencies are
  bundled; native audio uses a statically linked C runtime. Supported Windows
  builds already supply .NET Framework 4.8 and the imported system libraries.
- Selected Twitch and Song Request features install from verified local inventories.
  Active user feature copies and runtime data are never used as packaging inputs.
- Normal startup discovers the canonical mods folder and the legacy mod folder.
  Dropping code never executes it: activation reviews permissions and current
  package content. Separate content fingerprints detect changed same-version
  packages and reject content changed after review.
- Approved mods can discover validated first-party deck actions. The provider
  checks declared consumption, current availability, schemas and cancellation;
  it excludes recursive mod actions and navigation-only actions.
- Mod HTML panels can use declared local CSS/JavaScript and a scoped API relay.
  Opaque frame identity, per-open nonce, active approval, capability declarations,
  file integrity, bounded requests and cancellation are enforced. Direct host
  service objects and credentials are not exposed to worker or browser code.
- The unused Discord accessibility worker, provider, binding endpoint and
  UIAutomation implementation are removed. Keyboard macros and saved mute/deafen
  migration remain. The former combined startup file delegates to normal startup.
  Import, manifest, CLI and generated-builder references were checked before
  deletion; useful backend contracts and settings migrations are retained.
- Developer and mod guides now explain setup, package layout, permissions, lifecycle,
  API discovery, browser panels, testing, failure handling and offline dependencies.

## Publication boundary

Source is assembled from an explicit inventory and audited separately from
consumer packages. Only relevant source tests and synthetic fixtures are included.
Downloads contain runtime files, production dependencies, licenses, inactive
first-party feature packages and the vendor prerequisite. No tests or developer
build tools are installed with the app.

Private runtime state, machine bindings, account grants, credentials, personal
scene buttons, private media, captures, logs and local mod inbox contents are
excluded. The credential audit compares private values without printing them;
RaveLink executables are also checked for local build paths. Vendor bytes are
validated against their published build pin and Microsoft signature.

## Validation

- Maintained regression suite: **1,065 passed**, no failures or skips.
- Source health: formatting, lint, imports, structural budgets, generated payloads,
  SDK integrity and bundled package inventories passed. Dependency installation
  and the full audit reported zero vulnerabilities.
- Offline prerequisite tests compile and execute four isolated Inno fixtures:
  missing runtime, existing runtime, failed installation and tampered installer.
  They use a fake vendor executable and a separate test registry key.
- All four resource profiles passed absolute and applicable baseline budgets.
  Active Core RSS was 81.1-84.8 MiB, startup 281-1,332 ms and shutdown below
  93 ms in this measured run.
- Both ZIPs match 4,524 staged application files. The installer contains the
  same application payload, with the identical pinned vendor installer embedded
  separately for prerequisite execution. Portable, self-contained, extracted
  installer and source-bootstrap smoke checks passed native ABI, profiles, bundled
  mods, HTTP controls and restart persistence.
- Sanitized-source regression: **1,187 passed**, five optional skips, no failures.
  The separate clean install and source health checks also passed.
- Real updater Apply/Rollback in an isolated NoLaunch fixture preserved deck
  layout, media and clip preferences. Hosted health and CodeQL checks remain
  required on the exact candidate commit before publication.
- Local CodeQL completed for Actions, JavaScript and C#. Actions and C# have zero
  findings. JavaScript reports the three previously reviewed OBS protocol/test
  warnings described below; there are no new findings.

The password-hash rule flags OBS 5 challenge-response in obs-client and its two
independent fixtures. OBS requires SHA-256 with its salt and connection challenge;
these transient authentication messages are not password storage. Saved OBS
passwords use Windows user protection (DPAPI); fixture values are synthetic.
See the [OBS authentication protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md#authentication).
The default security query suites remain enabled. Hosted scans and open alerts
must be reviewed on the exact release commit before publication.

## Practical limits

Automated tests do not certify every physical light, audio driver or external
account. The full vendor runtime was verified and embedded, but the real shared
WebView2 installation was not removed from this working PC for testing. Online
account sign-in and external applications remain separate from offline app setup.
Mod activation explains the current Windows process-isolation limit. Keyboard
macros send input without inventing the receiving application's mute state.
Private SARIF, fingerprints and test logs remain outside the public tree.
