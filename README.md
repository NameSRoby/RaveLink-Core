# RaveLink Core

<img src="assets/RaveLink-Core.png" alt="RaveLink Core" width="96" height="96">

RaveLink Core is a local Windows app for streamer lighting, music requests and optional Twitch integration. It runs in the tray and opens at `http://127.0.0.1:5050`.

## New in 0.7.2

- **Lights > Music:** first-party Windows audio capture drives Hue and WiZ lights. Select an application or explicitly select an output device, choose lights and a look, then start Preview or Live. Capture starts only on request; raw audio is not recorded or sent to a service.
- **Expressive Mix** and Smooth Pulse offer reactive palettes, spatial patterns, independent fixture roles, optional opening/ending animations and saved effects. Random choices are made at activation; intensity, output pacing and calibration remain bounded.
- Song-aware Rave timing and viewer lighting admission share fixture ownership with manual controls. Stop and manual takeover cancel the active program; normal shutdown attempts to restore the original light state. A process crash or power loss cannot guarantee restoration.
- Application selection is stored privately and resolved again after restarts. Capture fails visibly when the source is unavailable rather than switching to desktop audio.
- Existing song requests, playlist transfers, chat commands and OBS overlays remain available through optional packages.

**Updating from 0.7.1d or earlier:** use the 0.7.2 installer, or stop Core and extract the complete portable archive into your installation folder. Earlier built-in updaters do not copy the new Music-to-Light components. Keep your local data, restart Core and refresh the dashboard. Check **Packages** for Song Request and Twitch Integration updates. The capture helper, Node runtime and production dependencies are bundled; end users do not need Rust or Node installed.

Music-to-Light process capture requires a supported Windows build (build 20348 or later; Windows 11 recommended). Protected content may be unavailable. Application capture includes its process tree; browser capture does not promise isolation of one tab. TIDAL capture and Hue/WiZ output have had limited hardware validation; automated coverage uses synthetic signals and fixtures. Govee remains Alpha for direct control and is excluded from Music-to-Light restoration.

