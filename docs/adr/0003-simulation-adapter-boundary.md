# ADR 0003: Simulation Adapter Boundary

## Decision

Leitbild talks to simulations through a stable `SimulationConnection` interface.

V1 includes a local in-process ambulance simulator adapter, but the adapter contract is remote-capable and suitable for a future WebSocket adapter.

## Rationale

The simulator owns world evolution and domain rules. Leitbild owns control instances, actors, commands, state projection, UI, event logs, and metrics instrumentation.

## Consequences

- The browser never talks directly to the simulator.
- Local simulators must use the same adapter boundary as remote simulators.
- Commands have explicit issued, accepted, and rejected lifecycle events.
