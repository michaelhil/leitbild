# Leitbild Discovery Manifest

## 1. Purpose

`GET /.well-known/leitbild` is the deployment discovery entrypoint for clients that need to find Leitbild's callable V1 surfaces before opening API or realtime connections. It is not a health check and it is not full API documentation. Health endpoints report runtime condition; API docs explain request/response details; this manifest tells a client what this deployment publishes and where to start.

The `.well-known` location is deliberate: it gives another system one stable URL to probe on any Leitbild origin.

## 2. Stability and Versioning

`manifestSchemaVersion` versions the discovery manifest contract. `identity.implementationVersion` reports the running Leitbild package version.

V1 should evolve additively where possible. Breaking changes require a new `manifestSchemaVersion` and matching schema changes in `src/core/api/discovery.ts`.

## 3. Endpoint

`GET /.well-known/leitbild` returns `application/json`.

Responses include `Cache-Control: max-age=60, must-revalidate` and a weak `ETag`. The ETag is computed from the manifest body with `generatedAt` excluded, so clients can use conditional GET without cache churn from the timestamp alone.

## 4. Client Identification

Clients may send normal `User-Agent` and the planned `Leitbild-Client` header now. V1 does not enforce, persist, authorize, or rate-limit by these headers.

## 5. Manifest Shape

The manifest is grouped around deployment identity, current auth and CORS posture, link relations, actions, HTTP and WebSocket protocol facts, realtime semantics, client-identification posture, deployment-level capabilities, planned wiki reference placement, unpublished limits, and planned future surfaces.

Deployment-level capabilities include flags for scenario catalog discovery, Control Instance registry and lifecycle actions, clock control, map capabilities, durable event catch-up, live change feed, pack queries, commands, interaction signals, and per-Control-Instance capability manifests.

For exact field names, literals, and validation rules, use `discoveryManifestSchema` in `src/core/api/discovery.ts`.

## 6. Link Relations

Only currently callable relations are listed under `links`. Planned hooks stay under `planned` until implemented.

| Rel | Purpose |
| --- | --- |
| `self` | This manifest. |
| `scenarios` | Scenario catalog listing. |
| `controlInstances` | Control Instance registry. |
| `controlInstance` | Control Instance snapshot envelope by id. |
| `controlInstanceSnapshot` | Current projected snapshot by id. |
| `controlInstanceEvents` | Durable journal catch-up by id. |
| `controlInstancePackQueries` | Read-only pack query endpoint by id. |
| `controlInstanceCapabilities` | Coarse active capability manifest by id. |
| `controlInstanceCommands` | Validated command endpoint by id. |
| `controlInstanceSignals` | Interaction signal endpoint by id. |
| `controlInstanceReset` | Control Instance reset endpoint by id. |
| `controlInstanceClock` | Control Instance clock-control endpoint by id. |
| `realtime` | WebSocket transport. |
| `mapCapabilities` | Vector map capability manifest. |
| `mapStyle` | Vector map style. |
| `docs` | This prose document in the repository. |

## 7. Actions

`actions` separates method semantics from URL navigation in `links`. The manifest does not enumerate request body schemas; those remain with the route definitions and API documentation. Runtime state is also not encoded in the manifest: for example, `controlInstanceDelete` uses `DELETE` but returns `409` when clients are connected.

| Action | Link Rel | Method | Description |
| --- | --- | --- | --- |
| `controlInstanceCreate` | `controlInstances` | `POST` | Create a Control Instance from an optional scenario id. |
| `controlInstanceEnsure` | `controlInstance` | `POST` | Ensure a named Control Instance exists, optionally with a scenario id. |
| `controlInstanceDelete` | `controlInstance` | `DELETE` | Delete an idle Control Instance. The server rejects deletion while clients are connected. |
| `controlInstanceReset` | `controlInstanceReset` | `POST` | Reset a Control Instance to a scenario baseline. |
| `controlInstanceClockUpdate` | `controlInstanceClock` | `POST` | Update pause state, speed, or current time for a Control Instance. |
| `controlInstanceCapabilitiesRead` | `controlInstanceCapabilities` | `GET` | Read coarse runtime capabilities for an existing Control Instance. |

## 8. CORS Posture

The V1 manifest reports CORS as not configured. Browser-direct cross-origin access is not a published contract yet; deployment-specific reverse proxy behavior should not be treated as a manifest guarantee.

## 9. Realtime Semantics

V1 exposes one mixed WebSocket stream per Control Instance. When a client joins an existing stream, Leitbild sends `realtime.ready`. Live Control Instance Domain Events are then delivered as `events` batches.

