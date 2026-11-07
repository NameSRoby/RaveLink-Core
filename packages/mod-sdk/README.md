# @ravelink/mod-sdk

Standalone API helpers for isolated RaveLink mods. The package has no runtime dependencies and imports no RaveLink server implementation.

Start with the included [runnable button starter](starter/README.md). The full
[author guide](https://github.com/NameSRoby/RaveLink-Core/blob/main/docs/MOD_AUTHOR_GUIDE.md)
covers manifests, permissions, lifecycle, testing, packaging, installation and
troubleshooting. The [API reference](https://github.com/NameSRoby/RaveLink-Core/blob/main/docs/MOD_API_REFERENCE.md)
lists every SDK method, shipped host capability, resource bound and administration API.
The [application API map](https://github.com/NameSRoby/RaveLink-Core/blob/main/docs/API_REFERENCE.md)
explains which interfaces belong to separate clients or optional features.

This SDK is available from this repository; external npm publication is a separate
release action. Use `npm.cmd pack ./packages/mod-sdk` from a source checkout for a
local package. Current Windows community activation requires explicit operator
review of reduced network isolation; the deterministic test harness needs no such
runtime override. Event publication has no subscriber-delivery acknowledgement.

```js
const { defineMod, createCapabilityClient } = require("@ravelink/mod-sdk");

module.exports = defineMod({
  async activate(context) {
    const capabilities = createCapabilityClient(context);
    await capabilities.call("ravelink.storage.v1", "set", {
      key: "settings",
      value: { enabled: true },
    });
  },
});
```

Use `@ravelink/mod-sdk/testing` for deterministic lifecycle, request, event, and fake-capability tests. Mods must still declare every consumed/provided capability and permission in `ravelink.mod.json`; SDK calls cannot expand those grants.

The exact host contracts are exported as `@ravelink/mod-sdk/schemas/manifest-v1` and `@ravelink/mod-sdk/schemas/broker-envelope-v1`.

Dashboard buttons can discover an explicitly contributed action without a custom
HTML panel. The action's capability must appear in `provides`; its handler runs
inside the same approved mod and retains every existing permission boundary.

```json
"contributes": {
  "actions": [{
    "id": "run", "title": "My stream action", "symbol": "✦",
    "capability": "example.stream.v1", "method": "run", "stateMethod": "status",
    "defaults": {},
    "parameters": {"type": "object", "additionalProperties": false, "properties": {}}
  }]
}
```

An optional `stateMethod` is called with `{}` while the button interface is visible.
Return `feedback: {state: "ready", label: "Ready", active: false, color: "#167d55"}`
from that method. Feedback must reflect confirmed owner state; loading a button
or reading its status must never run its action. Input fields use a bounded JSON
Schema subset; no JavaScript is evaluated by the editor. Images/GIFs are operator
presentation choices and are stored separately from the mod package.

An optional operator panel is declared with `permissions.ui: true` and an integrity-listed single HTML entry:

```json
"contributes": {
  "panels": [{ "id": "settings", "title": "Settings", "entry": "ui/settings.html" }]
}
```

Panels load only when opened, run in a sandboxed opaque-origin frame, and have no network or form capability. They cannot inject into the core DOM or call server APIs directly.
