# RaveLink Core

<img src="assets/RaveLink-Core.png" alt="RaveLink Core" width="96" height="96">

RaveLink Core is a local Windows app for streamer lighting, music requests and optional Twitch integration. It runs in the tray and opens at `http://127.0.0.1:5050`.

## Install 0.7.0

1. Download **RaveLink-Core-Windows-v0.7.0-setup-installer.exe** from the [latest release](https://github.com/NameSRoby/RaveLink-Core/releases/latest).
2. Choose an installation folder and optional features. Setup downloads and verifies only your selected features from this repository.
3. Choose **Main**, **More** or **Hidden** placement for tabs. Change this later from the settings gear → **Choose tabs**.
4. Launch from the Start menu or desktop shortcut. Use the tray icon to reopen, restart or exit.

Windows 10 or 11, 64-bit, is required. Node.js and npm are bundled. The release is unsigned; SmartScreen may show an unknown-publisher warning. Verify downloads against `SHA256SUMS.txt`.

For portable use, extract **RaveLink-Core-Windows-v0.7.0-self-contained.zip** completely and run `RaveLink-Core.exe`. The normal ZIP includes the same app in a directory wrapper. Install optional features later under **Packages**. Upgrades preserve local settings and feature data.

## Lighting

- **Fixtures:** discover and pair Philips Hue and WiZ lights. Compatible Govee LAN models are supported as **Alpha** and must offer LAN Control in their app.
- **Lights:** direct colors, brightness, tunable white, reusable profiles, natural-language color commands and independently routed synchronized effects.
- **Light Commands:** copy viewer instructions generated from current routes.
- **Room Layout (Alpha)** and **Light Lab:** enter physical positions, inspect capabilities and tune effects. Wi-Fi cannot determine room positions automatically.
- **Widget:** generate an optional StreamElements widget for OAuth-free event intake.

## Optional features

Install, update, roll back or remove features in **Packages**. Hiding a tab changes navigation only; it does not stop or uninstall a feature.

**Twitch Integration** provides OAuth, EventSub, chat, managed Channel Points rewards, completion/refunds and optional chat responses. It works independently of Song Request.

**Song Request** provides song-name parsing, FIFO requests, server playlists, quick song/requester bans and timeouts, artwork, playback details and customizable OBS overlays. Library Play, Shuffle and Pick Random start the correct player with one click. Player selection persists.

- **TIDAL:** sign in with your own account for catalog lookup and reviewed account-playlist transfers. The bundled desktop companion delivers requests in FIFO order, preserving your playlist. Ten upcoming requests enter native TIDAL at a time; additional requests wait locally. Close TIDAL before updating the companion. Account tokens remain encrypted locally; no developer client secret is bundled.
- **SoundCloud (Alpha):** public song-name search, links and playlist import require no developer credentials. Playback uses the visible official widget. Public search can break with site changes; availability, ads and preview limits remain controlled by SoundCloud. Direct account-library writes are unavailable.
- **YouTube:** lookup and official embeds. Uploader, age, region, account and content restrictions can prevent playback. Repeated failures and rapid skips can overload playback and may stop or crash the server. A prominent warning appears on the YouTube Player page. Stop playback if songs keep skipping. Media is not downloaded or restreamed to bypass restrictions.

**Now Playing Sources** follows local YouTube/SoundCloud playback or Spotify, Apple Music and TIDAL Windows media sessions. Spotify and Apple Music remain observation-only.

**Clip Studio (Alpha)** is package infrastructure; video analysis, suggestions and export are not active. **Community mods** are optional supervised third-party code; enable them only if you intend to review and run community packages.

**TTS, Alerts / TTS and Lighting Automation have been removed in 0.7.0.** No speech runtime or voice asset is shipped.

## Playlists and transfers

**Song Request → Server Playlist → Transfer this playlist** opens Source → Destination or CSV → Check matches. Provider logos, confidence percentages, threshold shortcuts and weakest-first review simplify matching.

Transfer between YouTube, SoundCloud and TIDAL catalogs or import/export CSV. YouTube and SoundCloud destinations save matched IDs locally. TIDAL can create reviewed, verified unlisted account playlists. Liked-song transfers and direct YouTube/SoundCloud account writes remain planned; permissions alone do not enable them.

Capacity defaults to 5,000 tracks and can increase to 10,000. Original order and deliberate repeats are retained. Destinations can be organized into one playlist, fixed-size parts, artist, album or genre where metadata exists. CSV downloads keep a local copy under **Saved CSV exports**, with an **Open exports folder** shortcut.

## Updates, privacy and uninstall

Optional GitHub checks detect stable releases. Updates verify checksums, preserve local data and retain a rollback snapshot. Failed startup health checks can restore the previous version; Updates also offers manual rollback.

Core binds to loopback by default. Credentials, grants, playlists, exports, tab choices and logs are created locally and excluded from publication. Supported secrets are protected for the current Windows user. Network connections occur for services you use, including GitHub downloads and update checks, Twitch, TIDAL, YouTube and SoundCloud.

Uninstall through Windows **Installed apps** or the Start menu; the uninstaller stops the tray host first.

## Source and tests

Published source includes runtime code, first-party feature sources, licenses and relevant regression tests. Private state, logs, experiments and working archives are excluded. For source use, install a supported Node.js release, run `npm ci`, then `npm start`. Run `npm test`; browser tests also require `npx playwright install chromium`.

## License

Apache-2.0. Third-party code and provider marks retain their licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