Earlier changes are recorded in the [release history](https://github.com/NameSRoby/RaveLink-Core/releases).

## Install 0.7.2

1. Download **RaveLink-Core-Windows-v0.7.2-setup-installer.exe** from the [latest release](https://github.com/NameSRoby/RaveLink-Core/releases/latest).
2. Choose an installation folder and optional features. Setup downloads and verifies only your selected features from this repository.
3. Choose **Main**, **More** or **Hidden** placement for tabs. Change this later from the settings gear → **Choose tabs**.
4. Launch from the Start menu or desktop shortcut. Use the tray icon to reopen, restart or exit.

Windows 10 or 11, 64-bit, is required. The Node.js runtime and production dependencies are bundled. The release is unsigned; SmartScreen may show an unknown-publisher warning. Verify downloads against `SHA256SUMS.txt`.

For portable use, extract **RaveLink-Core-Windows-v0.7.2-self-contained.zip** completely and run `RaveLink-Core.exe`. Both ZIPs contain the complete application and runtime. Install optional features later under **Packages**. Upgrades preserve local settings and feature data.

## Lighting

- **Fixtures:** discover and pair Philips Hue and WiZ lights. Compatible Govee LAN models are supported as **Alpha** and must offer LAN Control in their app.
- **Lights:** direct colors, brightness, tunable white, reusable profiles, natural-language color commands and independently routed synchronized effects.
- **Light Commands:** copy viewer instructions generated from current routes.
- **Viewer Controls:** configure Channel Points routing, teaching feedback and dynamic commands together.
- **Room Layout (Alpha)** and **Light Lab:** enter physical positions, inspect capabilities and tune effects. Wi-Fi cannot determine room positions automatically.
- **Widget:** generate an optional StreamElements widget for OAuth-free event intake.

## Optional features

Install, update, roll back or remove features in **Packages**. Hiding a tab changes navigation only; it does not stop or uninstall a feature.

**Twitch Integration** provides OAuth, EventSub, chat, managed Channel Points rewards, completion/refunds and optional chat responses. It works independently of Song Request.

**Song Request** provides song-name parsing, FIFO requests, local playlists, quick song/requester bans and timeouts, artwork, playback details and customizable OBS overlays. Library Play, Shuffle and Pick Random start the correct player with one click. Player selection persists.

Frequent choices such as player, transfer grouping and overlay layout appear as visible option buttons. Saved lighting and overlay profiles use searchable lists; countries, timeout durations and detailed match candidates keep compact dropdowns.

- **TIDAL:** sign in with your own account for catalog lookup and reviewed account-playlist transfers. The bundled desktop companion delivers requests in FIFO order, preserving your playlist. Ten upcoming requests enter native TIDAL at a time; additional requests wait locally. Close TIDAL before updating the companion. Account tokens remain encrypted locally; no developer client secret is bundled.
- **SoundCloud:** public song-name search, links and playlist import require no developer credentials. Playback uses the visible official widget. Public search can break with site changes; availability, ads and preview limits remain controlled by SoundCloud. Direct SoundCloud account-library writes are unavailable.
- **YouTube:** lookup and official embeds. Uploader, age, region, account and content restrictions can prevent playback. Repeated failures and rapid skips can overload playback and may stop or crash the server. A prominent warning appears on the YouTube Player page. Stop playback if songs keep skipping. Media is not downloaded or restreamed to bypass restrictions.
- **Spotify:** Free accounts use the local desktop companion for requests and queue control. Optional Premium OAuth adds official search and playback controls; both connections cooperate on the same device. Prepare the companion, fully quit Spotify, then choose **Open Spotify with RaveLink**. Ten upcoming requests enter Spotify; extras wait in RaveLink. Unconfirmed deliveries are held for review. Spotify client updates may require preparing the companion again.

**Now Playing Sources** follows local YouTube/SoundCloud playback or Spotify, Apple Music and TIDAL Windows media sessions. Apple Music remains observation-only; Spotify also has a desktop companion for requests.

**Overlay Designer → Behavior** offers optional pause hiding (five seconds by default), stopped/loading hiding, provider-colored accents and remaining-time display. Test pause/resume in the preview, then save to apply. Classic, Album Card and Minimal remain available alongside compact Split Panels and other small presets.

**Community mods** are optional supervised third-party code; enable them only if you intend to review and run community packages.

**TTS, Alerts / TTS and Lighting Automation have been removed in 0.7.0.** No speech runtime or voice asset is shipped.

## Playlists and transfers

**Song Request → Playlists & Transfers → Transfer this playlist** opens Source → Destination or CSV → Check matches. Provider logos, confidence percentages, threshold shortcuts and weakest-first review simplify matching.

Load Spotify account playlists and YouTube, SoundCloud, TIDAL or Spotify playlist links. Match into YouTube, SoundCloud, TIDAL or Spotify, or import/export CSV. YouTube and SoundCloud destinations save matched IDs locally. TIDAL can create reviewed, verified unlisted account playlists; Spotify creates account playlists through its desktop companion. Liked-song transfers and direct YouTube/SoundCloud account writes remain planned; permissions alone do not enable them.

Capacity defaults to 5,000 tracks and can increase to 10,000. Original order and deliberate repeats are retained. Destinations can be organized into one playlist, fixed-size parts, artist, album or genre where metadata exists. CSV downloads keep a local copy under **Saved CSV exports**, with an **Open exports folder** shortcut.

## Updates, privacy and uninstall

Optional GitHub checks detect stable releases. Updates verify checksums, preserve local data and retain a rollback snapshot. Failed startup health checks can restore the previous version; Updates also offers manual rollback.

Core binds to loopback by default. Credentials, grants, playlists, exports, tab choices and logs are created locally and excluded from publication. Supported secrets are protected for the current Windows user. Network connections occur for services you use, including GitHub downloads and update checks, Twitch, Spotify, TIDAL, YouTube and SoundCloud.

Uninstall through Windows **Installed apps** or the Start menu; the uninstaller stops the tray host first.

## Source and tests

Published source includes runtime code, first-party feature sources, licenses and relevant regression tests. Private state, logs, experiments and working archives are excluded. For source use, install a supported Node.js release, run `npm ci`, then `npm start`. Run `npm test`; browser tests also require `npx playwright install chromium`.

## Report a bug

Use the [GitHub bug report form](https://github.com/NameSRoby/RaveLink-Core/issues/new?template=bug_report.yml). Include your RaveLink version, affected feature, steps to reproduce, expected behavior and the actual error. Spotify and SoundCloud show a collapsed **Known issues & report a bug** panel on their Playback pages. Do not upload your runtime folder, tokens, credentials, pairing files or private account information; redact any screenshots or logs first.

## Community playlist reward

In **Twitch Integration**, choose the **Add to playlist** reward type and create the reward with song text input enabled. Each accepted redemption uses the selected player, enters its normal moderated request queue, and is saved once to a **Community - [provider]** playlist under **Playlists & Transfers > Library**. Repeat contributions do not duplicate the saved song.

Spotify and TIDAL also sync the saved list to the connected music account. TIDAL needs playlist read/write access. For Spotify, prepare the updated companion, fully quit Spotify, and open it with RaveLink again; native playlist writes have automated coverage, with limited live validation. No Spotify Premium account or new OAuth app is required for the companion route. The Library shows pending, synced and uncertain-write states, with account links and explicit retry controls. Local copies remain available while the provider is offline.

For StreamElements widget mode, create the reward in Twitch and paste its ID into **Widget > Add to playlist reward ID**, then regenerate the widget. Widget mode forwards requests only; reward fulfillment/refunds remain manual. YouTube and SoundCloud keep their community playlists in RaveLink.

Spotify Premium setup requires a developer app whose owner has Premium and whose development allowlist includes the user. It uses OAuth PKCE without a client secret. Official-only queue entries cannot be removed individually; the desktop companion supplies that control for its own entries. Live Premium and native community-playlist validation remains limited.

## Developer documentation

See the [developer guide](docs/DEVELOPMENT.md) for source ownership, runtime flows,
state and security boundaries, playlist-write recovery, and build/test commands.
The [repository health review](docs/REPOSITORY_HEALTH.md) records maintenance
findings and regression coverage. Run `npm run verify:health` before submitting
source changes; edit readable fragments and rebuild their checked-in payloads.

## License

Apache-2.0. Third-party code and provider marks retain their licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The [product direction and JavaFX preparation](docs/PRODUCT_DIRECTION.md) explains
retained workflows, shelved programs and the native-client delivery order.
