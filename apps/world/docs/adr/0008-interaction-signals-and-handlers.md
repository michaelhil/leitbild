# ADR 0008: Interaction Signals and Registered Handlers

## Decision

Leitbild will model cross-object, cross-simulation, and AI-observed interaction through a simulation-run-scoped interaction layer.

The interaction layer uses:

- **Interaction Signals** for claims, observations, recommendations, or interaction attempts.
- **Interaction Handlers** for deterministic interpretation of signals against the current simulation-run snapshot.
- **Interaction Effects** for constrained proposed results.
- **Domain Events** for accepted canonical history after runtime validation, ordering, persistence, and broadcast.
- **Operational Notifications** for durable attention items visible to operators, AI agents, replay, and debugging.

Objects do not directly call or mutate other objects. Pack runtimes, actors, clients, AI agents, and system processes may emit signals. Registered handlers inspect signals and current state, then return effects. The Simulation Run runtime commits accepted effects as ordered domain events.

Simulation Run Projected State is the canonical current Leitbild truth for shared operational objects. The Durable Journal records meaningful accepted history. Simulation providers may keep private mechanics and provider-local projections, but they learn about accepted shared state by observing committed Simulation Run events. They are not mutated through a second authoritative object-state path.

V1 will use static, trusted handler registration from built-in packs. Dynamic external handler loading is deferred. Route-impact handling may warn and update canonical route-awareness state, but automatic rerouting is deferred until explicit human, AI, or scenario policy control exists.

Scenario scripts may emit interaction signals as declarative data. A scenario-emitted signal enters the same runtime handling path as a simulation-emitted or API-submitted signal: the simulation-run runtime records `interaction.signal.received`, active handlers inspect the current snapshot, and only accepted effects become ordered domain events. This keeps scenario tutorials and demos from bypassing the interaction model.

V1 also defines the generic operational-demand signal type:

```text
operational.demand.requested
```

Its payload declares a capability need at a point location, with demand id, capability, optional source object, quantity, severity, title, and description. The first concrete capability is `medical.transport`. The ambulance pack handles that capability by idempotently creating an incident target and emitting an operational notification. The requesting pack does not know ambulance internals, and ambulance does not need process-plant-specific code.

## Rationale

Leitbild needs interactions such as ambulance-arrives-at-incident, ambulance-arrives-at-hospital, hospital-capacity-changed, drone-observation-detected, and AI-recommendation-created. These interactions may involve two objects, many objects, multiple Pack runtimes, operators, and AI agents.

Direct object-to-object mutation would hide side effects, make replay difficult, and couple domain packs together. A central god orchestrator would be simple at first but would pull domain-specific rules into core.

The chosen model follows useful patterns from event-sourced systems, Redux/Elm-style data flow, actor systems, game event systems, and workflow engines:

- input events/signals are data,
- state changes are explicit and replayable,
- objects are state-bearing entities, not hidden executable actors,
- handlers are registered systems that interpret state and events,
- correlation and causation can explain multi-step interactions,
- derived UI and AI views do not become canonical truth.

## Consequences

- The simulation run remains the boundary for ordering, routing, persistence, audit, and broadcast.
- Interaction handlers read the canonical Simulation Run snapshot, not provider-private state.
- Simulation providers observe committed events to adapt private mechanics; this observation is not a canonical write path.
- Core validates the signal/effect envelopes but does not understand every domain payload.
- Packs validate and handle domain-specific signal payloads.
- AI-generated signals are treated as untrusted input until a registered handler accepts them.
- Unknown signals may be persisted for audit, but they must not mutate canonical state.
- Handler-local mutable memory is disallowed; durable memory belongs in object state, object context, mission progress, or the Durable Journal.
- Handler-emitted follow-up signals and command requests are deferred until loop guards, causation tracking, and TTL semantics are implemented.
- V1 effects should stay small: object upsert, object delete, and notification emit.
- Traffic route-impact handlers must not silently reroute mobile assets; rerouting is a command or future declared policy.
- Cross-pack service requests should prefer capability-based demand signals over direct pack-to-pack calls. A future responder pack can handle the same demand capability without changing the request source.

## Rejected Alternatives

### Object-local behavior

Each object could own behavior and mutate related objects directly.

Rejected because multi-object and cross-simulation interactions would become race-prone and hard to replay. Objects remain data. They may be the source or subject of a signal, but they do not execute hidden behavior.

### Central domain orchestrator

One central orchestrator could own all rules.

Rejected as the long-term architecture because it would either become a god module or force ambulance, drone, police, maritime, and other domain rules into core. The simulation-run runtime should own sequencing and commit, while packs own domain interpretation.

### Loose callback event bus

Any module could subscribe to events and mutate state.

Rejected because it produces callback spaghetti, unclear ordering, and weak auditability. Handlers return effects; only the runtime commits effects.

### Mirroring effects back into providers as authoritative state

The runtime could apply interaction effects directly back into simulation providers.

Rejected as the long-term model because it implies duplicate canonical object stores. Providers may observe committed events and update private projections, but Simulation Run Projected State remains the shared source of truth.

### Arbitrary scripting engine

Missions or packs could define scripts that mutate state.

Rejected for V1 because it creates security, testability, replay, and AI-safety risks. Declarative signals and constrained effects are enough for the initial interaction layer.
