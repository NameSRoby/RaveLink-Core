# RaveLink Core

<img src="assets/RaveLink-Core.png" alt="RaveLink Core" width="96" height="96">

RaveLink Core is a local Windows app for streamer lighting, music requests and optional Twitch integration. It runs in the tray and opens at `http://127.0.0.1:5050`.

## New in 0.7.3

This release adds editable Auto-Rave songs, viewer Rave controls, Hue Entertainment setup, contrasting random colors, warm/cool band assignments and per-light visual contrast. It improves musical brightness and color movement, fallback selection, session restoration and navigation.

## Install 0.7.3

1. Download **RaveLink-Core-Windows-v0.7.3-setup-installer.exe** from the [latest release](https://github.com/NameSRoby/RaveLink-Core/releases/latest).
2. Choose an installation folder and optional features. Setup downloads and verifies only your selected features from this repository.
3. Choose **Main**, **More** or **Hidden** placement for tabs. Change this later from the settings gear → **Choose tabs**.
4. Launch from the Start menu or desktop shortcut. Use the tray icon to reopen, restart or exit.

Windows 10 or 11, 64-bit, is required. The Node.js runtime and production dependencies are bundled. The release is unsigned; SmartScreen may show an unknown-publisher warning. Verify downloads against `SHA256SUMS.txt`.

For portable use, extract **RaveLink-Core-Windows-v0.7.3-self-contained.zip** completely and run `RaveLink-Core.exe`. Both ZIPs contain the complete application and runtime. Install optional features later under **Packages**. Upgrades preserve local settings and feature data.

## Hue Entertainment setup

In **Fixtures**, edit a saved Hue light to discover Entertainment areas using its
stored bridge pairing. The editor lists area names and member lights, preselects
a single matching area, and also accepts a numeric group ID or a configuration
UUID manually. **Apply to matching saved lights on this bridge** configures the
other saved members of a discovered area together. Stop active effects on those
lights before saving Entertainment, then start
a new music lighting or Rave session. Finding and saving areas do not start streams.

Create areas in the Hue app first. If a streaming client key is missing, re-pair
with the bridge link button or enter your existing 32-character key. Stored keys
stay private and are never returned to the editor. An area in use by another app
must be released there before RaveLink can start its stream. Older saved fixtures
without a bridge ID resolve the bridge identity before HTTPS requests; certificate
chain and bridge-name verification stay enabled.

## Music-to-Light: Main and Library

The **Main** tab brings playback, Auto-Rave, looks, intensity, brightness movement,
color movement, smoothing, source order and light selection together. **Keep this
look** bookmarks the exact running combination. **Library** holds editable songs,
saved effects and optional viewer approvals; Advanced and Setup retain detailed
tuning and calibration.

Save any song by artist/title or a supported track link. Each song can be enabled
or disabled, assigned a saved effect and given an intensity override. Auto-Rave
is off by default. It requires your existing capture/output permissions and fresh
song metadata from the selected player's Song Request Now Playing source. For
desktop media sessions without track IDs, include artist and title as well as a
link. Capture checks Main, Fallback 1, then Fallback 2. An open app wins even
when silent or paused. Missing fullscreen capture continues to the next fallback
after the five-second selection window. Fullscreen/game capture does not identify
songs or trigger Auto-Rave. Running captures keep their source.

With the Expressive model enabled, every qualified spectral attack retains a
visible accent and color movement; stronger novelty permits deeper pulse accents.
Color also travels between attacks with measured energy and changing band balance.
Adaptive output keeps the requested render resolution while colors are moving:
render frequency controls smoothness, independently of artistic speed and intensity.
Hue REST and WiZ transport limits still apply. Hue Entertainment retains the mapped
RGB rather than normalizing it through an xy round trip. Audio calibration and
brightness limits remain under operator control.
Hue connection setup retries a lost cookie handshake with bounded backoff.
The dashboard shows connection setup separately from waiting for audio.

**Lights > Viewer controls > Chat Rave** contains the autosaving **Allow viewers
to start Rave** toggle and readiness check. Viewers redeem the connected Change
my lights Channel Points reward with `rave` as input; `rave stop` ends it.
Dynamic commands must be enabled and routed to music lights. The panel links to
Music-to-Light Setup for audio access and sources; enabling Rave alone does not
grant capture or start lights. Song/look submissions keep their Library policy. Viewer-triggered
Rave also applies the operator's selected dim, off and steady background scene
fixtures, even when they are outside the dynamic-command route. Extra reactive
lights remain excluded. Background scene roles cannot be promoted by a saved
look; Stop restores them with the rest of the session.

Main's **Color selection** offers **Random contrasting colors**: a fresh palette
of 3-7 colors at activation, with pairwise color separation, bounded lightness
and chroma, and both warm and cool stops. The draw stays locked during playback;
your custom colors remain saved. Keep this look saves the actual generated
palette so it can be replayed exactly. Custom palettes support 2-8 colors.

The **Warm bass / cool treble** toggle stays active across looks, saved effects,
random palettes and every color movement option. It assigns warm colors to bass-role
lights, cool colors to treble-role lights, and blended colors to midrange lights.
Overall lights follow the smoothed raw band balance. It uses the selected
palette; when a custom palette lacks a family, it uses the nearest available
color. Brightness and audio timing retain their existing behavior.

Main's **Out of sync** slider adds visual contrast to all reactive lights or a
selected subset, without delaying audio. At low percentages it separates colors
within the current palette. Above 35% it gradually introduces mild frequency
emphasis; above 65% it adds contrasting accents on the same measured attacks.
0% preserves the original response. Changes apply during playback without a
capture restart and are remembered with fixture settings and saved looks.
Dim, steady and off fixtures are excluded; brightness limits still apply.

Main's **Loudness foundation, pulse accents** brightness mode keeps sustained
brightness tied to musical loudness. Quiet passages fade down; missing drum
attacks do not dim a loud sustained passage. Color movement continues to follow
measured spectral attacks. **Pulse accents** sets ordinary pulse depth (10% by
default), and **Strong pulses** allows pronounced measured attacks to use a
larger depth (35%). At bright levels a pulse briefly dips and recovers; at lower
levels it rises. Direction is held for each hit, with no permanent headroom
subtracted from the foundation. Quiet audio still limits the accent. Rise and
release controls adjust the loudness envelope in this mode, without a second
output envelope. Expressive Mix uses this balance; full effect brightness and
steady brightness remain selectable. Steady level deliberately holds a fixed
brightness and suppresses brightness pulses and spatial dimming. Brightness-mode
changes apply immediately during locked recipes, without redrawing their colors. The loudness
foundation retains measured drum accents in Pulse, Band conversation and Swell
wash; it never removes them merely because another scenario was drawn.
Expressive palette travel and cycling follow measured audio energy, novelty and
onsets while preserving role offsets and the selected palette.

Automatic Rave ends with that song. Stop suppresses another automatic start for
the same playback; turning Auto-Rave off stops its automatic effect. Manual and
viewer Rave take priority. Per-song choices retain the current output limits.

The existing **Change my lights** Channel Points reward accepts:

- `rave save Name` to keep the active look, or `rave save` for a default name.
- `rave remember Artist - Song` or `rave remember https://…` to save any song.
- `rave remember` to save Now Playing; `rave stop` still stops Rave.

Viewer song/effect saves can be immediate, require approval or be disabled.
Submissions are bounded and rate limited; failed saves recommend a refund, and
native Twitch intake handles settlement. StreamElements mode retains manual
reward settlement. Libraries remain local and are excluded from publication.

Available in 0.7.3. Main keeps everyday controls together; Library provides links to songs, saved looks and viewer approvals. Lights workspaces support keyboard navigation with Left/Right, Home and End. Music controls recover from interrupted startup requests without a page reload.

## Music-to-Light basics

- **Lights > Music:** first-party Windows audio capture drives Hue and WiZ lights. Select an application or explicitly select an output device, choose lights and a look, then start Preview or Live. Capture starts only on request; raw audio is not recorded or sent to a service.
- **Expressive Mix** and Smooth Pulse offer reactive palettes, spatial patterns, independent fixture roles, optional opening/ending animations and saved effects. Random choices are made at activation; intensity, output pacing and calibration remain bounded.
- Song-aware Rave timing and viewer lighting admission share fixture ownership with manual controls. Stop and manual takeover cancel the active program; normal shutdown attempts to restore the original light state. A process crash or power loss cannot guarantee restoration.
- Application selection is stored privately and resolved again after restarts. Capture fails visibly when the source is unavailable rather than switching to desktop audio.
- **Active fullscreen / borderless app** selects its source once when capture starts. Alt+Tab and minimization keep capture pinned to that app; use Stop and Start to select another app. An app that mutes its own background audio will still produce silence.
- Existing song requests, playlist transfers, chat commands and OBS overlays remain available through optional packages.

**Updating from 0.7.1d or earlier:** use the 0.7.3 installer, or stop Core and extract the complete portable archive into your installation folder. Earlier built-in updaters do not copy the new Music-to-Light components. Keep your local data, restart Core and refresh the dashboard. Check **Packages** for Song Request and Twitch Integration updates. The capture helper, Node runtime and production dependencies are bundled; end users do not need Rust or Node installed.

Music-to-Light process capture requires a supported Windows build (build 20348 or later; Windows 11 recommended). Protected content may be unavailable. Application capture includes its process tree; browser capture does not promise isolation of one tab. TIDAL capture and Hue/WiZ output have had limited hardware validation; automated coverage uses synthetic signals and fixtures. Govee remains Alpha for direct control and is excluded from Music-to-Light restoration.

Earlier changes are recorded in the [release history](https://github.com/NameSRoby/RaveLink-Core/releases).

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
