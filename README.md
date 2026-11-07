# RaveLink Core

<img src="assets/RaveLink-Core.png" alt="RaveLink Core" width="96" height="96">

RaveLink Core is a local Windows app that connects your music, lights and Twitch
chat. Control compatible Hue, WiZ and Govee LAN lights, react to music, and let
viewers request songs or change your lighting through Channel Points.

It opens in a dedicated Windows desktop window and remains available in your
browser at `http://127.0.0.1:5050`. Close the window to keep Core in the tray;
choose **RaveLink > Exit** to stop it. The **network icon** enables optional full
control from other devices on your private network. Scan its locally generated QR
code with your phone camera, or copy the access link. Choose the matching network
address if the computer has more than one network adapter.
Twitch and Song Request are optional packages;
local lighting works without them.

[Download](https://github.com/NameSRoby/RaveLink-Core/releases/latest) ·
[User guide](docs/USER_GUIDE.md) · [Contribute](CONTRIBUTING.md) ·
[Report a bug](https://github.com/NameSRoby/RaveLink-Core/issues/new?template=bug_report.yml)

Mod developers: [Start here](docs/MOD_AUTHOR_GUIDE.md) ·
[SDK and capability APIs](docs/MOD_API_REFERENCE.md) ·
[Application APIs](docs/API_REFERENCE.md) ·
[Runnable button starter](packages/mod-sdk/starter).

## Install 0.7.6

Choose the installer for guided setup or the self-contained ZIP for portable
use. Both include Node, production dependencies, the tray launcher and an audio
helper with its C runtime built in. No separate Node, npm, Rust, Visual C++ runtime
installer or developer tools are needed.

1. Download **RaveLink-Core-Windows-v0.7.6-setup-installer.exe** from the [0.7.6 release](https://github.com/NameSRoby/RaveLink-Core/releases/tag/v0.7.6).
2. Choose an installation folder, Music-to-Light and optional features. Setup checks bundled prerequisites and downloads only your selected online features. Use a separate folder from an old RaveLink Bridge installation.
3. Choose **Main**, **More** or **Hidden** placement for tabs. Change this later from the settings gear → **Choose tabs**.
4. Launch from the Start menu or desktop shortcut. RaveLink opens its desktop workspace. The window menu and tray can reopen, restart or exit it; **Open in browser** keeps the normal website available.

Windows 10 build 19041 or later, or Windows 11, 64-bit, is required. Music-to-Light process capture requires build 20348 or later; Windows 11 is recommended. Setup checks .NET Framework 4.8 and explains any missing prerequisite. The Node.js runtime and production dependencies are bundled. The release is unsigned; SmartScreen may show an unknown-publisher warning. Verify downloads against `SHA256SUMS.txt`.

For portable use, extract **RaveLink-Core-Windows-v0.7.6-self-contained.zip**
completely and run `RaveLink-Core.exe`. Both release ZIPs contain the complete
application and runtime. First extraction and launch can be done offline; optional
package downloads and online services need internet. Install features later under
**Packages**. Upgrades preserve local settings and feature data.

If you downloaded **Code > Download ZIP**, that is the source checkout. Extract
it and run `Start-RaveLink.cmd`; first setup downloads a verified runtime bundle.
See [source and offline setup](docs/USER_GUIDE.md#source-and-tests) for details.

The Windows desktop window uses Microsoft WebView2. If its runtime is missing,
Core provides an installation link and a browser fallback. Both ZIPs include the
WebView2 loader files.

### First launch

- Open **Fixtures** to discover or pair your lights. Hue Entertainment needs an
  area created in the Hue app; Govee needs a compatible model with LAN Control enabled.
- Open **Lights > Music-to-Light > Audio & lights** to select an audio source and lights.
  Capture and light output require your permission; choosing Music-to-Light in
  the installer does not start either.
- Install optional packages under **Packages**, then connect your own accounts.
  Device pairings and account credentials must be configured on each PC.
- If the dashboard does not open, the desktop window provides **Retry**, **Restart Core**,
  **Open in browser**, and **Startup log**. If Microsoft WebView2 is missing, use
  the displayed installation link or continue in your browser.

See the [user guide](docs/USER_GUIDE.md) for detailed setup, source-checkout
instructions and upgrades from older installations.

## What you can do

### Your dashboard

Keep managed Channel Points controls, request intake, music lighting, saved light
profiles and package shortcuts together. Use **Edit dashboard** from the settings
cog or toolbar to add, hide and reorder actions, and choose spacing and columns.
Your layout is saved locally. Reward pause/resume applies to rewards managed by Core.

Switch to **Button deck** for playback, volume, moderation, lighting, Discord and
broadcast clipping controls. New decks start on one **Quick Access** page; add
your own pages when useful. Use the **+** tile to add an existing app action or an
approved mod function. **Edit** lets you customize buttons, drag them into order,
remove them and undo a layout change. Add pages, folders, ordered macros and hold
actions; use your own text, symbols, images, animated GIFs and backlight colors.
Buttons have a rounded clear acrylic face with recessed LED backlighting.
In Edit, grab any part of a button with mouse,
touch or pen; a tap opens its settings. Edge scrolling supports long decks, and
keyboard arrow keys work from the move grip.
Set each button's backlight from 0-100%; **Layout** also provides a master level.
The light also reports confirmed control state: active, paused/muted, pending,
unavailable or failed. Unknown state stays neutral, and status takes priority over
resting color effects. Layout and Page settings sit in the top bar, which stays
visible while editing. Quick Edit controls change the display mode and buttons
per row for the current screen size. Auto fit adapts crowded tiles; icon/image
only, text only and periodic icon/text alternation are available too.
**Button settings** offers shared style presets for all buttons, the current page
or one button, plus an **Individual buttons** list for artwork, labels and actions.
Applying a style preserves your actions, pictures, GIFs and labels.
Rewards and lights can use individual buttons, an all-controls button or a compact
popup. Pin rewards or a chosen light setting from the popup; its manual light
changes use an explicit Apply control.
**Layout** sets separate desktop, tablet and phone row counts, spacing, corners,
label size, button shape and status labels, with a preview before saving.
**Fullscreen** shows the buttons and enabled status widgets with an Exit control; Escape also exits. It uses
native fullscreen when permitted and otherwise fills the available app/browser viewport.
The [button deck guide](docs/CONTROL_DECK.md) covers setup and custom actions.

[<img src="assets/screenshots/dashboard.png" alt="Rounded acrylic button deck with compact music widgets, scene controls and state feedback" width="920">](assets/screenshots/dashboard.png)

Start with **+** to add a control. Use **Edit** for layout, appearance and drag-to-reorder;
status lighting distinguishes active, paused and unavailable controls.
All screenshots below use demonstration data and simulated connections. Click to enlarge.

### Build controls for OBS

Open **OBS connection** on the dashboard, connect, then choose **Create an OBS button**
from the button editor. Pick a source and what it should do: show/hide, mute,
adjust volume or change a filter. Source visibility can apply to one scene or
all matching instances across scenes and groups. No additional OBS plugin is needed.

[<img src="assets/screenshots/obs-button-builder.png" alt="OBS button builder showing source selection, action and scene scope" width="760">](assets/screenshots/obs-button-builder.png)

### Lighting and Music-to-Light

Control colors, brightness and supported white temperatures, save profiles, and
route viewer effects to selected fixtures. Music-to-Light captures a chosen app
or output device and turns its audio into rhythmic colors and measured musical brightness.

**Light profiles** uses a simple workflow: create a profile, add fixtures, select
one to edit, then save. Saved profiles become available in the button library with
a bulb icon and fixture-colored LED backlighting. **Viewer Controls** groups the
permissions and effect settings; **Light Commands** exports plain text, Twitch
panel Markdown or Discord message parts. See the
[profile and viewer-control guide](docs/USER_GUIDE.md#light-profiles-and-viewer-controls).

- **Play:** choose from ten distinct effect profiles, preview your room, and use matching,
  custom or fresh random colors. Optional profile shuffle chooses once per Rave without repeats.
- **Create:** fine tune choreography, lead/ambient contrast, smoothing, intro/outro and palette sharing;
  preview and save your own effects. Palette choices can be shared, per group or per light.
- **Automation:** manage songs, viewer submissions, and Auto-Rave.
  Song automation is off by default and needs fresh matching song metadata.
- **Audio & lights:** select the main app and fallbacks, grant capture/output permissions,
  calibrate at your listening volume, and choose fixture jobs. Optional auto audio follow
  uses the saved mixer reference when a matching app gain is available.
- **Viewer Controls:** enable Chat Rave and configure viewer lighting commands.
  Viewers can redeem your connected Change my lights reward with `rave`.

[<img src="assets/screenshots/music-to-light.png" alt="Music-to-Light Play with distinct profiles, palette choices and an audio preview" width="920">](assets/screenshots/music-to-light.png)

Begin in **Audio & lights** to select and calibrate your source, then return to
**Play** to choose a profile and preview it. **Create** holds the detailed tuning.

[Music controls and color modes](docs/USER_GUIDE.md#music-to-light) ·
[Response baseline and settings](docs/MUSIC_TO_LIGHT_BASELINE.md) ·
[Hue Entertainment setup](docs/USER_GUIDE.md#hue-entertainment-setup) ·
[Govee compatibility](docs/USER_GUIDE.md#govee-lan-compatibility)

### Song requests, playlists and overlays

The optional **Song Request** package provides FIFO requests, moderation,
requester/song bans and timeouts, playlists, reviewed playlist transfers, and
customizable OBS overlays. Choose a player and follow its Setup page.

| Player     | Connection and limits                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YouTube    | Search and official embeds; uploader, account, region and age restrictions can block playback.                                                                  |
| SoundCloud | Public search and official widget playback; availability, ads and preview limits remain provider-controlled.                                                    |
| Spotify    | Local desktop companion for requests; optional Premium OAuth for official search and playback controls. Client updates can require companion preparation again. |
| TIDAL      | Signed-in catalog and a desktop companion for native requests; reviewed account-playlist transfers are available.                                               |

[<img src="assets/screenshots/song-request.png" alt="Song Request player showing playback and request queue controls" width="920">](assets/screenshots/song-request.png)

Use **Player** for playback and **Request Queue** for moderation. In **Overlay Designer**,
select objects on the canvas or in the object list, adjust their layout and use
**Save overlay** to apply changes to OBS.

<details>
<summary>See the overlay editing workflow</summary>

[<img src="assets/screenshots/overlay-designer.png" alt="Overlay Designer with a canvas, object list and selection inspector" width="920">](assets/screenshots/overlay-designer.png)

</details>

[Player setup and limitations](docs/USER_GUIDE.md#optional-features) ·
[Playlists and transfers](docs/USER_GUIDE.md#playlists-and-transfers)

### Twitch and viewer interaction

The optional **Twitch Integration** package connects chat, EventSub and managed
Channel Points rewards. Viewers can change lights, start Rave or request songs
when you enable the corresponding controls.

**Twitch Connection** lets you choose Channel Points, reading chat commands,
sending replies, moderator/VIP lookup and stream clipping before authorization.
Each feature shows its current granted access. Saved choices apply to the next
login; unchecking a choice does not revoke an existing Twitch grant. Update
**Twitch Integration to 0.12.7** under Packages for this permission chooser.

<details>
<summary>See how Twitch permissions map to features</summary>

[<img src="assets/screenshots/twitch-permissions.png" alt="Twitch connection showing optional permission groups and feature availability" width="760">](assets/screenshots/twitch-permissions.png)

Choose the features you want before starting authorization. Missing access is
shown beside the affected feature so you can connect only what you need.

</details>

Native managed Song Request rewards stay refundable until confirmed playback
starts. Viewers can use `!remove` beforehand; queue admission or desktop handoff
alone does not complete the reward. Confirmed refunds and Rave-blocked lighting
commands get chat feedback. Automatic settlement requires native managed rewards;
StreamElements widget-only intake leaves refunds and fulfillment manual.

[Community playlist rewards](docs/USER_GUIDE.md#community-playlist-reward)

## Compatibility and limitations

- Lighting capability depends on the fixture model, firmware and network.
  Govee LAN uses whole-light controls, without segments, DreamView or app scenes.
  Hue Entertainment requires bridge pairing, a client key and a configured area.
- Music-to-Light process capture needs Windows build 20348 or later. Protected
  audio may be unavailable; browser capture does not isolate individual tabs.
- Provider apps, accounts and playback restrictions still apply. Desktop
  companions may need updating after Spotify or TIDAL changes.
- Repeated YouTube playback failures stop automatic pulls. Check the player error
  before resuming; unconfirmed requests are retained rather than silently drained.
- Stop and normal shutdown attempt to restore light state. A crash, power loss or
  an unavailable device cannot guarantee restoration.
- Automated tests use synthetic audio, simulated lights and mocked providers.
  They do not certify every physical fixture, account or clean-PC installation.
- Room Layout uses positions you place manually. Community mods are optional
  third-party code; review them before enabling them. Java/JavaFX is not required to run Core.

## New in 0.7.6

- **Button deck dashboard:** switch between the overview and customizable controls on one Quick Access page. Add optional pages, folders, ordered macros, alternate press actions and hold actions. Clear acrylic buttons support 250 searchable offline icons with selectable colors, custom symbols, text, PNG/JPEG/GIF images, static or cycling backlight tints and individual/master brightness. Shared style presets preserve artwork and actions. Quick Edit layout controls and fullscreen with status widgets keep the deck usable across screens.
- **Reward and light controls:** use individual buttons, one all-controls button or compact popups. Pin individual managed rewards or a saved light setting. Popup light changes use an explicit Apply control; reward toggles follow the current owner state.
- **Keyboard and clip buttons:** native keyboard macros support F13–F24 and custom combinations from desktop or LAN. Existing Discord buttons migrate to F13/F14 macros; keyboard actions report input delivery without inventing application state. The Twitch clip mod supports optional titled `!clip` commands. Custom clip titles default to offline word filtering with `****` replacement; add blocked words, allowed exceptions or reject mode in Connections. RaveLink never starts, restarts or closes Discord.
- **Status widgets:** add compact now-playing, request queue, stream timer, audience, clips, timestamps and OBS summaries above your buttons. Add, reorder or customize them through Edit; widgets also appear in fullscreen by default. Local stream timestamps can also be added as macro buttons. See [status widgets](docs/CONTROL_DECK.md#status-widgets).
- **Custom OBS buttons:** build scene, camera/source visibility, microphone, volume and filter controls from OBS’s actual lists, with scene snapshots and confirmed feedback. Studio transitions and output controls are available too. OBS 28+ has the required WebSocket server built in; connect once and use the same controls from the desktop app or LAN phone/tablet. See [OBS button setup](docs/CONTROL_DECK.md#obs-buttons).
- **Music-to-Light:** the accepted full-range brightness response, controlled rhythmic colors, ten distinct fixture profiles, matching/custom/random palettes and optional profile shuffle. Fine tuning and saved effects live in Create.
- **Overlay editing:** a visible object list, selection inspector, local Undo/Redo, duplication, zoom, shape names/visibility and cancellable dragging. OBS changes remain explicit through Save overlay.
- **Release health:** complete music runtime dependency packaging, bounded preference reads and stronger mod permission-change checks. The [health review](docs/REPOSITORY_HEALTH.md) records publication checks and validation status.

See [button deck setup and custom actions](docs/CONTROL_DECK.md). Update **Song Request to 0.45.9** under Packages for the overlay and playback-control changes.

## Privacy, updates and support

Core binds to loopback by default. Settings, pairings, credentials, playlists and
logs are stored locally and excluded from published downloads. Supported secrets
are protected for the current Windows user. Services you enable still make
network connections, including account sign-in, provider playback, package
installation and GitHub update checks. Local does not mean fully offline.

Updates verify checksums, preserve local data and keep a rollback snapshot.
Optional packages have their own updates under **Packages**. For older-version
upgrade instructions, see the [user guide](docs/USER_GUIDE.md#music-to-light-basics).
Uninstall through Windows **Installed apps** or the Start menu.

[Report a bug](https://github.com/NameSRoby/RaveLink-Core/issues/new?template=bug_report.yml)
with your Core/package versions, Windows build, installation method, steps and
expected/actual behavior. Review logs and screenshots before sharing them; exclude
tokens, account details, private paths and runtime or configuration folders.

## Contributing

Bug reports, documentation improvements, focused fixes and compatibility reports
are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for development setup,
checks and PR guidance. The [developer guide](docs/DEVELOPMENT.md) explains module
ownership, fixture restoration, feature isolation and provider recovery rules.

The [repository health review](docs/REPOSITORY_HEALTH.md) is a dated audit, not a
current performance guarantee. The [earlier native-client plan](docs/PRODUCT_DIRECTION.md)
is historical design context, not a shipped JavaFX client.

## License

Apache-2.0. Third-party code and provider marks retain their licenses; see
[LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
