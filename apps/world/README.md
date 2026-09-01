# Leitbild

World is Leitbild's map-based simulation Module. It retains an independent domain boundary and runtime process while shipping as part of the single Leitbild product release.

## Architecture

- A **Deployment** owns executable code, built-in Scenario templates, installed Packs, map artifacts, and infrastructure configuration.
- The **Leitbild Host** owns Workspace identity, naming, and core Module provisioning.
- The **World Module** owns a Workspace-scoped Scenario Library and isolated set of Simulation Runs.
- A **Scenario** is a reusable Workspace-owned identity.
- A **Scenario Revision** is an immutable, validated startup definition.
- A **Simulation Run** is a persistent execution of exactly one Scenario Revision, addressed by an opaque `run-<uuid>` id.
- A **Pack** contributes optional scenario, runtime, presentation, interaction, reference-data, command, and query surfaces.
- A **Capability Manifest** is derived from configured or active Packs and is never separately persisted.

Every Simulation Run has a manifest that pins its Workspace, Scenario Revision and digest, selected Packs, Pack versions, runtime versions, and creation metadata. Restore either reproduces that pinned configuration or fails visibly.

The canonical language and runtime boundaries are documented in the [World context](../../contexts/world/CONTEXT.md).

## API and URLs

The World Module publishes one strict manifest and versionless lifecycle/discovery surface:

```text
GET  /.well-known/workspace-module
PUT|DELETE /internal/workspaces/{workspaceId}
GET  /internal/workspaces/{workspaceId}/resources
GET  /internal/workspaces/{workspaceId}/capabilities
POST /internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke
```

The specialized Leitbild UI and API remain explicitly Workspace-scoped:

```text
GET  /api/workspaces/{workspaceId}/world/capabilities
GET  /api/workspaces/{workspaceId}/world/scenarios
GET  /api/workspaces/{workspaceId}/world/simulation-runs
POST /api/workspaces/{workspaceId}/world/simulation-runs
GET  /api/workspaces/{workspaceId}/world/simulation-runs/{simulationRunId}
GET  /api/workspaces/{workspaceId}/world/simulation-runs/{simulationRunId}/snapshot
GET  /api/workspaces/{workspaceId}/world/simulation-runs/{simulationRunId}/events
POST /api/workspaces/{workspaceId}/world/simulation-runs/{simulationRunId}/commands
POST /api/workspaces/{workspaceId}/world/simulation-runs/{simulationRunId}/queries
```

The browser uses `/workspaces/{workspaceId}/world` and `/workspaces/{workspaceId}/world/runs/{simulationRunId}`. Root navigation returns to the Leitbild Host. There is no local Workspace picker, selection cookie, default Workspace, or Workspace creation endpoint.

## Storage

The canonical layout is:

```text
data/
  workspaces/{workspaceId}/world/
    workspace.json
    scenarios/
    simulation-runs/{simulationRunId}/
```

The marker exists only after Host lifecycle provisioning. Older identities, storage layouts, and persisted shapes are rejected. Leitbild contains no migration or compatibility layer.

## Commands

```sh
bun install
bun run check
bun test
bun run build:ui
bun run start
```

`WORKSPACE_HOST_URL` is required for HTTP startup. Production is built, tested, and deployed atomically from the repository root.
