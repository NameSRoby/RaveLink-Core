# Creating RaveLink mods

This guide covers the mod API shipped with RaveLink Core 0.7.6. Start with the
[runnable starter](../packages/mod-sdk/starter), then use the
[complete mod API reference](MOD_API_REFERENCE.md) and
[application API map](API_REFERENCE.md). The mod protocol is version 1; it is
versioned separately from the application and optional features.

## Choose the right extension

| What you want                                                                                  | Where to start                                                                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A keyboard key, Windows audio control, OBS source/filter/scene, reward toggle or music control | Dashboard **+ Add button**. Existing actions and multi-step macros require no mod.   |
| Your own computation, state or reusable function exposed as a button                           | A mod with `contributes.actions`.                                                    |
| A separate desktop/web client controlling Core                                                 | The versioned [Core client API](architecture/core-client-api-v1.md).                 |
| A new trusted account/device integration inside Core                                           | A reviewed host capability/provider. A mod cannot grant this to itself.              |
| A Music-to-Light profile or saved effect                                                       | The effect editor and profile controls described in the [user guide](USER_GUIDE.md). |

Mods run in supervised Node child processes. They do not receive the Express app,
Core services, OBS password, account tokens, filesystem writers, a shell or light
adapters. The SDK wraps the host context; it does not install privileges.

## Current availability and trust

Core 0.7.6a includes mod discovery in its normal startup. Drop an extracted
mod folder or a ZIP directly into **`mods/`**, open **Mods**, and confirm **Activate**.
No installer switch, special launch command, npm install or Core source edit is
needed. Declared buttons appear in the Dashboard action library and declared UI
panels appear in Mods. The former `mod/` folder is still watched for compatibility;
new installations create only `mods/`. Version 0.7.6 predates this change.
A source checkout can also use `npm.cmd run start:mods`; strict Core
uses `npm.cmd run start:core`. Do not run two servers on the same port.

On the bundled Windows runtime, full network denial for third-party Node workers
is not available. Normal activation fails closed unless the operator explicitly
accepts reduced isolation in the Mods review flow. That choice is per execution;
it does not turn the SDK into a malware sandbox. Only run trusted packages.
The bundled adapters have a separate, exact-inventory first-party exception.
Do not copy that exception into community packages or enable an unsafe default.

You can develop and test with fake providers without running a production worker.
The standalone SDK is in `packages/mod-sdk`; no npm-registry publication is
implied. Build locally with `npm.cmd pack ./packages/mod-sdk` or import its local
path from development tests. Bundle SDK imports into your mod output, or use the
starter's dependency-free CommonJS export. The host does not install dependencies
for a mod or provide arbitrary `node_modules` resolution.

## Make your first button

From a source checkout with dependencies installed:

```powershell
Copy-Item packages/mod-sdk/starter runtime/my-first-mod -Recurse
npm.cmd run mod:validate -- runtime/my-first-mod
npm.cmd run mod:package -- runtime/my-first-mod runtime/my-first-mod.zip
```

The starter's button toggles its own in-memory boolean and reports that same
state. It has no network, storage, credential or desktop permission. `status`
reads state without changing it; `toggle` changes it only when requested. Opening
the action library, editing a button or reading feedback never runs the toggle.

1. Rename `id` and `publisher` in `ravelink.mod.json`. The ID is
   `<publisher>.<name>`, such as `yourname.streamtools`.
2. Rename `example.button.v1` consistently in `provides`, the action contribution
   and the handler. Capability names are lowercase, dotted and versioned.
3. Implement `main.js`. Validate requests and honor cancellation before effects.
4. Update the SHA-256 inventory after every change to an included file.
5. Validate and test, then drop the folder (or its packaged ZIP) into **mods** and
   confirm **Activate** in the app. Discovery watches for changes automatically.
6. Add the contributed action with Dashboard **+ Add button**. Its public action
   ID is `mod:<mod-id>:<action-id>`; its label and symbol come from the manifest.
   Users choose layout, images/GIFs, colors, LED strength and hold/macro behavior.

