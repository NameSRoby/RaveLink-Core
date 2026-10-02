# RaveLink Core

<img src="assets/RaveLink-Core.png" alt="RaveLink Core" width="96" height="96">

RaveLink Core is a local Windows control app for streamer lighting and optional Twitch-powered features. It runs from the system tray and opens its control surface at `http://127.0.0.1:5050`.

**0.6.4 adds optional local speech to Alerts / TTS.** The base download stays small: optional features, the speech runtime, and its voice model download only when selected by the user.

## What It Does

- Discovers, pairs, groups, and controls Philips Hue and WiZ lights, with compatible Govee LAN lights available as an Alpha feature.
- Applies individual colors, brightness levels, tunable-white settings, reusable whole-room profiles, and synchronized multi-brand effects.
- Routes ordinary color commands and dynamic effects independently, so each feature can use its own fixtures and optional viewer prefixes.
- Understands natural requests such as `deep blue 60%`, `all warm white`, `cycle red, green, blue`, and `wall fade purple, cyan slow`.
- Builds compact and detailed Light Commands guides from the currently active routes. Either guide can be copied into a Twitch panel or other viewer instructions.
- Generates a small StreamElements widget when OAuth-free Twitch event intake is preferred.
- Adds native Twitch OAuth, chat, managed Channel Points rewards, completion and refund handling, and broadcaster chat responses as an optional feature.
- Adds YouTube Song Request, server playlists, moderation, playback controls, and configurable OBS overlays as an optional feature.
- Adds **Alerts / TTS** as an optional feature for synchronized lighting alerts, Twitch event and Channel Points triggers, donation moderation, a local OBS alert overlay, and locally generated speech.
- Keeps optional features and community mods isolated from the lighting core.

## Install

1. Open the latest GitHub release.
2. Download `RaveLink-Core-Windows-v0.6.4-setup-installer.exe` from the 0.6.4 release.
3. Choose an installation folder and any optional features you want. The base installer contains Core only and downloads only the selected feature packages from this official repository.
4. Launch **RaveLink Core** from the Start menu or desktop shortcut. Optional features can also be installed or removed later under **Packages**.

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

## Alerts / TTS

Alerts / TTS can create reusable lighting alerts, attach them to available Twitch events or Channel Points rewards, and display privacy-filtered test messages in its local OBS/browser overlay. Donation settings keep payment identities out of alert output and use only the public display name supplied for the message.

Local TTS is optional. Install the **Local TTS Engine** and **Kitten English Voice** from Alerts / TTS when speech is wanted; neither is included in the installer or portable archive. The first voice pack offers eight English voice styles, local Windows playback, volume and speed controls, a ten-message queue, replace/skip behavior, previews, cancellation, and fixed spoken messages on alert profiles. Downloads run as visible background jobs so the server remains responsive, and RaveLink safely pauses and restores the speech engine when voice files change. Downloads are accepted only from this repository's fixed release assets and are checked by exact size, SHA-256, archive limits, and package metadata before activation.

Donation preview speech uses only the public display alias and the moderated message; payment names, email addresses, and other payment identity fields never enter alert output. Live Ko-fi webhook receipt, hosted or self-hosted relay setup, and donation chat delivery remain work in progress. Additional languages and Custom Voice Tools are planned as separate optional downloads.

## Clip Studio Alpha

Clip Studio is an optional Alpha package foundation for future local video indexing, timestamp suggestions, titles, and clip candidates. Video processing and export are not active yet.

## Song Request And YouTube Playback

Song Request is optional and installs on demand from **Packages** using the official RaveLink GitHub repository. It supports text lookup, direct YouTube links, FIFO requests, server playlists, moderation controls, and a customizable now-playing OBS overlay. The **Now Playing Sources** panel can also display the current Spotify, Apple Music, or TIDAL Windows media session in that overlay. These desktop sources only observe media information already exposed by Windows; they do not add song-request search or playback for those services. Multilingual titles are preserved as UTF-8, and the observer and overlay include Japanese, Chinese, and Korean support.

Playback uses YouTube's official embedded player. A video can still refuse embedded playback because its owner disabled embedding or because YouTube applies age, region, account, or content restrictions. Those decisions are controlled by YouTube and can make an otherwise valid request skip or fail. Improving failure handling and candidate selection remains work in progress; RaveLink Core does not download or restream YouTube media as a fallback.

## Updates And Rollback

Release checks are optional. When enabled, RaveLink Core can detect a newer stable GitHub release, download its self-contained archive, verify its SHA-256 checksum, preserve local state, and install the update. Startup health confirmation automatically rolls back a failed update, and the Updates tab retains a manual rollback option after a successful update.

## Privacy And Local Data

RaveLink Core listens on the local machine by default. OAuth grants, light credentials, playlists, runtime logs, and other private state are created locally after installation and are not included in published source or release archives. Supported secrets are protected for the current Windows user. Internet connections occur only for services you choose to configure, such as Twitch, GitHub release checks, or YouTube.

## Portable Version

The release also includes a self-contained ZIP. Extract the complete folder, then run `RaveLink-Core.exe`. Do not move the executable away from its accompanying folders. Optional feature payloads are not bundled; install the ones you want from **Packages**, which downloads integrity-checked files from the official RaveLink GitHub repository.

## Uninstall

Use **Installed apps** in Windows or the RaveLink Core Start menu entry. The uninstaller asks the tray host to stop before removing program files.

## Requirements

- Windows 10 or Windows 11, 64-bit
- A local network connection for supported smart lights
- Internet access only for online services you choose to use, such as Twitch, GitHub release checks, or YouTube

## License

RaveLink Core is licensed under the Apache License 2.0. Third-party components retain their own licenses; see `THIRD_PARTY_NOTICES.md` in the installed folder.
