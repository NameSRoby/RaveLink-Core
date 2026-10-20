# Third-Party Notices

RaveLink Core includes or interoperates with the following third-party components. Their respective licenses remain in effect.

- **Inrixia/TidaLuna** — Microsoft Public License (Ms-PL), revision
  `4b8c306737fb53423d5c0138e24a367f0c268cf0`. The RaveLink TIDAL companion adapts
  the action-factory finder from `render/src/helpers/findCreateAction.ts`.
  Credit: Inrixia and TidaLuna contributors. Complete license, provenance and
  modification notices ship in `integrations/tidal-desktop/LICENSE.TidaLuna`
  and `integrations/tidal-desktop/NOTICE.md` in source. Windows downloads place
  the same companion and notices under `packages/tidal-desktop`, including its installable bundle.
  The adapted file remains Ms-PL; other companion code is first-party Apache-2.0.
  Upstream: https://github.com/Inrixia/TidaLuna . The full Luna platform and TIDAL
  application are not bundled. Electron is supplied by the user's installed TIDAL app.

- **SoundCloud HTML5 Widget API** ? loaded on demand from `https://w.soundcloud.com/player/api.js` when the user chooses SoundCloud playback or public playlist import. Media and attribution remain in the visible official player. The SDK and SoundCloud audio are not bundled. Documentation: https://developers.soundcloud.com/docs/api/html5-widget .

## Bundled Runtime And Libraries

- **Simple Icons** — YouTube, TIDAL and SoundCloud provider glyphs, CC0-1.0.
  Source: https://github.com/simple-icons/simple-icons . The Song Request package
  includes provenance and the complete license in `THIRD_PARTY_NOTICES.md` and
  `LICENSE.SimpleIcons.txt`.

- **Node.js 24.13.0 Windows runtime** - Node.js license. The unmodified executable is renamed `RaveLink-Core-Node.exe`; its complete license is installed as `runtime/NODE-LICENSE.txt`.
- **axios** - MIT License.
- **bonjour-service** - MIT License. Used for bounded Philips Hue discovery.
- **cross-fetch** - MIT License. Used by Hue Entertainment support.
- **express** - MIT License.
- **express-rate-limit** - MIT License. Bounds local settings saves and Spotify companion requests.
- **hue-sync** - Apache License 2.0. Optional Hue Entertainment transport.
- **node-dtls-client** - MIT License. Optional Hue Entertainment transport dependency.
- **yauzl** - MIT License. Used for bounded mod package extraction.
- **yazl** - MIT License. Used for mod package creation.
- **youtubei.js** - MIT License. Used for YouTube catalog lookup and playback metadata.
- **Rajdhani Bold** - SIL Open Font License 1.1. Used to render the RaveLink Core application icon. Source: Google Fonts.

The installed `node_modules` packages include their own package metadata and license files where supplied upstream.

Transitive production packages currently use MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, or the combined Apache-2.0/BSD-3-Clause expression declared by `@bufbuild/protobuf`. Their upstream license texts and package metadata are retained under `node_modules`. `scripts/verify-third-party-notices.js` prevents a direct production dependency from being added without a repository-level notice.

## Optional Feature Packages

## Protocol References

- **Music-to-Light native capture helper** — `integrations/music-to-light/native` uses Microsoft's `windows` / `windows-core` Win32 bindings and support crates (MIT OR Apache-2.0), and Serde/serde_json (MIT OR Apache-2.0). Transitive source-build dependencies include `itoa`, `proc-macro2`, `quote`, `syn` (MIT OR Apache-2.0), `memchr` (Unlicense OR MIT), `unicode-ident` ((MIT OR Apache-2.0) AND Unicode-3.0), and `zmij` (MIT). Exact versions/checksums are retained in `native/Cargo.lock`; upstream package source includes license texts. API references: [Microsoft process-loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/) and [WASAPI capture packets](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nn-audioclient-iaudiocaptureclient). The first-party helper is bundled in the Windows installer and portable archives. Complete dependency license texts and a locked version/source inventory are retained under `integrations/music-to-light/licenses`; source and the Cargo lockfile are published under `integrations/music-to-light/native`.

- **Spicetify contributors** — LGPL-2.1. The optional Spotify desktop companion contains a reduced, modified platform-capture hook and native Player/Queue facade based on Spicetify v2.45.3. Its separate license, attribution, editable sources and build script are retained under `integrations/spotify-desktop/vendor/spicetify` and the generated companion bundle. The Spicetify CLI, marketplace, themes and extensions are not bundled. The companion is prepared locally from Setup; no Spotify executable, proprietary Spotify assets or account credentials are distributed.

- WiZ local control documentation was used to implement the local `setPilot` protocol. No WiZ source code is included.
- Twitch, YouTube, StreamElements, Philips Hue, WiZ, Spotify, and OBS are trademarks or services of their respective owners. RaveLink Core is not endorsed by them.