Before `POST /api/control-instances/{id}/reset` wipes the current runtime, Leitbild emits a durable `controlInstance.reset` Domain Event in the live feed. The event includes `previousSeq`, optional `previousScenarioId`, and optional post-reset target `scenarioId`; consumers should treat it as an explicit epoch boundary and refetch the snapshot.

Durable catch-up is through the `controlInstanceEvents` relation. Realtime channel filtering is explicitly planned, not supported in V1.

## 10. Per-Control-Instance Capabilities

`GET /api/control-instances/{id}/capabilities` returns the coarse callable surface for one loaded Control Instance. It returns `404` when the Control Instance does not exist or is not loaded.

Response shape:

```json
{
  "controlInstanceId": "oslo-ambulance:run-20260524-120000",
  "scenarioId": "oslo-ambulance",
  "activePackIds": ["ambulance", "traffic", "weather"],
  "acceptedCommandKinds": ["ambulance.set_destination"],
  "queryKinds": {
    "ambulance": ["ambulance.objects", "ambulance.object", "ambulance.dispatchState"]
  },
  "wikiRefs": []
}
```

This is intentionally coarse in V2.D-min. `scenarioId` and `activePackIds` come from the Control Instance scenario runtime. `acceptedCommandKinds` comes from the active simulation providers' declared command kinds. `queryKinds` lists static query kind strings where the active pack's provider declares them; it does not publish payload schemas. `wikiRefs` is reserved for later pack-declared references and is empty for now.

The endpoint does not serialize Zod schemas or per-action payload contracts. Clients such as Samsinn should keep using generic command/query calls and treat this response as discovery, not typed validation metadata.

## 11. Auth Posture

V1 discovery reports unauthenticated access with `modes: ["none"]`. Bearer auth is listed only as planned.

## 12. Examples

Full V1 response, serialized from `buildManifest("https://leitbild.example")` and valid against `discoveryManifestSchema`:

