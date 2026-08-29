# Context Map

## Contexts

- [Workspace Platform](./contexts/platform/CONTEXT.md) — owns Workspace identity, Module Membership, discovery, and product composition
- [Microworld](./contexts/microworld/CONTEXT.md) — owns scenarios, Simulation Runs, operational state, and simulation Packs
- [Collaboration](./contexts/collaboration/CONTEXT.md) — owns Rooms, membership, messages, and collaboration scripts
- [Agents](./contexts/agents/CONTEXT.md) — owns AI actors, model routing, tools, context assembly, and evaluations

## Relationships

- **Workspace Platform → Modules**: creates and removes Module Membership and routes validated Workspace-scoped requests; each Module owns its state.
- **Agents → Modules**: discovers Resources and invokes permitted Capabilities through contracts rather than stored Module-specific links.
- **Collaboration ↔ Modules**: may use an explicit Binding when continuous system behavior, such as mirroring a Run into a Room, must persist.
- **Microworld → Agents and Collaboration**: publishes typed Resource and Capability descriptors, never internal simulation objects or runtime services.
- **Packs → one Module**: extend exactly one bounded context and publish contributions through that Module.
