# ADR 0003: Simulation Adapter Boundary

## Decision

Leitbild talks to simulations through a stable `SimulationConnection` interface.

V1 includes a local in-process ambulance simulator adapter, but the adapter contract is remote-capable and suitable for a future WebSocket adapter.

The Control Instance event log and projected state are the canonical Leitbild truth. Simulation instances are providers connected to a Control Instance. They may keep private state or provider-local projections for their own mechanics, but they do not own canonical Leitbild object state.

## Rationale

Simulation providers own specialist mechanics such as motion stepping, route following, sensor generation, scenario timing, or private high-resolution models. Leitbild owns control instances, actors, command envelopes, canonical state projection, UI, event logs, replay, API reads, metrics instrumentation, and cross-provider interaction commit.

Domain rules may be local to one provider or may require interaction across providers. Cross-object and cross-simulation interaction is coordinated through Control Instance interaction signals and handlers, not by one provider mutating another provider.

Objects may be the source or subject of domain events, but objects do not emit directly onto Leitbild's event stream. Simulation instances emit `SimulationEvent`s and interaction signals through the adapter with explicit provenance. Leitbild orders and commits accepted domain events in the Control Instance event log.

After events are committed, simulation providers may observe committed events to update private state or provider-local projections. This observation is not a second canonical mutation path.

## Consequences

- The browser never talks directly to the simulator.
- Local simulators must use the same adapter boundary as remote simulators.
- Commands have explicit issued, accepted, and rejected lifecycle events.
- Canonical object state for UI, API, replay, metrics, and AI agents comes from the Control Instance event log projection.
- Simulation providers may maintain private state, but must treat committed Control Instance events as the shared operational picture.
- Cross-provider interaction logic lives in registered interaction handlers, usually contributed by packs.
- Leitbild core owns signal/effect envelopes and commit semantics, but should not implement ambulance, drone, ship, robotaxi, or hospital-specific world rules.
- Event ordering for shared Leitbild state is owned by the Control Instance event log.
- Provider-local event ordering may exist internally, but it is not authoritative for shared Leitbild state until emitted and committed.
