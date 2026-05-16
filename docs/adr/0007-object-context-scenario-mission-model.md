# ADR 0007: Object Context, Scenario, and Mission Model

## Decision

Leitbild adds optional `context` to `OperationalObject` as a structured, perspective-bearing awareness layer.

`domainData` remains the pack-owned domain operational truth. `context` captures facts, activity, references, and summaries from a stated perspective.

Leitbild also introduces separate scenario and mission definition schemas:

- **Scenario Definition** initializes world, objects, contexts, and simulator configuration.
- **Mission Definition** describes goals, objectives, tasks, stages, triggers, actions, and evaluation metrics.
- **Mission Progress State** tracks runtime progress separately from the reusable mission definition.

Domain interaction rules live in simulation/domain packs. Objects carry capabilities, resources, load, capacity, state, and context, but they do not contain executable behavior. A simulation instance may treat an object as the source or subject of an event, then emit ordered `SimulationEvent`s through the adapter.

## Rationale

AI agents, operators, and simulated assets need more than current position and status. They need bounded, structured situation awareness: what is known, remembered, observed, reported, stale, or uncertain.

This awareness must not corrupt canonical simulation truth. Separating `domainData` from `context` preserves replayability, validation, and future multi-perspective studies.

Scenario and mission are also separate concepts. Scenario data initializes a world. Mission data describes operational intent and progression over time.

## Consequences

- Existing snapshots remain valid because `context` is optional.
- Domain packs still own `domainData` schemas.
- Context schemas live in core because the awareness concept is cross-domain.
- Agent context views are derived on demand and are not persisted as canonical state.
- V1 mission logic is declarative and limited; arbitrary scripting is explicitly deferred.
- Future pack manifests may contribute scenarios, missions, context extensions, and agent-context renderers.
- Core does not gain a generic rule engine yet; repeated rule patterns should first emerge in real domain packs.
