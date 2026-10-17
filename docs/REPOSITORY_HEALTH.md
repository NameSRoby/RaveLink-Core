# Repository health review — 2026-10-17

This review covers the maintained repository source, feature packages, browser UI,
desktop companions, Windows host, build scripts, and published regression tests.
Local installed features, machine state, vendor code, and generated companion
copies are excluded from authored-source cleanup. Generated copies are rebuilt
and checked against their source instead.

## Findings and changes

| Finding                                                                     | Change                                                                              | Evidence                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| Concurrent shutdown calls could run a live cleanup hook twice               | Share one registry drain promise and continue after failed hooks                    | `test/lifecycle-registry.test.js`              |
| Four process profiles duplicated listener/signal/exit handling              | One shared HTTP process lifecycle; profiles retain extension selection              | `test/start-core-server.test.js`               |
| A failed listener could leave background services alive                     | Drain services and exit with failure after a listen error                           | `test/start-core-server.test.js`               |
| Ordinary playlist review cloned every row before slicing five               | Copy only displayed rows; retain indices for filtered/sorted review                 | `test/playlist-transfer-review.test.js`        |
| First-party transfer/library pages shared a 250-key mod ceiling             | Bounded 8,192-key feature-host allowance; retain byte quota and mod policy          | `test/quota-json-storage.test.js`              |
| Package inventory validation repeatedly scanned actual file paths           | Index actual paths in a set                                                         | Existing package/integrity tests               |
| Twitch role subtraction repeatedly scanned moderator IDs                    | Index moderator IDs once; preserve moderator precedence                             | Existing Twitch API tests                      |
| The iframe relay was hidden in a long HTML string                           | Readable serialized browser function, named timeout policy, one navigation decision | Existing feature/browser regression tests      |
| Unused imports and a write-only DNS status flag obscured live behavior      | Remove verified unused bindings; retain actual DNS patch identity checks            | ESLint and existing service tests              |
| Shared UI builders could silently accept missing markers or stale fragments | Unique ordered marker validation, deterministic output, read-only check mode        | `test/embedded-assets.test.js`                 |
| Provider styling was stored as long script string literals                  | Readable `player-providers.css` with named sections and preserved cascade order     | Player/browser tests and generated-byte checks |
| Formatting and documentation were inconsistent                              | Pinned formatter/linter, source checks, module notes, developer guide               | `npm run verify:health`                        |

The review also consolidated Hue REST/Entertainment CA discovery, removed unused
inline overlay constants and a player identifier, and moved `yazl` from runtime
dependencies to development dependencies. Its only consumers are the development
mod packager and its tests. Hue resolver precedence has a focused regression test,
and the existing Hue adapter tests continue to cover fallback and transport cleanup.

## Verification and limitations

The function-level review also consolidated the OAuth loopback response guard,
mod/supervisor permission flag mechanics, CSV report-row policy, domain/overlay
normalization, and the identical fixture/transport numeric clamp. The mod adapter
explicitly retains its denial of native addons. Small helpers with different text,
default, trust, or standalone-bundle semantics were kept separate rather than
silently changing those contracts to make similar code look identical.

Four source assertions depended on minified whitespace; they now tolerate source
wrapping while retaining their checks. The readable Spotify renderer remains a
fixed six-module bundle and is now bounded at 48 KiB instead of 32 KiB, retaining
the checks that exclude the full client SDK and unrelated integrations.

The unmodified published baseline passed **330 tests**. The sanitized maintenance
source passed a **383-test full regression run**. The additional read-only
feature-byte, HTML parser, credential-attempt, and inherited-module-path regressions
passed separately; CI runs the combined **387 tests**.
Formatting, lint, inline-script lint, literal-import checks, generated-byte checks,
feature hashes, the publication privacy audit, production/development dependency
audits, third-party notices, and Windows host compilation also passed locally.
The static pass checked **358 JavaScript files, 514 local imports, and eight HTML
pages**, with no unresolved literal imports or duplicated whole implementations.
Parsed JavaScript was compared against the baseline to distinguish formatting
from the deliberately changed implementations.

The first hosted Windows run exposed a parent-shell dependency: PowerShell 7
module paths could reach Windows PowerShell grandchildren, causing encryption
failures and missing updater cmdlets. DPAPI, media observation, and updater helpers
now use their own host's standard modules. The regression suite explicitly
supplies an unusable inherited module path to exercise this recovery.

Security review also led to a proper HTML parser for inline-script extraction and
a standard request limiter before widget-token verification. The existing token
bucket continues to budget successful template generation separately.

An isolated 10,000-row review-page benchmark (1,000 calls) measured approximately
178 ms before and 0.8 ms after. This measures paging only, not an entire transfer
or UI refresh. A deterministic regression checks that ordinary paging reads only
the returned rows; aggregate job counters still scan the job once without creating
temporary selected/valid arrays.

All four server resource profiles passed their existing absolute budgets in a
short smoke benchmark with a two-second idle sample and 30 requests per workload:

| Profile        | Startup  | Shutdown | Idle RSS |
| -------------- | -------- | -------- | -------- |
| Core           | 248 ms   | 63 ms    | 69 MiB   |
| Idle mod host  | 260 ms   | 64 ms    | 73 MiB   |
| Active mod     | 355 ms   | 66 ms    | 74 MiB   |
| Active feature | 1,494 ms | 80 ms    | 87 MiB   |

These figures describe one local run, not a long-duration or physical-hardware
performance guarantee. The review does not claim that static analysis proves the
absence of all dead code or that fake-provider tests replace physical lights,
authenticated desktop-client sessions, or OBS capture acceptance.

The source audit resolves literal local imports and fingerprints full authored
JavaScript files while ignoring comments and whitespace. It deliberately excludes
rebuilt companion copies and tiny compatibility aliases. Similar functions with
different surrounding modules still require manual review. Capability, manifest,
HTML, and process entrypoints must be considered before removing an export.

The maintenance work does not change the release version or replace published
installers. Official feature downloads remain pinned to the previously verified
release revision until a separately prepared release updates that pin.
