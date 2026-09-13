# RaveLink Core

<img src="assets/RaveLink-Core.png" alt="RaveLink Core" width="96" height="96">

RaveLink Core is a local Windows control app for streamer lighting and optional Twitch-powered features. It runs from the system tray and opens its control surface at `http://127.0.0.1:5050`.

## What It Does

- Discovers, pairs, groups, and controls Philips Hue and WiZ lights, with compatible Govee LAN lights available as an Alpha feature.
- Understands natural color requests such as `light red 70%` and fixture prefixes.
- Generates a small StreamElements widget when OAuth-free Twitch event intake is preferred.
- Adds native Twitch OAuth, chat, and channel-point handling as an optional feature.
- Adds YouTube Song Request, local playlists, playback controls, and OBS overlays as an optional feature.
- Adds optional SoundCloud Song Request search, playback, and public playlist import through SoundCloud's official API and widget as an Alpha feature.
- Keeps optional features and community mods isolated from the lighting core.

## Install

1. Open the latest GitHub release.
2. Download `RaveLink-Core-Windows-v0.6.2-setup-installer.exe`.
3. Choose an installation folder and the optional features you want.
4. Launch **RaveLink Core** from the Start menu or desktop shortcut.

The installer includes the application runtime and production dependencies. Node.js and npm are not required.

## First Run

Use **Fixtures** to discover and pair lights, then assign them under **Lights**. Optional feature tabs appear only when their packages are installed. The tray icon can reopen the control surface, restart the local server, or shut it down cleanly.

Govee LAN support works only with models that expose **LAN Control** in the Govee Home app. Enable it for each light and keep the light and RaveLink computer on the same local network. Some Govee models do not offer LAN Control and cannot be used by this Alpha integration.

SoundCloud support must be installed separately and requires credentials from your own registered SoundCloud application. SoundCloud currently limits app registration and may require an Artist Pro account. API access, playable-track availability, regional restrictions, and widget behavior remain controlled by SoundCloud, so this Alpha integration may be unavailable to some users even when Song Request itself works normally.

RaveLink Core listens on the local machine by default. OAuth tokens and other private runtime state stay outside the published source and release payload; supported secrets are protected for the current Windows user.

## Portable Version

The release also includes a self-contained ZIP. Extract the complete folder, then run `RaveLink-Core.exe`. Do not move the executable away from its accompanying folders.

## Uninstall

Use **Installed apps** in Windows or the RaveLink Core Start menu entry. The uninstaller asks the tray host to stop before removing program files.

## Requirements

- Windows 10 or Windows 11, 64-bit
- A local network connection for supported smart lights
- Internet access only for online services you choose to use, such as Twitch or YouTube

## License

RaveLink Core is licensed under the Apache License 2.0. Third-party components retain their own licenses; see `THIRD_PARTY_NOTICES.md` in the installed folder.
