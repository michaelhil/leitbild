# Leitbild

Leitbild is one Workspace-based toolbox with two fixed core Modules:

- **World** — scenarios, Simulation Runs, maps, and capability packs
- **Agents** — Rooms, messages, coordination, Agent profiles, models, tools, memory, and evaluations

Every Workspace has one UUID and provisions both Modules. Modules own their state and runtime mechanics, while the Leitbild Host owns Workspace lifecycle, routing, the shared shell, and cross-Module Resource/Capability discovery. There are no optional product modes, default Workspaces, selection cookies, compatibility APIs, or user-controlled Module installation.

## Repository

- `apps/leitbild` — host, Workspace manager, shared shell, and deployment
- `apps/world` — World runtime and UI
- `apps/agents` — Agents runtime and UI, including Rooms and messaging
- `packages/contracts` — neutral Workspace, Module, Resource, Capability, and Pack contracts
- `packages/integration-tests` — real cross-Module lifecycle and discovery tests

## Commands

```bash
bun install
bun run check
bun run test
bun run deploy -- --dry-run
```

Production is one release on `https://leitbild.app`, with module paths under `/workspaces/{workspaceId}/{world|agents}`.
