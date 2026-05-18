# ADR 0007: Object Context, Scenario, and Mission Model

## Decision

Leitbild adds optional `context` to `OperationalObject` as a structured, perspective-bearing awareness layer.

`domainData` remains the pack-owned domain operational truth. `context` captures facts, activity, references, and summaries from a stated perspective.

Leitbild also introduces separate scenario and mission definition schemas:

- **Scenario Definition** initializes world, active packs, objects, contexts, and pack-keyed provider configuration.
- **Mission Definition** describes goals, objectives, tasks, stages, triggers, actions, and evaluation metrics.
- **Mission Progress State** tracks runtime progress separately from the reusable mission definition.

Domain interaction rules live in packs. Objects carry capabilities, resources, load, capacity, state, and context, but they do not contain executable behavior. A simulation instance may treat an object as the source or subject of an event, then emit ordered `SimulationEvent`s through the adapter.

Scenario Definitions are now the only production startup format for new control instances. Restored control instances are initialized from persisted snapshots/history. Domain seed factories are rejected because they create a second initialization model beside scenarios.

Scenarios are top-level compositions, not pack-owned files. They declare active pack ids, optional provider overrides keyed by pack id, initial operational objects, and provider configs keyed by pack id. The Scenario Catalog resolves those author-facing pack choices into internal provider ids before the Simulation Hub starts providers and gives each provider only its relevant initial objects/config.

Scenario Definitions may include a small declarative Scenario Script. V1 script steps are scheduled relative to control-instance scenario start and may show guidance, hide guidance, highlight objects, clear highlights, upsert objects, or delete objects. Script actions are committed as ordered Domain Events by the Control Instance runtime. Script progress belongs to the running Control Instance snapshot, not to the reusable Scenario Definition.

## Rationale

AI agents, operators, and simulated assets need more than current position and status. They need bounded, structured situation awareness: what is known, remembered, observed, reported, stale, or uncertain.

This awareness must not corrupt canonical simulation truth. Separating `domainData` from `context` preserves replayability, validation, and future multi-perspective studies.

Scenario and mission are also separate concepts. Scenario data initializes a world. Mission data describes operational intent and progression over time.

## Consequences

- Existing snapshots remain valid because `context` is optional.
- Domain packs still own `domainData` schemas.
- Context schemas live in core because the awareness concept is cross-domain.
- Agent context views are derived on demand and are not persisted as canonical state.
- New control instances must be created through a Scenario Definition selected from the scenario catalog.
- Built-in scenarios live at the top level and activate packs through the Scenario Catalog.
- Scenario scripts can drive onboarding/tutorial flow and timed scenario evolution without reintroducing hidden seed factories.
- Scenario guidance/highlights are part of projected state so reloads and multiple clients stay coherent.
- V1 mission logic is declarative and limited; arbitrary scripting is explicitly deferred.
- Future pack manifests may contribute providers, context extensions, and agent-context renderers. Scenario distribution should remain top-level or data-bundle based so multi-pack scenarios do not appear owned by one pack.
- Core does not gain a generic rule engine yet; repeated rule patterns should first emerge in real domain packs.
