# Mod API reference

Public API v1, as shipped with Core 0.7.6. Read the
[author guide](MOD_AUTHOR_GUIDE.md) for a complete workflow. The executable
validators, [manifest schema](../packages/mod-sdk/schemas/mod-manifest-v1.schema.json)
and [broker schema](../packages/mod-sdk/schemas/broker-envelope-v1.schema.json)
define admission. This reference does not grant access to undocumented Core internals.

## SDK exports and types

Import CommonJS helpers from `@ravelink/mod-sdk` after installing a locally packed
SDK, or from `packages/mod-sdk` in a source checkout. Declarations are included.

| Export | Contract |
| --- | --- |
| `defineMod(implementation)` | Returns a frozen copy with lifecycle handlers. Requires `activate`; rejects unknown keys and non-function handlers. |
| `createCapabilityClient(context)` | Returns `{call, publish}` wrappers around the supplied context. Validates that call/publication functions exist. |
| `client.call(capability, method, payload = null, options = {})` | Calls `context.callCapability`; resolves validated provider JSON or rejects on broker/transport failure. |
| `client.publish(capability, event, payload = null)` | Calls `context.publishEvent`. Does not acknowledge subscriber delivery; the real worker returns no delivery receipt. |
| `summarizeManifest(manifest)` | Frozen review summary of ID/version, consumes/provides, permissions and resources. Does not validate a package or prove publisher identity. |
| `schemas/manifest-v1` export | JSON Schema for package manifests. |
| `schemas/broker-envelope-v1` export | JSON Schema for IPC envelopes; normal mods use context helpers rather than constructing frames. |

`Json` is null, boolean, number, string, arrays of Json or string-keyed Json
objects. Do not send `undefined`, non-finite numbers, cyclic values, class
instances, functions or raw binary objects as a public payload.

### ModContext

| Field/method | Meaning |
| --- | --- |
| `modId: string` | The installed package identity. |
| `capabilities: readonly string[]` | Provided capabilities. |
| `consumedCapabilities: readonly string[]` | Declared consumed capability names, with optional `?` suffixes removed. |
| `callCapability(capability, method, payload?, {providerId?, timeoutMs?}?)` | Declared consumer call through the broker. Provider selection and request/response validation still apply. |
| `publishEvent(capability, event, payload?)` | Publishes a provided capability event while active. Requires an installed compatible event contract. No replay history or delivery guarantee. |
| `now?: () => number` | Optional clock supplied by the test harness. Production code must fall back to `Date.now()`. |

The context is frozen. Capability calls default to a five-second timeout, bounded
to 10–60,000 ms by the worker and further constrained by the parent request's
remaining deadline and host budgets. `providerId` resolves ambiguity; it does not
bypass permission checks. Do not publish events during activation before the
worker reports active. Bound event rate and payload size.

### Handler types

| Handler | Input | Result |
| --- | --- | --- |
| `activate(context)` | ModContext | `void` or Promise; activation waits for completion. |
| `deactivate()` | None | Optional bounded cleanup; the host can terminate after the declared grace period. |
| `handleRequest(request)` | `{capability, method, payload, signal, deadlineAt}` | JSON or Promise of JSON. Throw/reject to report failure. |
| `handleEvent(event)` | `{capability, event, payload}` | Optional synchronous/async handler; no response payload contract. |

Declare every provided/consumed capability. A package cannot dynamically register
host contracts through its context. Custom inter-mod methods/events require a
compatible contract registered by the host; declaring a string alone does not
make an arbitrary method globally callable. Contributed dashboard actions are
explicitly dispatched to that mod's declared handler and bounded parameter schema.

## Built-in host capabilities

All calls below use `context.callCapability(capability, method, payload, options)`.
They are available only in a mod-enabled composition and with the declared grants.
An absent provider is a normal unavailable condition, not a reason to fall back
to raw sockets, filesystem access or account tokens.

### `ravelink.storage.v1` — provider `ravelink.storage`

Requires `permissions.storage: true` and nonzero `resources.storageBytes`.
Keys match `^[a-z0-9][a-z0-9._-]{0,79}$` and are isolated per mod.

| Method | Payload | Successful reply |
| --- | --- | --- |
| `get` | `{key}` | `{ok:true, found:boolean, value:Json}`; missing keys return `found:false`, `value:null`. |
| `set` | `{key, value}` | `{ok:true, ...}` with key/byte/quota metadata. Atomic replacement of one key. |
| `remove` | `{key}` | `{ok:true, removed:boolean}`. |
| `status` | `{}` or `null` | `{ok:true, ...}` with quota/usage/key metadata. |

Storage is JSON, with at most 250 keys for a mod and the manifest byte quota.
Mutations serialize per mod; multi-key transactions are not provided. Persist
bounded state and explicitly migrate versions. Do not store tokens or another
mod's private state. Failure replies include `storage_permission_denied`,
`storage_quota_exceeded`, `storage_key_limit`, `invalid_storage_key` and corrupt
entry/value errors. The exact storage layout remains host-owned.

### `ravelink.network.v1` — provider `ravelink.network`

