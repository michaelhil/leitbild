# Leitbild discovery and integration contract

Leitbild publishes one strict, versionless discovery document:

```text
GET /.well-known/leitbild
```

Consumers must validate the complete document and follow its links. Leitbild does not negotiate API versions, publish alternate route families, or accept guessed response shapes.

## Shape

```json
{
  "generatedAt": "2026-08-29T12:00:00.000Z",
  "module": {
    "id": "leitbild",
    "title": "Leitbild",
    "implementationVersion": "0.1.0"
  },
  "workspaceScope": {
    "mode": "path",
    "pathTemplate": "https://leitbild.example/api/workspaces/{workspaceId}"
  },
  "access": {
    "posture": "open",
    "modes": ["open"]
  },
  "links": {
    "self": "https://leitbild.example/.well-known/leitbild",
    "workspaces": "https://leitbild.example/api/workspaces",
    "workspace": "https://leitbild.example/api/workspaces/{workspaceId}",
    "capabilities": "https://leitbild.example/api/workspaces/{workspaceId}/capabilities",
    "scenarios": "https://leitbild.example/api/workspaces/{workspaceId}/scenarios",
    "scenario": "https://leitbild.example/api/workspaces/{workspaceId}/scenarios/{scenarioId}",
    "simulationRuns": "https://leitbild.example/api/workspaces/{workspaceId}/simulation-runs",
    "simulationRun": "https://leitbild.example/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}",
    "simulationRunSnapshot": "https://leitbild.example/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/snapshot",
    "simulationRunEvents": "https://leitbild.example/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/events{?afterSeq}",
    "simulationRunPackQueries": "https://leitbild.example/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/queries",
    "simulationRunCapabilities": "https://leitbild.example/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/capabilities",
    "simulationRunCommands": "https://leitbild.example/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/commands",
    "simulationRunSignals": "https://leitbild.example/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/signals",
    "simulationRunReset": "https://leitbild.example/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/reset",
    "simulationRunClock": "https://leitbild.example/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/clock",
    "realtime": "wss://leitbild.example/api/workspaces/{workspaceId}/ws?simulationRun={simulationRunId}"
  }
}
```

`implementationVersion` identifies the deployed build for diagnostics. It does not select another API.

## Workspace contract

The suite or another coordinator may provision the same opaque Workspace UUID in multiple Modules:

```http
PUT /api/workspaces/{workspaceId}
Content-Type: application/json

{
  "displayName": "Exercise Alpha",
  "modules": [
    {
      "moduleId": "leitbild",
      "baseUrl": "https://leitbild.example",
      "discoveryUrl": "https://leitbild.example/.well-known/leitbild"
    },
    {
      "moduleId": "samsinn",
      "baseUrl": "https://samsinn.example",
      "discoveryUrl": "https://samsinn.example/.well-known/samsinn"
    }
  ]
}
```

The first call returns `201`; an identical repeat returns `200`. A display-name conflict returns structured `409`. Module Bindings belong to the Workspace Directory; Leitbild does not copy topology into Scenarios or Simulation Runs.

## Capability scopes

`GET /api/workspaces/{workspaceId}/capabilities` returns the generic Capability Manifest derived from Packs configured for that Workspace.

`GET /api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/capabilities` returns the richer Run-specific command and query surface derived from the Run's pinned active Pack runtimes.

The two scopes are complementary: Workspace capabilities answer what the Module can make available; Run capabilities answer what is callable now.

## Event and reset semantics

Run events have monotonically increasing sequence numbers. Consumers resume with the `afterSeq` query and deduplicate by sequence.

Before reset replaces projected runtime state, Leitbild emits a durable `simulationRun.reset` event. Consumers treat it as an epoch boundary, discard cached projections, fetch a new snapshot, and then resume events after the snapshot sequence.

## Access and embedding

The discovery `access` object describes current posture only; it does not grant authority. Access policy is enforced by the application boundary.

Leitbild permits its approved Samsinn origins through `frame-ancestors` so the Samsinn UI can embed a Run. Direct integrations should prefer the API and realtime links rather than scraping the UI.

## Failure policy

- Missing required links are fatal to an integration client.
- Unknown fields and malformed values fail strict validation.
- Unknown Workspace or Run ids return structured `404` responses.
- Scope mismatches never fall back to a default Workspace.
- Removed unscoped routes return `404`; there are no redirects or aliases.
