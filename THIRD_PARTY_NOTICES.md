# Third-Party Notices

RaveLink Core includes or interoperates with the following third-party components. Their respective licenses remain in effect.

## Bundled Runtime And Libraries

- **Node.js 24.13.0 Windows runtime** - Node.js license. The unmodified executable is renamed `RaveLink-Core-Node.exe`; its complete license is installed as `runtime/NODE-LICENSE.txt`.
- **axios** - MIT License.
- **bonjour-service** - MIT License. Used for bounded Philips Hue discovery.
- **cross-fetch** - MIT License. Used by Hue Entertainment support.
- **express** - MIT License.
- **hue-sync** - Apache License 2.0. Optional Hue Entertainment transport.
- **node-dtls-client** - MIT License. Optional Hue Entertainment transport dependency.
- **yauzl** - MIT License. Used for bounded mod package extraction.
- **yazl** - MIT License. Used for mod package creation.
- **youtubei.js** - MIT License. Used for YouTube catalog lookup and playback metadata.
- **Rajdhani Bold** - SIL Open Font License 1.1. Used to render the RaveLink Core application icon. Source: Google Fonts.

The installed `node_modules` packages include their own package metadata and license files where supplied upstream.

Transitive production packages currently use MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, or the combined Apache-2.0/BSD-3-Clause expression declared by `@bufbuild/protobuf`. Their upstream license texts and package metadata are retained under `node_modules`. `scripts/verify-third-party-notices.js` prevents a direct production dependency from being added without a repository-level notice.

## Optional Feature Packages

- **Clip Studio 0.1.0 infrastructure** - first-party RaveLink code only. It bundles no FFmpeg binary, machine-learning runtime, model weights, or other third-party processing payload. The downloadable package carries its own `THIRD_PARTY_NOTICES.md`; future engine and model updates must update both notice files before publication.

## Protocol References

- WiZ local control documentation was used to implement the local `setPilot` protocol. No WiZ source code is included.
- Twitch, YouTube, StreamElements, Philips Hue, WiZ, Spotify, and OBS are trademarks or services of their respective owners. RaveLink Core is not endorsed by them.