Method: `request`. Declare the exact DNS host (optionally `:port`) in
`permissions.network`, consume this capability and request `externalInFlight > 0`.

```js
const result = await context.callCapability("ravelink.network.v1", "request", {
  host: "api.example.com",
  path: "/v1/status",
  method: "GET",
});
if (!result.ok) throw Error(result.error);
// result.status is the HTTP status; result.data is parsed JSON or text.
```

| Input | Bounds/meaning |
| --- | --- |
| `host` | Exact declared public DNS name and optional port; no wildcard or IP literal. |
| `path` | Absolute path starting with `/`, including an optional query; no URL origin, traversal, backslashes or encoded separators. |
| `method` | `GET` (default), `POST`, `PUT`, `PATCH` or `DELETE`. |
| `body` | JSON-serializable non-GET body; at most 64 KiB. |
| `contentType` | Only `application/json` is explicitly forwarded. Arbitrary caller headers are not supported. |

The gateway sends HTTPS, resolves and validates DNS for each connection, pins the
validated address, rejects private/loopback/link-local targets and rejects
redirects. Responses are bounded to 256 KiB; concurrency is at most two and no
higher than the manifest budget. The transport deadline is 250–30,000 ms within
the caller's remaining budget. `{ok:true,status,data,bytes}` describes a completed
HTTP exchange; inspect `status` because HTTP errors are not successful API work.
Failures include `network_permission_denied`, `network_budget_disabled`,
`network_busy`, `network_timeout`, `network_private_address_denied`, invalid/oversized
request/response errors and `network_failed`. Authentication belongs in a reviewed
operation-only host provider, not in a mod-supplied bearer token.

### `ravelink.secrets.v1` — provider `ravelink.secrets`

Method: `invoke`, payload `{handle, operation, payload?}`. The handle must appear in
`permissions.secrets` and be registered by the trusted host. Replies are
`{ok:true,result}` or `{ok:false,error}`. Available handle operations depend on
the composition and connected account; no general-purpose credential handles are
promised. Mods cannot register a secret handle or read/export/reveal its token.
Unknown, unconfigured or undeclared handles and unsupported operations are denied.
Host validators check returned results; audit entries omit secret values/payloads.

### `twitch.clips.host.v1` — provider `ravelink.twitch-clips`

Consumed by the reviewed clip adapter; other approved consumers still require a
mod-enabled host and explicit declaration. Optional Twitch Integration must be
active and authorized for the requested feature.

| Method | Payload | Behavior |
| --- | --- | --- |
| `status` | `{}` | Read connection, scope/configuration and clip availability. No clip is created. |
| `create` | `{title?, duration?}` | Request a clip from the current eligible live broadcast. `title` ≤100 characters; duration 5–60 seconds in 0.1-second steps. |

Treat the service's `ok`/availability/error and actual completion receipt as the
result. Cooldown, user authorization, stream eligibility and Twitch restrictions
remain with the clip owner. Do not retry an uncertain clip write automatically.
Core applies the operator's clip-title moderation before creating a clip, including
calls made by a mod. Default custom-title masking replaces matches with `****`.
`twitch_clip_title_rejected` means no clip was requested and no cooldown consumed.
Mods cannot override this policy in `create`; operators manage it in Connections.
The adapter's provided `stream.clip.v1` interface is separate from this host
contract; use its declared contributed action for dashboard operation.

### Legacy `discord.desktop.host.v1` — provider `ravelink.discord`

Compatibility-only accessibility interface: `status`, `bind`, `toggle`,
`deafenStatus`, `toggleDeafen`, all with `{}` payloads. Results may report
unavailable/unknown controls. This adapter does not start by default in 0.7.6.
Default mute/deafen buttons migrate to native keyboard macros; new buttons can
send F13–F24 or custom combinations. No lifecycle, camera, voice-channel or
Streamer Mode commands are supported. Do not build a new dependency on this
legacy interface or assume it confirms state on every Discord build.

## Manifest field reference

| Field | Contract |
| --- | --- |
| `schemaVersion` | `1`. Unknown top-level fields are rejected. |
| `id`, `publisher` | `<publisher>.<name>` lowercase portable ID; publisher must match the prefix. Publisher text is self-asserted, not a verified signature. |
| `name`, `description`, `license`, `version` | Name ≤80 characters, optional description ≤500, nonempty license and semantic version. |
| `entry` | Relative integrity-listed CommonJS entry; portable package path. |
| `engine` | `{ravelinkModApi, node}` compatible ranges; not the product release number. |
| `activationEvents` | At most 16 unique declared startup triggers. |
| `consumes`, `provides` | At most 32 each; versioned capability names. Optional consumed names may end in `?`. |
| `permissions` | Closed object with `network`, `storage`, `secrets`, `ui`, `process`, `hardware`. Declarations do not create a host provider or bypass runtime containment. |
| `resources` | Every field below is required; active RSS must be at least idle RSS. |
| `contributes` | Optional `actions` and `panels` only. |
| `integrity` | `{algorithm:"sha256",files:{"relative/path":"lowercase SHA-256"}}`; complete inventory excluding the manifest itself. |

