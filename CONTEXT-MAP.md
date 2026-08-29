# Context Map

## Contexts

- [Platform](./contexts/platform/CONTEXT.md) — coordinates Workspaces and module discovery without owning application state
- [Samsinn](./apps/samsinn/CONTEXT.md) — multi-agent collaboration inside Rooms
- [Leitbild](./apps/leitbild/CONTEXT.md) — shared operational simulations executed as Simulation Runs

## Relationships

- **Platform → Samsinn**: supplies Workspace identity and the Samsinn module binding; Samsinn owns its Workspace shard.
- **Platform → Leitbild**: supplies Workspace identity and the Leitbild module binding; Leitbild owns scenarios and Simulation Runs in its Workspace shard.
- **Samsinn ↔ Leitbild**: exchange versioned API messages scoped by one shared Workspace Id. Rooms may bind to Simulation Runs by id.
- **Applications → Platform Contracts**: consume identifiers and wire schemas only; application domain models remain private.
