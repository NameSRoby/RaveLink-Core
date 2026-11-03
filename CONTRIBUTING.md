# Contributing to RaveLink Core

Thanks for helping improve RaveLink. Useful contributions include reproducible
bug reports, clearer setup instructions, fixture compatibility reports and
focused fixes. You do not need lights or a Twitch account to run most tests.

## Before you start

Check existing issues and describe larger changes in an issue before investing
in a broad rewrite. Explain the user workflow, current behavior and expected
result. For small fixes, a focused pull request is welcome.

For bug reports, include Core and affected package versions, your Windows build,
installer/portable/source setup, reproduction steps and relevant redacted errors.
Hardware reports should name the fixture model, firmware and connection method.
Separate simulated results from physical-device observations.

## Development setup

Use Windows 10/11 x64 and Node 24 LTS. Clone the repository into a writable folder,
open a terminal there and run:

```powershell
npm ci
npx playwright install chromium firefox
npm start
```

In Windows PowerShell, use `npm.cmd` or `npx.cmd` if execution policy blocks their
PowerShell wrappers. The dashboard normally opens at `http://127.0.0.1:5050`;
with `npm start`, open that address yourself. Stop the server with Ctrl+C.
Keep test state separate from your normal installation and avoid running two
servers on the same port.

### Native components

`npm ci` installs JavaScript dependencies; it does not build the native audio
helper or tray launcher. For a compatible, unchanged production lockfile,
`npm run setup:windows` prepares the pinned runtime and builds the launcher
without starting Core. It needs internet on first use; see
[offline source setup](docs/USER_GUIDE.md#source-and-tests) for the exact archive.
It checks runtime compatibility against the source lockfile.

After changing production dependencies, use `npm ci` rather than relying on an
older release's dependency bundle. To build audio capture from source, install
Rust 1.94.0 and the Visual C++ build tools, then run `npm run build:audio`.
Process capture requires Windows build 20348 or later. Build the tray launcher
with `npm run build:host`; this uses the Windows .NET Framework compiler.

## Find the right owner

| Area                                         | Location                                               |
| -------------------------------------------- | ------------------------------------------------------ |
| Core composition and lifecycle               | `src/app/core`, `src/app/optional`                     |
| Lighting, fixtures and application behavior  | `src/domains`                                          |
| Optional package supervision and permissions | `src/capabilities/feature-platform`                    |
| Song Request and Twitch packages             | `features/song-request`, `features/twitch-integration` |
| Dashboard and browser controls               | `public/core`                                          |
| Audio and desktop companions                 | `integrations`                                         |
| Regression tests and synthetic fixtures      | `test`, `integrations/music-to-light/test`             |

Read [DEVELOPMENT.md](docs/DEVELOPMENT.md) before changing fixture ownership,
restoration, credentials, Twitch settlement or provider queue recovery. Generated
bundles are checked in for distribution: edit their readable source fragments,
then rebuild them instead of editing only the generated copy.

## Check your change

Run the relevant behavioral tests while developing. Before submitting code, run:

```powershell
npm run build:generated
npm run verify:health
npm test
```

Use `npm run format` to fix formatting when needed. `verify:health` checks
formatting, lint, source structure and generated payloads. Rebuild generated
assets only when their inputs changed, and review the resulting diff.
Documentation-only changes need link, command and accuracy checks rather than
new application tests.

Tests should use temporary state, synthetic audio, simulated fixtures and mocked
providers. Do not make ordinary tests send real lighting commands or contact an
account. Native-capture tests may skip when the compiled helper is unavailable;
report skips and any untested hardware/account behavior honestly. Automated
coverage does not establish real-device compatibility.

## Pull requests

- Describe the concrete problem and the behavior after the change.
- Keep the diff focused, with relevant regression coverage for changed behavior.
- Include commands run, their results and any material limitations.
- Preserve licenses, third-party notices and generated-package integrity.
- Do not commit tokens, pairing keys, user IDs, private paths, real telemetry,
  installed package state, runtime folders, dependency folders or build output.
  Use fictional data in examples and screenshots.

For a suspected vulnerability, do not post credentials or exploit details in a
public issue. Use GitHub's private vulnerability reporting if offered under the
repository's Security tab; otherwise open a brief issue requesting a private
contact without including sensitive details.