```json
{
  "manifestSchemaVersion": "1.0.0",
  "generatedAt": "2026-05-24T12:00:00.000Z",
  "identity": {
    "implementation": "leitbild",
    "implementationVersion": "0.1.0",
    "title": "Leitbild",
    "operator": "unknown",
    "deploymentId": "unknown"
  },
  "auth": {
    "posture": "unauthenticated",
    "modes": ["none"],
    "notes": "V1 publishes discovery without authentication. API write paths are still validated at the request boundary."
  },
  "cors": {
    "posture": "not-configured",
    "browserDirectAccess": false,
    "notes": "V1 does not publish a cross-origin browser access contract."
  },
  "links": {
    "self": { "href": "https://leitbild.example/.well-known/leitbild" },
    "scenarios": { "href": "https://leitbild.example/api/scenarios" },
    "controlInstances": { "href": "https://leitbild.example/api/control-instances" },
    "controlInstance": { "hrefTemplate": "https://leitbild.example/api/control-instances/{id}" },
    "controlInstanceSnapshot": { "hrefTemplate": "https://leitbild.example/api/control-instances/{id}/snapshot" },
    "controlInstanceEvents": { "hrefTemplate": "https://leitbild.example/api/control-instances/{id}/events{?afterSeq}" },
    "controlInstancePackQueries": { "hrefTemplate": "https://leitbild.example/api/control-instances/{id}/queries" },
    "controlInstanceCapabilities": { "hrefTemplate": "https://leitbild.example/api/control-instances/{id}/capabilities" },
    "controlInstanceCommands": { "hrefTemplate": "https://leitbild.example/api/control-instances/{id}/commands" },
    "controlInstanceSignals": { "hrefTemplate": "https://leitbild.example/api/control-instances/{id}/signals" },
    "controlInstanceReset": { "hrefTemplate": "https://leitbild.example/api/control-instances/{id}/reset" },
    "controlInstanceClock": { "hrefTemplate": "https://leitbild.example/api/control-instances/{id}/clock" },
    "realtime": {
      "href": "wss://leitbild.example/ws",
      "hrefTemplate": "wss://leitbild.example/ws?controlInstance={id}"
    },
    "mapCapabilities": { "href": "https://leitbild.example/map/capabilities.json" },
    "mapStyle": { "href": "https://leitbild.example/map/style.json" },
    "docs": { "href": "https://github.com/michaelhil/leitbild/blob/main/docs/discovery.md" }
  },
  "actions": {
    "controlInstanceCreate": {
      "status": "implemented",
      "linkRel": "controlInstances",
      "method": "POST",
      "description": "Create a Control Instance from an optional scenario id."
    },
    "controlInstanceEnsure": {
      "status": "implemented",
      "linkRel": "controlInstance",
      "method": "POST",
      "description": "Ensure a named Control Instance exists, optionally with a scenario id."
    },
    "controlInstanceDelete": {
      "status": "implemented",
      "linkRel": "controlInstance",
      "method": "DELETE",
      "description": "Delete an idle Control Instance. The server rejects deletion while clients are connected."
    },
    "controlInstanceReset": {
      "status": "implemented",
      "linkRel": "controlInstanceReset",
      "method": "POST",
      "description": "Reset a Control Instance to a scenario baseline."
    },
    "controlInstanceClockUpdate": {
      "status": "implemented",
      "linkRel": "controlInstanceClock",
      "method": "POST",
      "description": "Update pause state, speed, or current time for a Control Instance."
    },
    "controlInstanceCapabilitiesRead": {
      "status": "implemented",
      "linkRel": "controlInstanceCapabilities",
      "method": "GET",
      "description": "Read coarse runtime capabilities for an existing Control Instance."
    }
  },
  "protocols": {
    "http": {
      "status": "implemented",
      "baseUrl": "https://leitbild.example",
      "apiBasePath": "/api",
      "version": "v1",
      "contentType": "application/json"
    },
    "webSocket": {
      "status": "implemented",
      "messageEncoding": "json",
      "linkRel": "realtime"
    }
  },
  "realtime": {
    "status": "implemented",
    "model": "one-mixed-stream-per-control-instance",
    "transportLinkRel": "realtime",
    "serverMessages": [
      {
        "type": "realtime.ready",
        "description": "Sent when a client joins an existing Control Instance stream."
      },
      {
        "type": "events",
        "description": "Batch of Control Instance Domain Events from the live feed."
      },
      {
        "type": "controlInstance.reset",
        "description": "Durable boundary event sent in an events batch before a Control Instance reset wipes the current runtime."
      }
    ],
    "durableCatchup": {
      "linkRel": "controlInstanceEvents",
      "description": "Returns durable journal events after a sequence number."
    }
  },
  "clientIdentification": {
    "status": "planned",
    "headers": {
      "User-Agent": "Standard HTTP user agent.",
      "Leitbild-Client": "Structured client identity, for example: samsinn; version=\"0.1.0\"."
    },
    "notes": "Clients may send these headers now, but Leitbild does not yet enforce, persist, authorize, or rate-limit by them."
  },
  "capabilities": {
    "status": "implemented",
    "deploymentLevel": {
      "scenarioCatalog": true,
      "controlInstanceRegistry": true,
      "controlInstanceLifecycle": true,
      "clockControl": true,
      "mapCapabilityManifest": true,
      "durableEventCatchup": true,
      "liveChangeFeed": true,
      "packQueries": true,
      "commands": true,
      "interactionSignals": true,
      "perControlInstanceCapabilities": true
    }
  },
  "wikiRefs": {
    "status": "planned",
    "scope": "per-control-instance-pack",
    "notes": "Authoritative wiki recommendations should live on the planned per-Control-Instance capability manifest because active packs and scenarios vary by Control Instance."
  },
  "limits": {
    "status": "not-published",
    "notes": "V1 does not publish rate, size, or retention limits."
  },
  "planned": {
    "authModes": ["bearer"],
    "cors": {
      "allowedOrigins": ["deployment-configured"],
      "allowedMethods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      "exposedHeaders": ["ETag"]
    },
    "clientIdentificationEnforcement": true,
    "realtimeChannelFiltering": {
      "plannedNames": ["journal", "alarms", "signals", "telemetry"]
    },
    "sourceTelemetryThrottling": true
  }
}
```

Minimal client bootstrap:

```ts
const manifestResponse = await fetch('https://leitbild.example/.well-known/leitbild')
const manifest = await manifestResponse.json()
const scenariosResponse = await fetch(manifest.links.scenarios.href)
const scenarios = await scenariosResponse.json()
```

Samsinn read-only bootstrap:

```ts
const manifestResponse = await fetch('https://leitbild.example/.well-known/leitbild', {
  headers: {
    'Leitbild-Client': 'samsinn; version="0.1.0"',
  },
})
const manifest = await manifestResponse.json()
const eventsUrl = manifest.links.controlInstanceEvents.hrefTemplate
  .replace('{id}', encodeURIComponent('sandbox'))
  .replace('{?afterSeq}', '?afterSeq=0')
const eventsResponse = await fetch(eventsUrl)
const events = await eventsResponse.json()
```

## 13. Schema Source of Truth + Change Process

`src/core/api/discovery.ts` is normative. JSON Schema, generated examples, and compatibility checks should derive from its Zod schema. This document explains intent and client expectations; it must not redefine constraints independently.

When the manifest changes, update the Zod schema first, then tests, then this prose. Additive changes can stay on `1.0.0`; breaking changes require an explicit schema-version bump.
