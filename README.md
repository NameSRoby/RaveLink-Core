# RaveLink Core

<img src="assets/RaveLink-Core.png" alt="RaveLink Core" width="96" height="96">

RaveLink Core is a local Windows app that connects your music, lights and Twitch
chat. Control compatible Hue, WiZ and Govee LAN lights, react to music, and let
viewers request songs or change your lighting through Channel Points.

It runs in the Windows tray, with a browser dashboard at
`http://127.0.0.1:5050` by default. Twitch and Song Request are optional packages;
local lighting works without them.

[Download](https://github.com/NameSRoby/RaveLink-Core/releases/latest) ·
[User guide](docs/USER_GUIDE.md) · [Contribute](CONTRIBUTING.md) ·
[Report a bug](https://github.com/NameSRoby/RaveLink-Core/issues/new?template=bug_report.yml)

## Install 0.7.4b

Choose the installer for guided setup or the self-contained ZIP for portable
use. Both include Node, production dependencies, the tray launcher and an audio
helper with its C runtime built in. No separate Node, npm, Rust, Visual C++ runtime
installer or developer tools are needed.

1. Download **RaveLink-Core-Windows-v0.7.4b-setup-installer.exe** from the [0.7.4b release](https://github.com/NameSRoby/RaveLink-Core/releases/tag/v0.7.4b).
2. Choose an installation folder, Music-to-Light and optional features. Setup checks bundled prerequisites and downloads only your selected online features. Use a separate folder from an old RaveLink Bridge installation.
3. Choose **Main**, **More** or **Hidden** placement for tabs. Change this later from the settings gear → **Choose tabs**.
4. Launch from the Start menu or desktop shortcut. The startup window shows the dashboard address and connection status. Use it or the tray icon to reopen, restart or exit.

Windows 10 build 19041 or later, or Windows 11, 64-bit, is required. Music-to-Light process capture requires build 20348 or later; Windows 11 is recommended. Setup checks .NET Framework 4.8 and explains any missing prerequisite. The Node.js runtime and production dependencies are bundled. The release is unsigned; SmartScreen may show an unknown-publisher warning. Verify downloads against `SHA256SUMS.txt`.

For portable use, extract **RaveLink-Core-Windows-v0.7.4b-self-contained.zip**
completely and run `RaveLink-Core.exe`. Both release ZIPs contain the complete
application and runtime. First extraction and launch can be done offline; optional
package downloads and online services need internet. Install features later under
**Packages**. Upgrades preserve local settings and feature data.

If you downloaded **Code > Download ZIP**, that is the source checkout. Extract
it and run `Start-RaveLink.cmd`; first setup downloads a verified runtime bundle.
See [source and offline setup](docs/USER_GUIDE.md#source-and-tests) for details.

All 0.7.4b downloads include the fresh-PC audio helper fix. Upgrading from the
original 0.7.3 installer or ZIP removes the separate Visual C++ runtime requirement.

### First launch

- Open **Fixtures** to discover or pair your lights. Hue Entertainment needs an
  area created in the Hue app; Govee needs a compatible model with LAN Control enabled.
- Open **Lights > Music-to-Light > Setup** to select an audio source and lights.
  Capture and light output require your permission; choosing Music-to-Light in
  the installer does not start either.
- Install optional packages under **Packages**, then connect your own accounts.
  Device pairings and account credentials must be configured on each PC.
- If the dashboard does not open, use the startup window or tray menu. The startup
  window provides the dashboard address, connection status and **Startup log**.

See the [user guide](docs/USER_GUIDE.md) for detailed setup, source-checkout
instructions and upgrades from older installations.

## What you can do

### Your dashboard

Keep managed Channel Points controls, request intake, music lighting, saved light
profiles and package shortcuts together. Use **Edit dashboard** from the settings
cog or toolbar to add, hide and reorder actions, and choose spacing and columns.
Your layout is saved locally. Reward pause/resume applies to rewards managed by Core.

[<img src="assets/screenshots/dashboard.png" alt="Dashboard with managed rewards and music quick actions" width="360">](assets/screenshots/dashboard.png)

<sub>Demo data; click the image to enlarge.</sub>

### Lighting and Music-to-Light

Control colors, brightness and supported white temperatures, save profiles, and
route viewer effects to selected fixtures. Music-to-Light captures a chosen app
or output device and turns its audio into reactive colors and pulses.

- **Main:** start or stop lighting, choose looks and colors, adjust intensity,
  brightness movement, smoothing and fixture contrast.
- **Library:** save looks and songs, manage viewer submissions, and enable
  Auto-Rave for selected songs. Auto-Rave is off by default and needs fresh song metadata.
- **Setup:** choose the main app, two fallbacks, capture permissions and fixture roles.
  Silent open apps retain priority; switching windows does not change a running capture.
- **Viewer Controls:** enable Chat Rave and configure viewer lighting commands.
  Viewers can redeem your connected Change my lights reward with `rave`.

[<img src="assets/screenshots/music-to-light.png" alt="Music-to-Light looks, color controls and simulated light response" width="360">](assets/screenshots/music-to-light.png)

<sub>Demo data; click the image to enlarge.</sub>

[Music controls and color modes](docs/USER_GUIDE.md#music-to-light-main-and-library) ·
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

[<img src="assets/screenshots/song-request.png" alt="Song Request player and a queue of demonstration songs" width="360">](assets/screenshots/song-request.png)

<sub>Demo data; click the image to enlarge.</sub>

[Player setup and limitations](docs/USER_GUIDE.md#optional-features) ·
[Playlists and transfers](docs/USER_GUIDE.md#playlists-and-transfers)

### Twitch and viewer interaction

The optional **Twitch Integration** package connects chat, EventSub and managed
Channel Points rewards. Viewers can change lights, start Rave or request songs
when you enable the corresponding controls.

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
- Repeated YouTube playback failures and rapid skips can overload playback and
  may stop or crash the server. Stop playback if songs keep skipping.
- Stop and normal shutdown attempt to restore light state. A crash, power loss or
  an unavailable device cannot guarantee restoration.
- Automated tests use synthetic audio, simulated lights and mocked providers.
  They do not certify every physical fixture, account or clean-PC installation.
- Room Layout remains Alpha. Community mods are optional third-party code; review
  them before enabling them. Java/JavaFX is not required to run Core.

## New in 0.7.4b

The refreshed 0.7.4b download keeps native Song Request rewards refundable until
confirmed playback starts. Use `!remove` beforehand to cancel and reclaim points.
Queue handoff to TIDAL or Spotify alone does not complete the reward. Chat
confirms successful refunds, explains Rave-blocked lighting commands, and includes
artist names in song confirmations when the provider supplies them. Widget-only
connections still require manual Twitch refunds. If you already installed
0.7.4b, rerun the refreshed installer and update **Song Request** under **Packages**.

A native startup window now shows connection status, a copyable dashboard address,
and buttons to open the dashboard, restart, view the startup log or exit. Failed
startup displays a useful error instead of opening an unreachable browser page.
Tray Exit and Restart cancel startup checks; bounded HTTP requests and an
independent exit deadline prevent a stalled server or frozen UI from keeping Core
running indefinitely. Shutdown requests are sent only to a verified Core server.

Setup now offers Music-to-Light explicitly and checks the bundled runtime,
production dependencies, writable data folders and selected audio helper before
launching. It reports optional feature download failures and blocks installation
into an old RaveLink Bridge folder. No credentials, device pairings or local
settings are included in the download.

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
