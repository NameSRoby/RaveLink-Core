# RaveLink TIDAL companion 0.1.6

This is a narrow RaveLink-maintained Windows companion, not TidaLuna and not an
official TIDAL product. It does not include Luna's plugin platform, UI, updater,
Quartz module loader, or third-party plugins. It ships no TIDAL application code.

`transform.cjs` adapts the action-factory finder from **Inrixia/TidaLuna**,
revision `4b8c306737fb53423d5c0138e24a367f0c268cf0`, specifically
`render/src/helpers/findCreateAction.ts`. This file and its distributed copy
remain under the Microsoft Public License (Ms-PL); the complete license is in
`LICENSE.TidaLuna`. Credit: Inrixia and TidaLuna contributors.
Source: https://github.com/Inrixia/TidaLuna/tree/4b8c306737fb53423d5c0138e24a367f0c268cf0

Other source files are RaveLink code under the repository's Apache-2.0 license.
The loader design and queue action/state research benefited from TidaLuna's
documented injection and Redux interfaces. No upstream trademark rights or
endorsement are claimed.

TIDAL owns its application, credentials and playback. TIDAL's installed Electron
runtime supplies Electron; RaveLink does not redistribute that runtime here.
