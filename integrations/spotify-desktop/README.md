# Spotify player integration

One Spotify player combines two optional connections:

- **Desktop companion:** target support for Spotify Free through a minimal RaveLink companion, using a reduced Spicetify-derived native hook. The full Spicetify CLI, marketplace, themes and extension runtime are not required by the generated bundle. No developer client ID or token extraction is required by the companion. Artist/title search and native queue insertion while paused were verified locally on Store Spotify 1.3.5.3058. Broader account compatibility and playback restrictions still need validation.
- **Official API:** optional Spotify Premium playback control with OAuth PKCE. Premium is Spotify's subscription, not a RaveLink fee. Spotify app allowlisting/quota restrictions also apply. No queue-removal endpoint is assumed.

The Spotify Desktop companion is connected to Song Request Playback, Setup and Moderation through `provider.cjs` and a paired loopback transport. They make no calls merely by being imported. The desktop adapter requires an explicit local-device verification function before queue writes; the official adapter requires an access-token supplier and chosen device. The desktop path now owns a persisted request/UID journal and a ten-upcoming-request window. `playback-provider.cjs` combines both paths with optional host-only OAuth PKCE, DPAPI credential storage and Setup UI. Device identity must match before official controls are mixed with native queue ownership. Official-only fallback requires an explicitly selected active device. Entry-to-transport bindings are persisted before dispatch, preventing an uncertain write from being repeated through the other path. Both paths share ten upcoming request slots; queued official entries have no individual removal endpoint.

The shared catalog normalization and two queue transports have tests for bounded text lookup, FIFO command serialization, duplicate-song occurrence removal, unknown devices, unconfirmed delivery and rate-limit handling. Mock tests are not evidence of real Free-account support.

The minimal renderer is built with `node scripts/build-spotify-desktop.js`. It captures the private native player through one supported platform marker and exposes only read-only runtime status globally. The original native assignment still works if the renderer is absent. No broad Spicetify global, authentication proxy, UI framework or external service is included.

The `dist` bundle includes its editable linked sources, rebuild script, integrity inventory and LGPL component notices. The supported Setup flow stages a verified runtime sidecar without changing the original Spotify installation. The source hook rejects missing or ambiguous markers, already patched input and detected Spicetify modifications.

The separate `readiness-probe.js` is read-only and can be pasted into Spotify DevTools. It detects the minimal RaveLink runtime or reports capabilities of an existing Spicetify client. Its output does not certify playback readiness. Do not paste credentials or account tokens into it.

## Local client preparation

Use **Song Request > Player > Spotify > Setup > Prepare companion**. Fully quit Spotify, including its tray icon, then choose **Open Spotify with RaveLink**. Playback also shows this launch action while disconnected. A normal Spotify launch does not load the companion.

Setup discovers regular and Microsoft Store installations, validates the installed archive, renderer integrity and exact platform hook, then stages a sidecar under local runtime storage. Newer clients keep JavaScript in a V8 snapshot; the source is parsed in memory without executing it during preparation. Spotify-owned copied assets and extracted code remain in ignored runtime storage and must never be published.

The sidecar uses Spotify's `--app-directory` flag and leaves the original installation untouched. A hash inventory detects client changes; prepare and reopen after updates. Artist/title search, paused queue insertion and signed-in client launch have been tested locally. Broader client/account compatibility still needs validation.

## Paired command transport

`host-bridge.cjs` supplies an optional Express router with a per-instance pairing token, loopback peer restriction, narrow Spotify renderer origin and bounded search/append/remove messages. It starts no listener on import; the feature-enabled host mounts it under `/api/spotify/bridge` with narrow origin permission. `connection-worker.cjs` handles a single issued command at a time and retries a lost result acknowledgement without replaying its native action. An issued mutation that times out remains unconfirmed. The ledger is currently in memory; the host provider separately persists request ownership before dispatch, holds interrupted deliveries for review, checks native ConnectDevicesAPI locality and refills the ten-upcoming-request window from observations. Real account compatibility still requires live validation.

The renderer only connects when a trusted caller supplies explicit connection options. Unpaired developer bundles expose read-only readiness status. Setup injects only this installation's local connection configuration into the runtime sidecar; the public bundle never includes pairing tokens.

Validate isolated behavior with `node --test "test/spotify*.test.js"` and bundle reproducibility with `node scripts/build-spotify-desktop.js --check`.

Implementation evidence and the remaining live acceptance steps are in [the research report](../../docs/research/spotify-desktop-integration-2026-10-16.md).

Launch requests return immediately with an opening status; the paired bridge confirms connection separately. Pending launches are deduplicated, and later launch errors appear in status. Queue admission does not require a current song or a Play command. An idle native queue is treated as empty, and insertion uses the native command rather than the high-level helper that can silently ignore an absent playback context.

## Optional Premium connection

The companion remains the default; unconnected Free accounts make no official API calls. Expand Optional Spotify Premium connection in Setup, configure your own free developer app, register the displayed exact loopback callback URI and sign in. The app owner needs Spotify Premium; development mode permits five allowlisted users. No paid developer kit, client secret, streaming SDK or playlist/library scopes are used. The client ID is write-only in the UI; OAuth credentials are encrypted locally with Windows DPAPI. A public OAuth client ID cannot be kept secret in the authorization URL.

Choose the playback device explicitly. Matching device IDs allow native queue control plus official playback/volume controls. Device changes are blocked while requests remain active. Requests delivered by the official API keep that ownership even if the companion reconnects: bans/timeouts block future requests, but individual queued removal requires native companion ownership. Current-song skipping checks the current occurrence before acting.

Mocked OAuth, transport, scheduler and browser tests cover the combined flow, shared capacity, device mismatch, uncertain writes and moderation limits. Live Premium account testing remains outstanding. Spotify account, application allowlist and quota restrictions still apply; this is not an unrestricted public developer service. See [Spotify quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) and [queue API](https://developer.spotify.com/documentation/web-api/reference/add-to-queue).

## Playlist sources and community writes

The companion now exposes a narrow playlist command for Transfers. It uses native RootlistAPI/PlaylistAPI services to list visible library playlists and read ordered pages of 25 entries. Spotify playlist URLs are normalized to playlist URIs; no authenticated URL proxy, collaborator invitations or playback changes are exposed by this command. Unsupported clients or inaccessible playlists fail visibly. Repeated tracks and unavailable entry positions survive source loading. This path has fixture/paired-bridge/browser coverage; live playlist-source acceptance remains outstanding and requires the updated companion to be prepared and reopened.

Community rewards can create a uniquely named native playlist and append bounded batches through RootlistAPI/PlaylistAPI. RaveLink keeps a local backup and mutation journal, reads the account playlist back before confirming sync, and holds uncertain writes for review. Prepare/reopen the companion after updating. General Spotify transfer destinations are not exposed.