State in the starter resets when the mod restarts. Use the storage capability for
durable settings; the example does not claim to control an external app or device.

## Lifecycle and requests

```js
module.exports = {
  activate(context) {
    // Save context, initialize bounded state, await required setup.
  },
  async handleRequest({ capability, method, payload, signal, deadlineAt }) {
    if (signal.aborted) throw Error("request_cancelled");
    // Verify capability/method, validate payload, await work, return JSON.
    return { ok: true };
  },
  handleEvent({ capability, event, payload }) {
    // Optional, bounded event processing. No unbounded history or new poller.
  },
  async deactivate() {
    // Stop your timers/listeners and finish within shutdownGraceMs.
  },
};
```

`activate` runs before the worker becomes active. `deactivate`, `handleRequest`
and `handleEvent` are optional. `defineMod()` requires `activate` and rejects
unknown handler names. Return plain JSON-compatible values; functions, streams,
buffers and cyclic objects are not IPC contracts.

A request has a deadline and `AbortSignal`. Broker calls made inside a mod request
inherit that request's lifetime. Await them before returning. Detached work can
be cancelled when the parent completes. Cancellation does not undo a remote
write that already happened. Re-read the owning system before deciding to retry.
Use real state for LEDs; a successful hotkey send does not confirm another app's
mute state, and a timeout does not prove a clip or scene change failed.

`activationEvents` declares allowed startup triggers (`onEnable`,
`onCapability:<capability>`, `onEvent:<token>`, `onCommand:<token>`). It does not
create Twitch subscriptions, global shortcuts or arbitrary event feeds.

## Call a host capability

Declare both the consumed capability and its permission/resource budget. A storage
example needs `consumes: ["ravelink.storage.v1"]`, `permissions.storage: true`
and nonzero `resources.storageBytes`:

```js
const reply = await context.callCapability("ravelink.storage.v1", "set", {
  key: "preferences",
  value: { enabled: true },
});
if (!reply.ok) throw Error(reply.error || "storage_failed");
```

The real worker receives the provider's validated payload. Built-in services
return `{ok: true, ...}` or `{ok: false, error}`; broker admission/transport errors
reject the promise. Check both paths. Opaque secret handles expose approved
operations, never token values. Network permission lists exact public HTTPS hosts;
it does not authorize localhost HTTP, private IPs, redirects or arbitrary headers.

`consumes` may suffix an optional capability with `?`; the context lists normalized
capability names without that suffix. Availability and provider compatibility
still need checking. Do not infer availability merely because you declared it.

The [reference](MOD_API_REFERENCE.md) lists every shipped host capability, its
methods, payloads, bounds and limitations. Use `ravelink.controls.v1` for the app’s existing OBS, keyboard, audio, playback,
light and Twitch actions. The separate Core HTTP API remains for external clients;
mods do not receive its tokens or direct service references.

## Add a settings panel

Keep the panel inside your package, for example:

```text
my-mod/
  ravelink.mod.json
  main.js
  ui/
    settings.html
    settings.css
    settings.js
```

Set `permissions.ui` to `true`, add the three UI files to the integrity inventory,
and declare the panel in the manifest:

```json
{
  "contributes": {
    "panels": [{ "id": "settings", "title": "My settings", "entry": "ui/settings.html" }]
  }
}
```

That fragment belongs inside your complete manifest. A panel title becomes a
button in Mods after activation; opening the panel loads its HTML. Relative
stylesheet links and script sources that are in the declared inventory are
verified and embedded automatically. Inline CSS and JavaScript also work. Keep
the combined page below 256 KiB. Bundle JavaScript imports into the supplied
script; the frame does not fetch third-party code or arbitrary HTTP resources.

The panel can call its own mod or an approved consumed capability:

```js
const result = await window.ravelink.call("example.settings.v1", "save", {
  enabled: document.querySelector("input").checked,
});
```

Declare `example.settings.v1` in `provides` and implement `handleRequest` in your
worker. Validate that payload before changing state. To use an app action instead,
declare `ravelink.controls.v1` in `consumes`, read its catalog, and pass the selected
action's parameters to `execute`. The operator reviews that access during
activation. A disabled mod cannot keep using APIs from a previously opened panel.

