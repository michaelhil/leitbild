# ADR 0017: PWR Process Simulation Component Graph

## Status

Accepted.

## Context

Leitbild is starting to explore process-control simulations that can interact with the wider multi-pack simulation world. The first feasibility target is a simplified Westinghouse-style PWR plant capable of supporting medium-fidelity emergency scenarios such as SGTR, loss of feedwater, turbine trip/load rejection, and reactor trip response.

This kind of simulation has many internal variables and high-frequency continuous dynamics. Treating each plant variable as an operational object, or modeling physics as event messages between objects, would contaminate Leitbild core and make the simulation order-dependent.

## Decision

The PWR simulation lives in `src/packs/pwr/*` as a pack-owned process runtime.

The canonical plant topology is a validated `PlantGraphSpec` authored through a TypeScript data-builder DSL that emits JSON-compatible data. Mermaid diagrams are generated from this graph for review and documentation; Mermaid is not the source of truth.

The graph uses typed component ports and typed edges. Raw component/port references are parsed once by a graph compiler, which validates topology, parameters, port compatibility, variable publication, and connection direction before runtime. The compiler produces indexed component and edge tables for the future solver.

Continuous physics stays inside the PWR provider runtime. Leitbild events are used for discrete operational transitions such as commands, trips, alarms, scenario injections, and threshold crossings. Pack queries expose selected read-only process state through the generic pack query surface.

## Consequences

- Leitbild core remains PWR-agnostic.
- The PWR pack can evolve toward a real fixed-step solver without redesigning the topology format.
- Invalid plant graphs fail before simulation starts.
- Control-room surfaces and AI agents can use stable variable paths rather than ad hoc object fields.
- Internal high-frequency plant state does not become durable journal noise.
- Future higher-fidelity components can replace simpler component definitions behind the same typed ports and variable paths.

## Guardrails

- Do not add PWR-specific HTTP endpoint families without a new ADR.
- Do not model continuous physics through object-to-object event messages.
- Do not treat raw process variables as `OperationalObject`s.
- Do not allow arbitrary scenario code or user-authored equations in V1.
- Do not make Mermaid or diagrams canonical topology.
- Do not add placeholder component behavior. Component graph metadata is allowed because it is used by validation and compilation; solver behavior must be real when added.
