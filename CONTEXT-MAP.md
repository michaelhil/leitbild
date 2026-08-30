# Context Map

## Contexts

- [Leitbild Platform](./contexts/platform/CONTEXT.md) — owns Workspace identity, core Module lifecycle, discovery, and product navigation
- [World](./contexts/world/CONTEXT.md) — owns Scenarios, Simulation Runs, operational state, and World Packs
- [Agents](./contexts/agents/CONTEXT.md) — owns Rooms, messages, coordination, AI actors, model routing, tools, context assembly, and evaluations

## Relationships

- **Leitbild Platform → Modules**: provisions every core Module with each Workspace and routes validated Workspace-scoped requests; each Module owns its state.
- **Agents → Modules**: discovers Resources and invokes permitted Capabilities through contracts rather than stored Module-specific links.
- **World → Agents**: publishes typed Resource and Capability descriptors, never internal simulation objects or runtime services.
- **Packs → one Module**: extend exactly one bounded context and publish contributions through that Module.
