# RaveLink Core user guide

Start with the [installation and feature overview](../README.md). This guide covers
detailed controls, provider limitations, upgrades and source setup.

- [Dashboard](#dashboard)
- [Desktop and local network access](#desktop-and-local-network-access)
- [Govee LAN compatibility](#govee-lan-compatibility)
- [Hue Entertainment setup](#hue-entertainment-setup)
- [Music controls, colors and Auto-Rave](#music-to-light)
- [Capture and older-version upgrades](#music-to-light-basics)
- [Players, packages and overlays](#optional-features)
- [Playlists and transfers](#playlists-and-transfers)
- [Updates, privacy and uninstall](#updates-privacy-and-uninstall)
- [Source and offline setup](#source-and-tests)
- [Community playlist reward](#community-playlist-reward)

## Desktop and local network access

Launch RaveLink Core to open the desktop workspace. The same UI stays available
at http://127.0.0.1:5050/ in your usual browser. Use **RaveLink > Open in browser**
to open it there. The window supports Reload, Back/Forward and F11 full screen.
Closing the window keeps Core in the tray; **RaveLink > Exit** stops it.

Select the **network icon** in the header to enable **Allow full controls on my private
network**. Save, then open one of the listed addresses on another device on the
same Wi-Fi or Ethernet network. Everyone on that private network who has the
address can use the controls. Changes reach the same Core instance and fixtures;
this does not replace localhost or the desktop app. On the Core PC, **Set up Windows
network access** prepares a reusable rule for this installed runtime. Windows may
ask for administrator approval once. Incoming access is restricted to the local
subnet on Private networks; no Public-network access is granted. Existing Block
rules and managed policies remain respected. Keep the same installation folder
across updates to reuse its rule. Disable sharing to close LAN connections.

Addresses and QR codes stay hidden until **Show link & QR code** is pressed, and
hide again when the panel closes. The address is a private LAN address rather
than your public internet address. Use fullscreen when sharing the control screen
on a broadcast, and avoid revealing connection details on stream.

Provider sign-ins requiring localhost callbacks must be completed on the Core PC.
The desktop viewer uses Microsoft Edge WebView2. Setup includes its full offline
installer and installs it if missing. Portable users can run the included installer
under `optional-components/prerequisites`. The browser view remains available.

## Dashboard

The Dashboard brings managed Channel Points, request intake, music lighting,
saved light profiles and installed-package shortcuts into one workspace. Reward
controls apply only to rewards created and managed by Core. Resuming rewards
keeps song rewards closed while their request intake is paused or unavailable.
The Overview's all-rewards button changes between pause and resume using the
current managed-reward state.

Choose **Edit dashboard** from the settings cog or the dashboard toolbar. The
searchable catalog groups sections and individual actions by purpose, with each
package requirement explained. Add or remove sections, use Move up / Move down
to order them, hide individual actions, and choose spacing and columns. Live
dashboard actions are disabled during the preview. **Save & finish editing**
keeps the layout locally across restarts; **Cancel editing** discards changes.

Choose **Button deck** beside Overview for a page of customizable controls. The
initial **Quick Access** page includes playback and volume, request moderation,
lights, rewards, Discord and Twitch clips. Add your own pages when needed; page
tabs appear when there is more than one page. Existing saved layouts are retained.
The **+** tile adds an existing app action or a function
from an enabled, approved mod. Use **Edit** to drag buttons into order, change their
behavior and appearance, or remove them; **Undo** restores the last layout change.
In Edit, drag anywhere on a button with mouse, touch or pen. The moving button
and insertion preview show the result before you drop it; dragging near an edge
scrolls long decks. Tap to edit. A keyboard can focus the move grip and use arrow
keys to move one position.
Pages and folders keep related controls together. Button editing does not run an
action. See the [button deck guide](CONTROL_DECK.md) for macros, images, animated
GIFs, color choices, keyboard keys, status widgets, OBS and clip authorization.

Open **Button settings > Style & presets** to style all buttons, the current page
or one selected button. Choose **Crimson glow**, **Ice blue**, **Warm amber**,
**Aurora color cycle** or **Backlight off**, or customize the backlight color,
brightness and steady/slow cycle effect. Cycles use three colors and a duration
from 1-30 seconds. **Keep current colors & effects** is selected when the panel
opens; changes are saved only with **Apply style**. Styles preserve actions,
pictures, animated GIFs and labels. The **Individual buttons** tab opens each
button's existing editor for its artwork, symbols, text and actions.

For rewards, choose individual managed-reward toggles, one all-rewards toggle,
or **Reward controls** to open a compact panel. Its **+** pins a reward to the
deck. For lights, save a command for one fixture or all lights, or add **Quick
light controls**. Its panel changes lights only with **Apply** or **Turn off**;
manual commands take over the selected lights from effects. **+ Add this setting
to deck** saves the chosen target, color and brightness without applying it.

Open **Layout** to choose 1-12 buttons per row independently for desktop, tablet
and phone. The default Square shape has 28px corners and a cranberry LED source
recessed beneath a separate clear acrylic face. Set **Backlight brightness** from
0-100% while editing a button;
its static or cycling color tints the light behind its face. **Master backlight**
in Layout adjusts all button backlights together. Zero turns the glow off while
the button remains usable. Adjust
spacing and corner radius from 0-32 px, labels from 70-150%,
choose square, wide or tall buttons, and show or hide status labels. Changes
preview immediately. Close without saving to discard them, use **Reset layout**
to preview defaults, or **Save layout** to keep them across devices. Dense rows
scroll horizontally so their controls remain usable.

Choose **Fullscreen** for the current page's buttons, enabled status widgets and
an Exit control. Widgets appear above the buttons by default; their settings let
you hide them in fullscreen. Use Exit or Escape to return. Native fullscreen is
requested when the platform supports and permits it. Otherwise, the deck fills
the available viewport; browser or desktop window chrome can remain visible.

Fullscreen also requests that the phone or tablet screen stay awake. The small
**Keep screen awake** toggle is on by default and lets you turn this off. Leaving fullscreen or switching
to another app releases it. HTTP LAN browsers use silent local playback as a
compatibility fallback; device support and battery-saving policies can override
it. An amber status dot means protection needs attention; turn the toggle off and
on to retry. Its tooltip explains the current state.
This does not change the Windows host's sleep settings.

## Govee LAN compatibility

In **Fixtures**, choose **Govee**, enable **LAN Control** for each compatible
light in Govee Home, then choose **Find Govee lights**. Keep the PC and lights on
the same network. You can also enter the device address manually. No Govee cloud
account key is required.

Music, Rave, viewer effects and profiles use whole-light controls. White color
temperature depends on the model and firmware. Segments, DreamView and Govee app
scenes are not exposed by this LAN connection. Stop restores reported power,
brightness and RGB or white state; it cannot recreate an app animation because
LAN status does not identify that scene. Govee music output is limited to eight
updates per second, so very short accents may look softer than Hue Entertainment.

Integration tests use synthetic fixtures over real loopback UDP. They verify
RaveLink behavior, not every physical model or firmware. Network isolation,
blocked UDP, or another controller using the fixed response port can prevent
discovery and status checks; see the compatibility notice in fixture setup.

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

## Music-to-Light

**Play** holds ten effect profiles, palettes and the preview. **Color-led audio** keeps
brightness tied to measured energy across the calibrated output range. Impacts
rise promptly; sustained sound keeps its level. **Audio attacks** advances colors
on measured rhythmic hits, with equal timing in quiet and loud passages.
**Create > Brightness smoothing** adjusts rise and fall
independently of color timing. **Smart random** chooses compatible colors and
assignments at each start. **Keep this look** saves the actual running selection,
including assigned palettes. Applying a look preserves calibration and output limits.

**Create** holds choreography, lead/ambient contrast, palette sharing, intro/outro,
advanced random rules and saved effects. Choose a starting profile, fine tune it,
then Preview and save the playing combination by name. Artistic changes apply at
the next start; brightness smoothing applies live. Controls that do not affect the
chosen choreography are disabled. Profile selection does not change calibration,
permissions, routes or brightness limits.

**Shuffle profiles when Rave starts** draws once for each manual, viewer or Auto-Rave
activation, visiting all ten profiles before repeating. Regular Start lights uses
the selected profile. Saved-effect playback takes priority over profile shuffle.
Choose **Profile colors** for the profile's matching palette, **Your colors** for
your retained custom palette, or **Fresh each start** to randomize colors independently.
Choosing a profile loads matching colors while keeping your custom colors available.

**Automation** holds Auto-Rave, saved songs, viewer approvals and Rave
timing. Enable Rave effects there before turning on song automation.
**Audio & lights** is the single place for source order, capture/output access,
fixture jobs, calibration and brightness limits. Calibration also has a shortcut
beside the preview. Detailed rendering controls and diagnostics are collapsed.

Save any song by artist/title or a supported track link. Each song can be enabled
or disabled and assigned a saved effect. Auto-Rave
is off by default. It requires your existing capture/output permissions and fresh
song metadata from the selected player's Song Request Now Playing source. For
desktop media sessions without track IDs, include artist and title as well as a
link. Capture checks Main, Fallback 1, then Fallback 2. An open app wins even
when silent or paused. Missing fullscreen capture continues to the next fallback
after the five-second selection window. Fullscreen/game capture does not identify
songs or trigger Auto-Rave. Running captures keep their source.

Light updates and the preview are capped at 12 per second. Unchanged targets hold
their state without spending the next physical output slot. Fresh audio can use
an available slot immediately, and short measured peaks survive between updates.
Brightness maps measured power between your fixed audio references; it does not
normalize quiet music into a loud passage. Quiet rhythmic hits keep the same color
timing as loud hits, including below the brightness floor. Palette rotation and
quiet-hit analysis remain independent of the former Expressive renderer.
Older saved looks cannot re-enable brightness pulses in Core.

Small native target changes accumulate against the last confirmed delivery.
Entertainment streams receive occasional refresh packets while held; other held
fixtures need no repeated writes. Diagnostics separates holds and refreshes from
confirmed deliveries. Adaptive cadence remains experimental; 12 Hz is a hard maximum.

Hue REST and WiZ transport limits still apply. Hue Entertainment retains the mapped
RGB rather than normalizing it through an xy round trip. Audio calibration and
brightness limits remain under operator control.
Hue connection setup retries a lost cookie handshake with bounded backoff.
The dashboard shows connection setup separately from waiting for audio.

**Lights > Viewer controls > Chat Rave** contains the autosaving **Allow viewers
to start Rave** toggle and readiness check. Viewers redeem the connected Change
my lights Channel Points reward with `rave` as input; `rave stop` ends it.
Dynamic commands must be enabled and routed to music lights. The panel links to
Music-to-Light > Audio & lights for audio access and sources; enabling Rave alone does not
grant capture or start lights. Song/look submissions keep their Library policy. Viewer-triggered
Rave also applies the operator's selected dim, off and steady background scene
fixtures, even when they are outside the dynamic-command route. Extra reactive
lights remain excluded. Background scene roles cannot be promoted by a saved
look; Stop restores them with the rest of the session.

Play's **Colors** offers **Fresh each start**: a fresh palette
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

Play's **Color temperature & separation** opens the **Color separation** slider for all reactive lights or a
selected subset, without delaying audio. At low percentages it separates colors
within the current palette. Above 35% it gradually introduces mild frequency
emphasis; above 65% it adds contrasting accents on the same measured attacks.
0% preserves the original response. Changes apply during playback without a
capture restart and are remembered with fixture settings and saved looks.
Dim, steady and off fixtures are excluded; brightness limits still apply.

**Brightness smoothing** starts at 35 ms normal rise and 100 ms fall. Distinct
rises can react as quickly as 20 ms, while smaller fluctuations retain their
smoothing. The audio reference and minimum/maximum controls define the available
brightness range; no separate intensity multiplier reserves headroom. Color changes
cannot restart or deepen this envelope. Beat color fades start at 80 ms and do
not slow in quieter passages. **Audio attacks** follows measured
transients; **By energy** follows calibrated loudness; **Frequency colors** follows
band balance; **Audio flow** advances with audible activity. Static color holds
its palette position. Color pace changes these color gestures independently of
brightness. Mixed fixture groups can use different color styles and palettes.

The audio reference remains fixed until you explicitly edit or calibrate it.
Ordinary preset, palette and smoothing edits preserve it, including edits from
another open window. Manual reference presets describe player output, not whether
a song is calm or intense. The [baseline and settings audit](MUSIC_TO_LIGHT_BASELINE.md)
lists active controls and retired compatibility settings.

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

Lights workspaces support keyboard navigation with Left/Right, Home and End. Music controls recover from interrupted startup requests without a page reload.

## Music-to-Light basics

- **Lights > Music-to-Light:** first-party Windows audio capture drives Hue, WiZ and compatible Govee LAN lights. Select an application or explicitly select an output device, choose lights and a look, then start Preview or Live. Capture starts only on request; raw audio is not recorded or sent to a service.
- **Color-led audio** and **Smart random** share the accepted brightness response. Choose coordinated color styles or mixed fixture groups, shared or independent palettes, optional opening/ending animations and saved looks. Random choices are made at activation; brightness timing, output limits and calibration stay under your control.
- Song-aware Rave timing and viewer lighting admission share fixture ownership with manual controls. Stop and manual takeover cancel the active program; normal shutdown attempts to restore the original light state. A process crash or power loss cannot guarantee restoration.
- Application selection is stored privately and resolved again after restarts. Capture fails visibly when the source is unavailable rather than switching to desktop audio.
- **Active fullscreen / borderless app** selects its source once when capture starts. Alt+Tab and minimization keep capture pinned to that app; use Stop and Start to select another app. An app that mutes its own background audio will still produce silence.
- Existing song requests, playlist transfers, chat commands and OBS overlays remain available through optional packages.

**Updating from 0.7.1d or earlier:** use the 0.7.6 installer, or stop Core and extract the complete portable archive into your installation folder. Earlier built-in updaters do not copy the new Music-to-Light components. Keep your local data, restart Core and refresh the dashboard. Check **Packages** for Song Request and Twitch Integration updates. The capture helper, Node runtime and production dependencies are bundled; end users do not need Rust or Node installed.

Music-to-Light process capture requires a supported Windows build (build 20348 or later; Windows 11 recommended). Protected content may be unavailable. Application capture includes its process tree; browser capture does not promise isolation of one tab. TIDAL capture and Hue/WiZ output have had limited hardware validation; automated coverage uses synthetic signals and fixtures. Compatible Govee LAN fixtures participate in Music-to-Light, Rave, chat effects and profiles using whole-light controls. Model and firmware determine white-temperature support and response speed. Stop restores reported power, brightness and RGB/white state; Govee app animations, DreamView and segments are not reported or recreated by the LAN API. Govee integration coverage uses simulated UDP fixtures; physical model compatibility is not certified by these tests.

Earlier changes are recorded in the [release history](https://github.com/NameSRoby/RaveLink-Core/releases).

## Lighting

- **Fixtures:** discover and pair Philips Hue and WiZ lights. Compatible Govee LAN models must offer LAN Control in their app. The fixture setup panel explains model-dependent features and restoration limits.
- **Lights:** direct colors, brightness, tunable white, reusable profiles, natural-language color commands and independently routed synchronized effects.
- **Light Commands:** copy viewer instructions generated from current routes.
- **Viewer Controls:** configure Channel Points routing, teaching feedback and dynamic commands together.
- **Room Layout:** enter physical positions; Wi-Fi cannot determine them automatically. Effect behavior is under **Viewer Controls**; routing diagnostics and protection are under **Light Commands**.
- **Widget:** generate an optional StreamElements widget for OAuth-free event intake.

### Light profiles and viewer controls

In **Lights > Light profiles**, choose **Create profile**, give it a name and use
**Add fixtures** to include lights. Select a fixture to reveal its power, RGB or
white-temperature setting and brightness. Switch fixtures without losing changes;
**Save profile** stores the look without applying it. **Apply saved profile** sends
the saved settings to its fixtures. Choose **Same settings for all** for a shared look.

Every saved profile appears under **Light profiles** in the button action library.
Its default button uses a bulb icon and the profile name. The acrylic backlight has
one colored LED per included fixture, based on its saved color, white temperature,
brightness and power. Editing the profile updates this default lighting. Choose a
custom backlight color or shared style to override it; **Use profile colors for the
backlight** restores the automatic appearance. Saving a profile never adds unwanted
buttons to your layout.

**Direct Control** keeps the target selector, color/brightness controls, quick
profiles and the always-visible **Test saved routing** section together. Routed
tests send real light commands; use **Viewer Controls > Test a command** for a
read-only routing preview.

**Viewer Controls** has a settings sidebar. In **Fixture groups**, select one group
and check its lights; selecting a light already in another group moves it in the
draft. **Save changes** applies routing and command options. **Animated effects**
has its own **Save effects** action and advanced timing limits. **Music & Rave**
saves its permission toggle immediately and uses your Music-to-Light source and
permissions. Teaching feedback and read-only command previews have their own sections.

In **Light Commands**, choose **Quick guide** or **Full reference**, then **Plain
text**, **Twitch panel** or **Discord**. Copy the displayed output. Twitch panel
formatting is for About panels; use plain text for chat commands. Long Discord
references split into message parts: copy one, then choose **Next message**.
Formatting changes the reference text only; it does not connect a Discord bot.
See the official [Twitch panel formatting guide](https://help.twitch.tv/s/article/markdown-basics)
and [Discord formatting guide](https://support.discord.com/hc/en-us/articles/210298617-Markdown-Text-101-Chat-Formatting-Bold-Italic-Underline).

## Optional features

Install, update, roll back or remove features in **Packages**. Hiding a tab changes navigation only; it does not stop or uninstall a feature.

**Twitch Integration** provides OAuth, EventSub, chat, managed Channel Points rewards, completion/refunds and optional chat responses. It works independently of Song Request.

In **Twitch Connection**, choose **Channel Points**, **Read chat commands**,
**Send chat replies**, **Moderator and VIP roles**, and **Create stream clips**.
Choose none for identity-only login. **Save choices** stores the next authorization
selection; **Start device login** or **Update Twitch access** opens the normal
Twitch device flow for those choices. Enter its code, authorize on Twitch, then
choose **I authorized - check**.

**Granted** badges reflect the current connection. A checked feature marked
**Needs authorization** is still unavailable until Twitch grants it. Unchecking a
feature does not revoke an existing grant. Reading chat enables commands; sending
replies is separate. Clip chat commands need reading chat, and posting their links
also needs sending replies. These scopes follow the [Twitch permission reference](https://dev.twitch.tv/docs/authentication/scopes/).
Update the Twitch Integration package to **0.12.6** for this chooser.

**Song Request** provides song-name parsing, FIFO requests, local playlists, quick song/requester bans and timeouts, artwork, playback details and customizable OBS overlays. Library Play, Shuffle and Pick Random start the correct player with one click. Player selection persists.

Frequent choices such as player, transfer grouping and overlay layout appear as visible option buttons. Saved lighting profiles use selectable cards; overlay profiles use a searchable list. Countries, timeout durations and detailed match candidates keep compact dropdowns.

The **Overlay designer** keeps an object list beside the canvas and places selection
controls on the right. Select a shape or information piece to move, resize, align,
rename or duplicate it. Shapes can also be hidden without deleting them. Use Zoom
for fine placement; measurements always refer to overlay pixels. On desktop, the
canvas stays visible while you scroll through longer settings.

**Undo / Redo** restore individual edits, including a whole drag as one step.
Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes, Ctrl+D duplicates, and Escape cancels
an active drag. Arrow keys move the selection 1 px; Shift moves it 10 px. Input
fields keep their normal text-editing shortcuts. **Discard draft** reloads the
latest saved design. Changes remain local until **Save overlay** publishes them
to OBS; the header shows whether you have unsaved edits.

- **TIDAL:** sign in with your own account for catalog lookup and reviewed account-playlist transfers. The bundled desktop companion delivers requests in FIFO order, preserving your playlist. Ten upcoming requests enter native TIDAL at a time; additional requests wait locally. Close TIDAL before updating the companion. Account tokens remain encrypted locally; no developer client secret is bundled.
- **SoundCloud:** public song-name search, links and playlist import require no developer credentials. Playback uses the visible official widget. Public search can break with site changes; availability, ads and preview limits remain controlled by SoundCloud. Direct SoundCloud account-library writes are unavailable.
- **YouTube:** lookup and official embeds. Uploader, age, region, account and content restrictions can prevent playback. Repeated failures and rapid skips can overload playback and may stop or crash the server. A prominent warning appears on the YouTube Player page. Stop playback if songs keep skipping. Media is not downloaded or restreamed to bypass restrictions.
- **Spotify:** Free accounts use the local desktop companion for requests and queue control. Optional Premium OAuth adds official search and playback controls; both connections cooperate on the same device. Prepare the companion, fully quit Spotify, then choose **Open Spotify with RaveLink**. Ten upcoming requests enter Spotify; extras wait in RaveLink. Unconfirmed deliveries are held for review. Spotify client updates may require preparing the companion again.

**Now Playing Sources** follows local YouTube/SoundCloud playback or Spotify, Apple Music and TIDAL Windows media sessions. Apple Music remains observation-only; Spotify also has a desktop companion for requests.

**Overlay Designer → Behavior** offers optional pause hiding (five seconds by default), stopped/loading hiding, provider-colored accents and remaining-time display. Test pause/resume in the preview, then save to apply. Classic, Album Card and Minimal remain available alongside compact Split Panels and other small presets.

**Mods:** drop a mod folder or ZIP directly into `mods`, then confirm **Activate** in the Mods page. Discovery is built into normal startup. Buttons appear in the deck action library, and HTML/CSS/JavaScript panels appear in Mods. Review the requested access before activating third-party code. The old `mod` folder remains recognized for existing installations.

**TTS, Alerts / TTS and Lighting Automation have been removed in 0.7.0.** No speech runtime or voice asset is shipped.

## Playlists and transfers

**Song Request → Playlists & Transfers → Transfer this playlist** opens Source → Destination or CSV → Check matches. Provider logos, confidence percentages, threshold shortcuts and weakest-first review simplify matching.

Load Spotify account playlists and YouTube, SoundCloud, TIDAL or Spotify playlist links. Match into YouTube, SoundCloud, TIDAL or Spotify, or import/export CSV. YouTube and SoundCloud destinations save matched IDs locally. TIDAL can create reviewed, verified unlisted account playlists; Spotify creates account playlists through its desktop companion. Liked-song transfers and direct YouTube/SoundCloud account writes remain planned; permissions alone do not enable them.

Capacity defaults to 5,000 tracks and can increase to 10,000. Original order and deliberate repeats are retained. Destinations can be organized into one playlist, fixed-size parts, artist, album or genre where metadata exists. CSV downloads keep a local copy under **Saved CSV exports**, with an **Open exports folder** shortcut.

## Updates, privacy and uninstall

Optional GitHub checks detect stable releases. Updates verify checksums, preserve local data and retain a rollback snapshot. Failed startup health checks can restore the previous version; Updates also offers manual rollback.

Core binds to loopback by default. Credentials, grants, playlists, exports, tab choices and logs are created locally and excluded from publication. Supported secrets are protected for the current Windows user. Network connections occur for services you use, including GitHub downloads and update checks, Twitch, Spotify, TIDAL, YouTube and SoundCloud.

Uninstall through Windows **Installed apps** or the Start menu; the uninstaller stops the tray host first.

### YouTube playback

Use the embedded YouTube player in **Song Request > Player**. An extension or
YouTube Music browser companion is not part of this release. Provider account,
region, advertising and embedding restrictions still apply. Repeated playback
errors pause automatic queue pulls; requests without confirmed playback remain
available for review instead of being silently advanced. Resume after resolving
the player error. Native rewards complete only after confirmed playback.

## Source and tests

Published source includes runtime code, first-party feature sources, licenses and relevant regression tests. Private state, logs, experiments and working archives are excluded.

**GitHub source ZIP or clone on Windows:** extract the entire folder into a
writable location, then double-click **Start-RaveLink.cmd**. On first launch it
downloads the pinned official Windows runtime, verifies its SHA-256
against the included manifest, checks production dependencies against the source
lockfile, and builds the tray launcher using Windows' included .NET Framework
compiler. It runs this checkout's source, including local edits. Later launches
reuse the local runtime. No administrator access or separate Node/Rust install
is needed. Setup copies only Node, production dependencies and the compiled audio
capture helper from the official release ZIP; application code runs from this
source folder. The exact archive and checksum are recorded in
[`scripts/source-runtime.json`](../scripts/source-runtime.json). The source and
runtime archive versions can differ; setup verifies their production dependencies
against the source lockfile.

Internet is needed for the initial runtime download and installing optional
packages. For offline source setup, download that exact standard ZIP on a
connected PC, copy it to the new PC, then run the following command from the
source folder (adjust the download path):

```powershell
$ravelinkRuntimeSpec = Get-Content scripts/source-runtime.json -Raw | ConvertFrom-Json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-source.ps1 -ReleaseArchive (Join-Path "C:\Downloads" $ravelinkRuntimeSpec.asset)
```

The self-contained ZIP is a separate ready-to-run download; it is not the archive
accepted by this source setup command. Optional package installation and online
services still require internet access.

Pair Hue bridges, discover lights and connect accounts on the new PC. Machine
settings and credentials are deliberately excluded from downloads. Optional
packages remain opt-in under **Packages**; their verified downloads are wired
into Core. Supported systems are Windows 10/11 x64; this is not a macOS/Linux
distribution.

**Development:** install Node 24 LTS and run `npm ci`, then `npm start`. Use
`npm run setup:windows` to prepare the bundled runtime and launcher without
starting Core. This checks the pinned release against your lockfile; after
changing production dependencies, use `npm ci` and build audio from source with
Rust 1.94.0 and the Visual C++ build tools via `npm run build:audio`. Build the
tray launcher with `npm run build:host`. Run `npm test`; browser tests also
require `npx playwright install chromium firefox`. The launcher path installs
production dependencies only; `npm ci` supplies development and test tools.

## Community playlist reward

In **Twitch Integration**, choose the **Add to playlist** reward type and create the reward with song text input enabled. Each accepted redemption uses the selected player, enters its normal moderated request queue, and is saved once to a **Community - [provider]** playlist under **Playlists & Transfers > Library**. Repeat contributions do not duplicate the saved song.

Spotify and TIDAL also sync the saved list to the connected music account. TIDAL needs playlist read/write access. For Spotify, prepare the updated companion, fully quit Spotify, and open it with RaveLink again; native playlist writes have automated coverage, with limited live validation. No Spotify Premium account or new OAuth app is required for the companion route. The Library shows pending, synced and uncertain-write states, with account links and explicit retry controls. Local copies remain available while the provider is offline.

For StreamElements widget mode, create the reward in Twitch and paste its ID into **Widget > Add to playlist reward ID**, then regenerate the widget. Widget mode forwards requests only; reward fulfillment/refunds remain manual. YouTube and SoundCloud keep their community playlists in RaveLink.

Spotify Premium setup requires a developer app whose owner has Premium and whose development allowlist includes the user. It uses OAuth PKCE without a client secret. Official-only queue entries cannot be removed individually; the desktop companion supplies that control for its own entries. Live Premium and native community-playlist validation remains limited.
