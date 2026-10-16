# Spicetify-derived Spotify companion components

This prototype contains a small, modified subset of Spicetify's native API exposure approach. It is not the Spicetify application, CLI, marketplace or extension platform, and does not imply endorsement by Spicetify or Spotify.

Upstream: https://github.com/spicetify/cli

Pinned release: v2.45.3, commit `8c92e3067de9659caca4c9da7979da3897458e27`.

Adaptation references:

- `src/preprocess/preprocess.go`, `Expose PlatformAPI` patch: the marker pattern in `platform-hook.cjs` was ported from Go to JavaScript, restricted to one match and changed to capture through RaveLink's private setter. Unsupported and ambiguous inputs are rejected.
- `src/jsHelper/spicetifyWrapper/core.js`, `player-events.js`, `webpack/runtime-resolvers.js` and `webpack/spicetify-bindings.js`: reduced native Player/Queue access in `native-facade.cjs`. Broad platform exposure, UI helpers, polling/event framework and other customization functions are omitted. Validation and an endpoint allowlist were added.

These adapted files are provided under GNU LGPL version 2.1. The complete upstream license is retained as `LICENSE` in source and `LICENSE.Spicetify` in the prototype bundle. Copyright in the upstream work remains with its respective contributors; modifications are by the RaveLink contributors, 2026. Other separately authored RaveLink modules retain the repository's license.

The prototype bundle includes the editable linked modules, adapted hook and build script. Full project sources and build tools are distributed with RaveLink. Users can modify the adapted component and rebuild the renderer; this prototype adds no signature or activation check that prevents doing so. No Spotify executable, account credentials or proprietary Spotify asset is distributed here.

Do not remove this notice, the adapted-source license headers or the LGPL text when redistributing these components. The upstream repository and pinned source remain available at https://github.com/spicetify/cli/tree/8c92e3067de9659caca4c9da7979da3897458e27.
