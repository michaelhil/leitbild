# ADR 0003: Simulation Adapter Boundary

## Decision

Leitbild talks to simulations through a stable `SimulationConnection` interface.

V1 includes a local in-process ambulance simulator adapter, but the adapter contract is remote-capable and suitable for a future WebSocket adapter.

## Rationale

The simulator owns world evolution and domain rules. Leitbild owns control instances, actors, commands, state projection, UI, event logs, and metrics instrumentation.

Domain rules include interactions among objects, such as patient pickup, hospital admission, capacity changes, resource transfer, battery depletion, cargo loading, or incident resolution.

Objects may be the source or subject of domain events, but objects do not emit directly onto Leitbild's event stream. The simulation instance emits ordered `SimulationEvent`s through the adapter with explicit provenance.

## Consequences

- The browser never talks directly to the simulator.
- Local simulators must use the same adapter boundary as remote simulators.
- Commands have explicit issued, accepted, and rejected lifecycle events.
- Domain-specific interaction logic lives behind the simulation adapter boundary.
- Leitbild core should not implement ambulance, drone, ship, robotaxi, or hospital-specific world rules.
- Event ordering remains owned by the simulation instance and then by the control instance event log.
