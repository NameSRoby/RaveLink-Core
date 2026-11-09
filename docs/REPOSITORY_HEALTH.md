# Repository health review - 0.7.6b - 2026-11-09

This is a focused maintenance release for optional Song Request and Twitch workers.

## Changes

- Song Request 0.45.12 allows 256 MiB active RSS; Twitch Integration 0.12.10
  allows 192 MiB. These budgets cover the complete Node process. Sustained
  resource enforcement remains enabled. Third-party mod limits are unchanged.
- A valid request that expires in transit returns a retryable timeout instead of
  disconnecting the worker. Malformed requests still fail closed, and protocol
  failures retain their nonzero exit code.
- An app-wide alert identifies unexpected worker exits, startup failures and
  resource stops, with a Packages recovery link. It clears after recovery and
  also shows saved resource stops when the dashboard is first opened.

## Validation and publication

Focused worker, package and browser regressions passed, including expired-request
recovery for feature and mod workers, malformed-request rejection, memory policy
bounds, crash recovery and warnings after reopening the dashboard.

The release process separately checks maintained source, a clean sanitized source
snapshot, dependency audits, generated inventories, resource budgets, archive and
installer payload consistency, isolated startup and updater preservation. Hosted
repository health and all three CodeQL jobs must pass on the exact release commit
before publication.

Source uses an explicit publication inventory. Runtime data, account grants,
credentials, local machine bindings, personal media, logs and build caches are
excluded. Exact private-value comparisons and executable build-path scans passed.
Secret-scanner findings were reviewed: the OAuth application identifier is public
configuration, and the keyboard-binding strings are synthetic test values.

## Practical limits

Automated tests do not certify every external account, physical light or audio
driver. Increased memory headroom prevents premature resource stops; it does not
promise that every future crash or unbounded allocation is impossible. Windows
setup retains the offline prerequisites shipped in 0.7.6a. Existing local settings
and account sign-ins remain private and are preserved during upgrades.