| Resource | Allowed range |
| --- | --- |
| `idleCpuPercent` | 0–0.25 |
| `idleRssMiB` / `activeRssMiB` | 8–64 / 8–192 |
| `timers` / `minTimerMs` | 0–8 / 1,000–86,400,000 |
| `ipcFrameBytes` | 1,024–65,536 |
| `inFlightCalls` / `queuedCalls` | 1–4 / 0–32 |
| `externalInFlight` | 0–2 |
| `storageBytes` | 0–8,388,608 |
| `historyEntries` | 0–250 |
| `shutdownGraceMs` | 100–3,000 |

Resource sampling observes sustained breaches and can disable a worker. It is
not a hard operating-system CPU/RAM sandbox. A larger declared timer/frame budget
does not excuse unnecessary polling or unbounded work.

### Dashboard action contributions

Up to 32 actions. Fields: `id`, `title`, optional `description`, `symbol`,
`capability`, `method`, optional `stateMethod`, `defaults`, `parameters`.
The capability must be in `provides`; IDs/methods are bounded identifiers.
Parameter schemas support `type`, `title`, `description`, `properties`, `required`,
`additionalProperties:false`, `enum`, numeric/string bounds, bounded arrays and
`items`. They do not support executable expressions, `oneOf`, arbitrary schema
references or an unrestricted JSON Schema implementation. Nesting depth is at
most four, objects have at most 32 properties, enums/arrays at most 64 entries.

`stateMethod` receives `{}` and must be read-only. Return JSON with an optional
`feedback` object: `{state, label, active, available?, color?}`. Use a short
confirmed label and a hex color. Unknown owner state must remain unknown.
The user's chosen appearance is independent of the mod package. Macros do not
gain permission to execute unavailable actions merely because they were saved.

### Optional panels

Up to four `{id,title,entry}` panels, each requiring `permissions.ui:true` and an
integrity-listed HTML entry, at most 256 KiB. Panels load lazily in opaque-origin
sandboxed frames. Only inline scripts/styles and data images are allowed by the
contribution CSP. There is no network, form submission, parent DOM access or
public interactive panel-to-Core API. Contribute button actions for executable
functions. Do not weaken the iframe sandbox or embed credentials.

## Test harness API

Import `createModTestHarness` from `@ravelink/mod-sdk/testing`.

| Member | Contract |
| --- | --- |
| Constructor options | `modId`, finite `startAt` (zero is valid), `consumes`, `provides`, `providers`. |
| `providers` | Map `"capability/method"` to `(payload,{now,providerId}) => Json/Promise`. Missing providers reject with `provider_unavailable`. |
| `start()` | Calls activate once; returns the fake ModContext. |
| `request(capability,method,payload,signal?)` | Invokes the handler with a fake five-second deadline. Your handler must honor its signal. |
| `emit(capability,event,payload)` | Invokes the optional event handler while active. |
| `now()` / `advance(ms)` | Read/advance the deterministic clock; negative/non-finite advances are rejected. |
| `createClient()` | SDK capability client using the activation context; call after start. |
| `calls`, `events` | Recorded fake calls/publications for assertions. |
| `stop()` | Calls optional deactivate once. |

The fake harness does not emulate IPC isolation, permission validation, automatic
deadline enforcement or the resource monitor. The production package validator,
broker/supervisor regression tests and explicit operator review remain necessary.

## Operator administration HTTP

These are local operator APIs, not callable privileges granted to mods. They
require local admission and matching browser Origin/Host; a public site cannot
use them to install code. Default bundled-only mode rejects community mutations.

| Method/path | Purpose/input |
| --- | --- |
| `GET /api/mod-platform` | Installed lifecycle, approvals, capabilities and inbox snapshot. |
| `GET /api/mod-platform/events` | Bounded management SSE events; close it when no longer needed. |
| `POST /api/mod-platform/discover` | Rescan the inbox without evaluating package code. |
| `POST /api/mod-platform/packages?replace=1` | Raw ZIP body (`application/zip` or octet-stream), 16 MiB maximum; replacement is explicit. |
| `POST /api/mod-platform/inbox/:candidateId/accept` | Review fingerprint, optional `replace` and explicitly accepted `allowUnsafeRuntime`; verified install/approval/activation. |
| `POST /api/mod-platform/:modId/approve` | `{fingerprint}` for the exact current package. |
| `POST /api/mod-platform/:modId/enable` | Explicit activation; reduced-isolation override requires operator review. |
| `POST /api/mod-platform/:modId/disable` | Stop the owned worker and retain package/data. |
| `POST /api/mod-platform/:modId/rollback` | Restore one retained verified version while disabled. |
| `DELETE /api/mod-platform/:modId` | Uninstall; data retained unless explicit `deleteData:true`. |
| `GET /mods-ui/:modId/:panelId` | Integrity-checked sandboxed panel, not a general file server. |

ZIP admission allows at most 32 MiB expanded and applies path, count, ratio and
integrity limits. The [operator security guide](architecture/mod-platform-operator-and-security-guide.md)
describes approval, recovery and residual isolation risks. Review new versions;
never replay installation, external writes or action execution after uncertainty.
