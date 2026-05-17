# ADR 0008: Interaction Signals and Registered Handlers

## Decision

Leitbild will model cross-object, cross-simulation, and AI-observed interaction through a control-instance-scoped interaction layer.

The interaction layer uses:

- **Interaction Signals** for claims, observations, recommendations, or interaction attempts.
- **Interaction Handlers** for deterministic interpretation of signals against the current control-instance snapshot.
- **Interaction Effects** for constrained proposed results.
- **Domain Events** for accepted canonical history after runtime validation, ordering, persistence, and broadcast.
- **Operational Notifications** for durable attention items visible to operators, AI agents, replay, and debugging.

Objects do not directly call or mutate other objects. Simulation instances, actors, clients, AI agents, and system processes may emit signals. Registered handlers inspect signals and current state, then return effects. The control-instance runtime commits accepted effects as ordered domain events.

The Control Instance event log and projected state are the canonical Leitbild truth for shared operational objects. Simulation providers may keep private mechanics and provider-local projections, but they learn about accepted shared state by observing committed Control Instance events. They are not mutated through a second authoritative object-state path.

V1 will use static, trusted handler registration from built-in packs. Dynamic external handler loading is deferred. Route-impact handling may warn and update canonical route-awareness state, but automatic rerouting is deferred until explicit human, AI, or scenario policy control exists.

## Rationale

Leitbild needs interactions such as ambulance-arrives-at-incident, ambulance-arrives-at-hospital, hospital-capacity-changed, drone-observation-detected, and AI-recommendation-created. These interactions may involve two objects, many objects, multiple simulation instances, operators, and AI agents.

Direct object-to-object mutation would hide side effects, make replay difficult, and couple domain packs together. A central god orchestrator would be simple at first but would pull domain-specific rules into core.

The chosen model follows useful patterns from event-sourced systems, Redux/Elm-style data flow, actor systems, game event systems, and workflow engines:

- input events/signals are data,
- state changes are explicit and replayable,
- objects are state-bearing entities, not hidden executable actors,
- handlers are registered systems that interpret state and events,
- correlation and causation can explain multi-step interactions,
- derived UI and AI views do not become canonical truth.

## Consequences

- The control instance remains the boundary for ordering, routing, persistence, audit, and broadcast.
- Interaction handlers read the canonical Control Instance snapshot, not provider-private state.
- Simulation providers observe committed events to adapt private mechanics; this observation is not a canonical write path.
- Core validates the signal/effect envelopes but does not understand every domain payload.
- Packs validate and handle domain-specific signal payloads.
- AI-generated signals are treated as untrusted input until a registered handler accepts them.
- Unknown signals may be persisted for audit, but they must not mutate canonical state.
- Handler-local mutable memory is disallowed; durable memory belongs in object state, object context, mission progress, or the event log.
- Handler-emitted follow-up signals and command requests are deferred until loop guards, causation tracking, and TTL semantics are implemented.
- V1 effects should stay small: object upsert, object delete, and notification emit.
- Traffic route-impact handlers must not silently reroute mobile assets; rerouting is a command or future declared policy.

## Rejected Alternatives

### Object-local behavior

Each object could own behavior and mutate related objects directly.

Rejected because multi-object and cross-simulation interactions would become race-prone and hard to replay. Objects remain data. They may be the source or subject of a signal, but they do not execute hidden behavior.

### Central domain orchestrator

One central orchestrator could own all rules.

Rejected as the long-term architecture because it would either become a god module or force ambulance, drone, police, maritime, and other domain rules into core. The control-instance runtime should own sequencing and commit, while packs own domain interpretation.

### Loose callback event bus

Any module could subscribe to events and mutate state.

Rejected because it produces callback spaghetti, unclear ordering, and weak auditability. Handlers return effects; only the runtime commits effects.

### Mirroring effects back into providers as authoritative state

The runtime could apply interaction effects directly back into simulation providers.

Rejected as the long-term model because it implies duplicate canonical object stores. Providers may observe committed events and update private projections, but the Control Instance event log projection remains the shared source of truth.

### Arbitrary scripting engine

Missions or packs could define scripts that mutate state.

Rejected for V1 because it creates security, testability, replay, and AI-safety risks. Declarative signals and constrained effects are enough for the initial interaction layer.