There is no need to edit the app's HTML, add a server route, install a local web
server or copy account tokens into a mod. Panel CSS stays in its frame, so an
extension cannot accidentally restyle the deck or another mod's page.

## Test without touching the stream

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createModTestHarness } = require("./packages/mod-sdk/testing");
const mod = require("./packages/mod-sdk/starter/main");

test("status is passive and toggle changes only owned state", async () => {
  const harness = createModTestHarness(mod, {
    modId: "example.button",
    provides: ["example.button.v1"],
    startAt: 0,
  });
  await harness.start();
  try {
    assert.equal((await harness.request("example.button.v1", "status", {})).enabled, false);
    assert.equal((await harness.request("example.button.v1", "toggle", {})).enabled, true);
    assert.equal(harness.calls.length, 0);
  } finally {
    await harness.stop();
  }
});
```

Save this test at the source checkout root, adjust paths for your project, then
run `node --test your-mod.test.cjs`. Fake host providers use keys such as
`"ravelink.storage.v1/get"`. Test rejection, cancellation, missing providers,
restart/migration behavior, passive status and duplicate commands. The harness
tests handler logic; it does not enforce OS isolation, package hashes, resource
budgets or broker admission. Use production validators as a separate check.

## Package inventory and updates

Every shipped file except `ravelink.mod.json` must appear in `integrity.files`
with its exact SHA-256. Include your license/readme and bundled runtime modules;
exclude credentials, personal data, dependency caches and development output.
Keep portable forward-slash paths. Links, traversal, duplicate/colliding names,
undeclared files and mismatched hashes are rejected.

For the unchanged two-file starter layout, update hashes explicitly:

```powershell
$modFolder = (Resolve-Path runtime/my-first-mod).Path
$manifestPath = Join-Path $modFolder 'ravelink.mod.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest.integrity.files = [ordered]@{}
foreach ($file in @('main.js', 'README.md')) {
  $manifest.integrity.files[$file] = (Get-FileHash -LiteralPath (Join-Path $modFolder $file) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$json = $manifest | ConvertTo-Json -Depth 30
[IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
```

Add every new package file to that list. Validation never repairs hashes for you.
Package the manifest at the ZIP root, not inside an extra parent folder.
`mod:package` validates, emits a deterministic ZIP and verifies its extracted
contents. Use a new version for changes. The operator reviews the fingerprint,
permissions and resource changes, disables before replacement, and can roll back
one verified version. Uninstall retains data unless explicitly requested otherwise.
Removing an inbox ZIP does not uninstall its private installed copy.

## Troubleshooting and compatibility

| Symptom                              | Check                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Package not listed                   | Folder/ZIP directly under `mods/`; correct manifest root and valid inventory. Legacy `mod/` is also recognized. |
| Integrity error                      | Recompute all changed file hashes after final formatting/building.                                              |
| Approval required                    | Review the exact current fingerprint; permission or resource changes require renewed approval.                  |
| Network isolation unavailable        | Current runtime limitation; use the test harness or explicitly review reduced isolation for trusted code.       |
| Action missing                       | Mod active; `contributes.actions` valid; action capability present in `provides`.                               |
| Provider unavailable/ambiguous       | Required provider active and compatible; explicitly select its `providerId` where needed.                       |
| Storage/network permission denied    | Declare capability, exact permission and a nonzero resource budget.                                             |
| Quarantined or disabled              | Inspect lifecycle/error, frame size, timeouts, resource ceilings and repeated malformed requests.               |
| UI panel cannot call Core            | Expected: panels have no direct API or network bridge. Use contributed actions.                                 |
| Wrong state after an external change | Read confirmed provider state; do not maintain a guessed copy of another app's toggle.                          |

Keep older stored settings readable, separate state migrations from external
effects, release all owned resources on shutdown and bound every cache/queue.
Never publish your development `runtime/` directory or account/device bindings.
