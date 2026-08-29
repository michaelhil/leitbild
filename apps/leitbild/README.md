# Leitbild

Leitbild is a research platform for shared, map-based control-center work. It is independently deployable and can optionally share Workspace identity with Samsinn through the suite.

## Architecture

- A **Deployment** owns executable code, built-in Scenario templates, installed Packs, map artifacts, and infrastructure configuration.
- A **Workspace** owns a Scenario Library, Module Bindings, and an isolated set of Simulation Runs.
- A **Scenario** is a reusable Workspace-owned identity.
- A **Scenario Revision** is an immutable, validated startup definition.
- A **Simulation Run** is a persistent execution of exactly one Scenario Revision, addressed by an opaque `run-<uuid>` id.
- A **Pack** contributes optional scenario, runtime, presentation, interaction, reference-data, command, and query surfaces.
- A **Capability Manifest** is derived from configured or active Packs and is never separately persisted.

Every Simulation Run has a manifest that pins its Workspace, Scenario Revision and digest, selected Packs, Pack versions, runtime versions, and creation metadata. Restore either reproduces that pinned configuration or fails visibly.

The canonical language and runtime boundaries are documented in [CONTEXT.md](CONTEXT.md).

## API and URLs

Leitbild exposes one versionless API and no compatibility aliases:

```text
GET  /.well-known/leitbild
GET  /api/workspaces
POST /api/workspaces
PUT  /api/workspaces/{workspaceId}
GET  /api/workspaces/{workspaceId}/capabilities
GET  /api/workspaces/{workspaceId}/scenarios
GET  /api/workspaces/{workspaceId}/simulation-runs
POST /api/workspaces/{workspaceId}/simulation-runs
GET  /api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}
GET  /api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/snapshot
GET  /api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/events
POST /api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/commands
POST /api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/queries
```

The browser uses `/workspaces/{workspaceId}` and `/workspaces/{workspaceId}/simulation-runs/{simulationRunId}`. Workspace and Run ids are explicit in REST and realtime scope, so shared URLs cannot silently resolve into another Workspace.

## Storage

The canonical layout is:

```text
data/
  workspace-directory.json
  workspaces/{workspaceId}/leitbild/
    scenarios/
    simulation-runs/{simulationRunId}/
```

Older Run identities, storage layouts, and persisted shapes are rejected. Leitbild contains no migration or compatibility layer for this cutover.

## Commands

```sh
bun install
bun run check
bun test
bun run build:ui
bun run start
```

Production deployment uses `bun run deploy`. Samsinn and Leitbild retain separate artifacts, services, and release lifecycles.
