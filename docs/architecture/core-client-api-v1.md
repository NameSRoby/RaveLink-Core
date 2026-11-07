# Core client API v1

Implemented 2026-10-10 for the JavaFX readiness checkpoint. This is a local HTTP contract for the existing Core workflows, independent of the product release version and optional feature versions. Node remains independently bootable; the recovery HUD retains its existing routes.

## Connecting and compatibility

1. Read `GET /system/client-api`. Save its `serverInstanceId`, `apiVersion` and `contractRevision`. Capability flags describe the current server composition, including absent optional hosts.
2. Send `POST /system/client-api/negotiate` with `{"apiMajor":1,"minimumMinor":0,"requiredOperations":["health","fixtures.list","lights.apply"]}`. Compatible requests return 200 and `compatible:true`. A different major, unavailable minimum minor or unknown required operation returns 409 and `compatible:false`. Invalid request shapes return 400. Negotiation is stateless and grants no additional permissions.
3. Load `GET /system/client-api/contracts`, or use the identical [published contract artifact](../contracts/core-client-api-v1.json). [Request/response fixtures](../../test/fixtures/core-client-v1.json) provide examples for every operation. The schemas use the existing bounded JSON Schema subset: types, constants, enums, properties, required fields, additional properties, items and numeric/string/array bounds. They do not require Java to import Node implementation code.

Breaking changes require a new API major. Additive operations use a newer minor; clients check their required operations and ignore unknown response fields. A changed schema digest refreshes cached models/metadata and is not, on its own, a breaking-change declaration. A changed server instance means restart: discard runtime-derived state and optional feature leases, refresh capabilities and settings, and preserve unsaved user intent separately.

The server generates one instance ID per boot, holds no client session list, and starts no polling or negotiation timer. Clients may coexist without becoming server owners. Optional feature calls/events continue through their supervised contracts; Core v1 does not replace those owners or promise a Core SSE stream.

## Current operations

Each operation's canonical path, method, request/response schemas and suggested client deadline are in the artifact. Paths have the form `/api/core/v1/<operation>`; read operations with no payload use GET, and the remaining operations use POST with an object payload.

| Workflow | Operation IDs |
| --- | --- |
| Health | `health` |
| Fixtures | `fixtures.list`, `fixtures.edit`, `fixtures.upsert`, `fixtures.delete`, `fixtures.test` |
| Lights | `lights.apply` |
| Widget | `widget.status`, `widget.get`, `widget.rebuild`, `widget.clear-token` |
| Updates | `updates.status`, `updates.configure`, `updates.check`, `updates.download`, `updates.apply`, `updates.rollback` |

These routes validate before forwarding to the existing owners; they do not implement a second lighting engine, fixture registry, token vault or updater. Fixture creation requires an explicit ID and brand. Fixture list/upsert replies contain configured flags rather than credentials or network addresses. Explicit local fixture editing retains the existing address reveal. Widget status projects only the security status; token-bearing generated scripts remain explicit local actions and must not be logged or stored in diagnostics. Widget rebuilding rotates the scoped token and must never be replayed automatically.

Unsupported advanced fixture extras, discovery/pairing wizards, lighting profile/layout administration and feature operations are not implied by this initial v1 surface. Those existing workflows retain their current owners and can receive additive contracts as native parity progresses. Update support does not mean an update is ready: read update status, including `hosted`, staged verification and rollback availability, before presenting an action.

## Bounds, errors and reconnect

Requests use the existing 64 KiB JSON parser ceiling and an additional bounded value/schema check. Replies are limited to 512 KiB, 12 levels and 16,384 JSON values; fixture lists contain at most 256 records and explicit light selections at most 64 IDs. Versioned request objects reject unknown fields; response objects permit additive fields within the overall limits. Schemas and handshake metadata are fixed, finite documents.

All v1 routes require a local connection. Browser origins must match the serving origin. The existing write-security middleware remains in front of the adapter. Cross-origin/remote denial is 403. Invalid JSON and oversized input retain the existing parser errors (`invalid json payload`, `payload too large`) and 400/413 statuses. Schema rejection is 400 with `client_api_request_invalid` and occurs before domain effects. Unknown operations return 404.


An invalid or oversized owner reply produces 502 `client_api_response_invalid`; a mutating operation includes `outcome:"unknown"` because validation cannot undo an action already executed. A network timeout or connection loss similarly does not prove that a write failed. No server-side replay, retry queue or compatibility shim resends an action.

Only operations marked `readOnly:true` are eligible for automatic read retry, including bounded fixture probes and widget retrieval with an already supplied token. Honor `Retry-After` on 429. Use the published operation deadlines, cancellation and bounded exponential reconnect backoff (for example 250 ms up to 10 seconds, with jitter). A client timeout cancels its wait; it does not promise cancellation of server/hardware work. After reconnect, negotiate again, refresh observed state and let the operator explicitly decide whether to repeat an uncertain write. Updates, fixture mutations, lights and token rotation are never automatically retried.

## Maintenance and evidence

The authoritative definitions are `src/domains/system/core-client-contracts.js`; `node scripts/build-core-client-contracts.js` publishes the JSON artifact, and `--check` detects drift. The shared validator preserves the existing feature-contract validation behavior while keeping Core independent of the optional feature platform.

`test/core-client-api.http.test.js` covers artifact/fixture conformance, old/new/unsupported negotiation, separate server instances, origin rejection, real dry-run fixture/light/widget/update workflows, rejection before mutation, response bounds, uncertain write replies and exception redaction. Existing Core and supervised feature regressions remain part of standard verification. Physical output, real OBS/Twitch acceptance and signed release-machine testing remain separate acceptance work.
