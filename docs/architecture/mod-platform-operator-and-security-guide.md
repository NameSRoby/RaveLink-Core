# Mod Platform Operator and Security Guide

## Startup Profiles

The normal desktop profile includes only reviewed bundled adapters. Enable the
optional Community mod platform in Setup for the watched inbox and third-party
management UI. A source checkout can start that explicit profile with:

```powershell
npm.cmd run start:mods
```

Use the strict core with no mod routes or filesystem watcher:

```powershell
npm.cmd run start:core
```

The host defaults to `127.0.0.1`, four active mod processes, a root `mod/` inbox, and private `runtime/mods/` installed packages, approvals, rollback, and data. Core-only startup does not discover mods, create mod directories, start a monitor, or expose the mod API/tab.

## Operator Flow

1. Place a locally obtained `.zip` or unpacked package folder directly under `mod/`.
2. Review publisher, version, license, exact fingerprint, permissions, resource requests, and approval changes in the Mods tab.
3. Confirm approval and execution; RaveLink copies the verified package to private runtime storage before starting it.
4. Disable before update, rollback, or uninstall.
5. Uninstall retains mod data by default. Data deletion must be a separate explicit choice through the API.

Package uploads are capped at 16 MiB compressed and 32 MiB expanded. Installation rejects traversal, links, special files, path collisions, high compression ratios, undeclared files, and SHA-256 mismatches. Upload staging files are private and removed after each attempt.

Filesystem detection is event-driven with a short debounce and never evaluates package entry code. Removing a source from `mod/` removes it from the inbox but does not uninstall its private installed copy. A changed package requires fresh review even when it reuses the same version string.

## Administration Boundary

All `/api/mod-platform` and `/mods-ui` routes require local operator admission.
Browser requests must also have an Origin matching the request Host, preventing a
cross-origin site from administering localhost. Origin-less local CLI requests
remain supported. Explicitly enabled full-control LAN devices are trusted
operators through Core's gateway; do not share that network access with
untrusted clients. The bundled-only profile rejects community mutations.

Installed mods never run in the core process. They remain disabled until approved, execute in supervised child processes, communicate through bounded IPC, and may use only declared broker capabilities. The host caps active processes and samples all active PIDs in one coarse resource pass.

Node on Windows currently cannot enforce network denial. Running a mod therefore requires a second reduced-isolation confirmation. This is meaningful residual risk: only run code from a trusted publisher. Package integrity, filesystem restrictions, broker permissions, process supervision, and resource ceilings do not turn the host into a malware sandbox.

## UI Contributions

A mod may declare at most four single-file HTML panels. Every panel requires `permissions.ui`, must be listed in package integrity, is reverified before delivery, and is limited to 256 KiB. Panels load only when opened in an opaque-origin sandbox.

The contribution CSP denies network access, forms, objects, base URL changes, and external assets. A panel cannot inject into the core DOM or directly invoke server APIs. Future interactive bridges must use explicit versioned broker messages rather than widening frame permissions.

## Threat Model

| Risk | Current control | Residual risk / release rule |
| --- | --- | --- |
| Package supply chain | Complete SHA-256 inventory, bounded verified staging, explicit local install and approval | Hashes prove package consistency, not publisher identity. Treat publisher as self-asserted until signed packages and a trust store exist. |
| Credential abuse | Opaque operation-only handles, declared permission, redacted audit | An approved operation can still affect the external account. Keep handles narrowly scoped and revocable. |
| SSRF and DNS rebinding | Exact public host allowlist, address policy, bounded transport | Re-resolve and reject non-public destinations for every new connection; never add wildcard/local host permissions. |
| Archive extraction | Preflight limits, portable paths, no links/special files, measured streaming limits | New archive formats require an equivalent adversarial fixture set before support. |
| IPC flooding | Frame, queue, concurrency, timeout, invalid-message, and quarantine limits | Run sustained multi-mod soak tests on each release runtime. |
| UI injection | Integrity check, sandboxed opaque origin, restrictive CSP, no broker bridge | Do not add `allow-same-origin`, navigation, forms, or direct API credentials. |
| Localhost CSRF | Loopback plus same-Origin/Host check on every administration and panel route | Keep external widget intake on separate scoped-token routes. |
| Resource exhaustion | Process cap, declared ceilings, coarse batched sampling, sustained-breach shutdown | OS-level RSS/CPU enforcement remains observational on Windows; retain conservative process limits. |

## Recovery

- Activation failure: the mod stays disabled; inspect its reported lifecycle/error and approval state.
- Repeated crash or malformed IPC: the supervisor quarantines only that mod. Disable it, update or uninstall it, then explicitly retry.
- Bad update: disable the mod and use rollback. One prior verified package is retained.
- Corrupt package: activation and UI delivery fail integrity verification. Reinstall a trusted package; core availability is unaffected.
- Corrupt mod data: uninstall while retaining data, back up `runtime/mods/data/<mod-id>`, then explicitly delete only that mod's data before reinstalling.
- Hung shutdown: the supervisor applies the manifest grace period and forcibly terminates the child. The core-plus-mods entrypoint drains the registry before closing HTTP.

## Release Checks

Run:

```powershell
npm.cmd run verify:mod-platform-contracts
npm.cmd run verify:mod-sdk-publication
npm.cmd run verify
npm.cmd run verify:audit
```

Before release, also run a long-duration machine-specific soak with the intended Node version. Automated fixtures cover absence, incompatibility, startup, idle sampling, crashes, flooding, malformed IPC, timeouts, forced shutdown, package attacks, and isolated core operation; elapsed-time soak remains release execution rather than a unit-test substitute.
