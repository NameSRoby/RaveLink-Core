# RaveLink Core

<img src="assets/RaveLink-Core.png" alt="RaveLink Core" width="96" height="96">

RaveLink Core is a local Windows control app for streamer lighting and optional Twitch-powered features. It runs from the system tray and opens its control surface at `http://127.0.0.1:5050`.

## What It Does

- Discovers, pairs, groups, and controls Philips Hue and WiZ lights, with compatible Govee LAN lights available as an Alpha feature.
- Applies individual colors, brightness levels, tunable-white settings, reusable whole-room profiles, and synchronized multi-brand effects.
- Routes ordinary color commands and dynamic effects independently, so each feature can use its own fixtures and optional viewer prefixes.
- Understands natural requests such as `deep blue 60%`, `all warm white`, `cycle red, green, blue`, and `wall fade purple, cyan slow`.
- Builds compact and detailed Light Commands guides from the currently active routes. Either guide can be copied into a Twitch panel or other viewer instructions.
- Generates a small StreamElements widget when OAuth-free Twitch event intake is preferred.
- Adds native Twitch OAuth, chat, managed Channel Points rewards, completion and refund handling, and broadcaster chat responses as an optional feature.
- Adds YouTube Song Request, server playlists, moderation, playback controls, and configurable OBS overlays as an optional feature.
- Keeps optional features and community mods isolated from the lighting core.

## Install

1. Open the latest GitHub release.
2. Download `RaveLink-Core-Windows-v0.6.3-setup-installer.exe`.
3. Choose an installation folder and the optional features you want.
4. Launch **RaveLink Core** from the Start menu or desktop shortcut.

The installer includes the application runtime and production dependencies. Node.js and npm are not required. Installing over an existing RaveLink Core installation updates program files while preserving local configuration, fixtures, playlists, optional-feature data, and rollback state.

## Lighting Setup

Use **Fixtures** to discover and pair lights. Use **Lights** to assign normal viewer color routes, dynamic-effect routes, profiles, and optional prefixes.

- **Direct Control** sends a color or brightness immediately and includes a routed-command test box.
- **Light Profiles** save per-fixture RGB, brightness, power, or dedicated white-temperature settings. Applying a profile stops effects on the fixtures it replaces.
- **Light Commands** shows the command language that is active for the current routes and provides copyable compact and detailed viewer guides.
- **Room Layout (Alpha)** stores fixture positions used by wave, sweep, ripple, rainbow, and chase effects. Positions are entered manually because Wi-Fi does not reveal a light's physical place in the room.
- **Light Lab** provides effect limits, timing adjustment, spatial direction, route experiments, and capability information.

Unprefixed dynamic commands affect every fixture enabled in the dynamic route. Optional dynamic prefixes select a smaller subset. The `all` keyword affects only fixtures assigned to the relevant saved route; disabled and unrouted fixtures remain unchanged.

Govee LAN support works only with models that expose **LAN Control** in the Govee Home app. Enable it for each light and keep the light and RaveLink computer on the same local network. Some Govee models do not offer LAN Control and cannot be used by this Alpha integration.

## Song Request And YouTube Playback

Song Request is optional and can be installed during setup or later from **Features**. It supports text lookup, direct YouTube links, FIFO requests, server playlists, moderation controls, and a customizable now-playing OBS overlay. The **Now Playing Sources** panel can also display the current Spotify, Apple Music, or TIDAL Windows media session in that overlay. These desktop sources only observe media information already exposed by Windows; they do not add song-request search or playback for those services. Multilingual titles are preserved as UTF-8, and the observer and overlay include Japanese, Chinese, and Korean support.

Playback uses YouTube's official embedded player. A video can still refuse embedded playback because its owner disabled embedding or because YouTube applies age, region, account, or content restrictions. Those decisions are controlled by YouTube and can make an otherwise valid request skip or fail. Improving failure handling and candidate selection remains work in progress; RaveLink Core does not download or restream YouTube media as a fallback.

## Updates And Rollback

Release checks are optional. When enabled, RaveLink Core can detect a newer stable GitHub release, download its self-contained archive, verify its SHA-256 checksum, preserve local state, and install the update. Startup health confirmation automatically rolls back a failed update, and the Updates tab retains a manual rollback option after a successful update.

## Privacy And Local Data

RaveLink Core listens on the local machine by default. OAuth grants, light credentials, playlists, runtime logs, and other private state are created locally after installation and are not included in published source or release archives. Supported secrets are protected for the current Windows user. Internet connections occur only for services you choose to configure, such as Twitch, GitHub release checks, or YouTube.

## Portable Version

The release also includes a self-contained ZIP. Extract the complete folder, then run `RaveLink-Core.exe`. Do not move the executable away from its accompanying folders. Optional feature packages are included but are not activated automatically.

## Uninstall

Use **Installed apps** in Windows or the RaveLink Core Start menu entry. The uninstaller asks the tray host to stop before removing program files.

## Requirements

- Windows 10 or Windows 11, 64-bit
- A local network connection for supported smart lights
- Internet access only for online services you choose to use, such as Twitch, GitHub release checks, or YouTube

## License

RaveLink Core is licensed under the Apache License 2.0. Third-party components retain their own licenses; see `THIRD_PARTY_NOTICES.md` in the installed folder.
