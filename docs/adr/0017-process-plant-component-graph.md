# ADR 0017: Process Plant Component Graph

## Status

Accepted.

## Context

Leitbild is starting to explore process-control simulations that can interact with the wider multi-pack simulation world. The first feasibility target is a pressurized water reactor plant, but the pack identity is broader: `process-plant`.

This kind of simulation has many internal variables and high-frequency continuous dynamics. Treating each plant variable as an operational object, or modeling physics as event messages between objects, would contaminate Leitbild core and make the simulation order-dependent.

## Decision

Process-control simulations live in `src/packs/process-plant/*` as a pack-owned process runtime.

The canonical plant topology is validated JSON-compatible `PlantGraphSpec` data owned by the Leitbild Scenario Definition through `processSystems`. A TypeScript data-builder DSL may be used as authoring/test tooling, but runtime plant assembly must not depend on importing a hardcoded TypeScript plant graph.

Mermaid diagrams are generated from this graph for review and documentation; Mermaid is not the source of truth.

The graph uses typed component ports and typed edges. Raw component/port references are parsed once by a graph compiler, which validates topology, parameters, port compatibility, variable publication, and connection direction before runtime. The compiler produces indexed component and edge tables for the future solver.

Connections are also process links. They may remain pure topology, or they may own optional physical metadata and link-local process variables such as flow, pressure, radiation, valve position, or leak area. Link variables join the same process variable registry as component variables and can be published, read, or controlled using stable variable paths.

Continuous physics stays inside the process plant pack runtime. Leitbild events are used for discrete operational transitions such as commands, trips, alarms, scenario injections, and threshold crossings. Pack queries will expose selected read-only process state through the generic pack query surface after the runtime lifecycle is integrated with a Control Instance provider.

Process variables use structured quantity/unit metadata instead of free-text units. The runtime is headless and fixed-step: commands are applied at the start of a tick, ordered solver phases update continuous state, and snapshots expose current variable values for tests and future provider integration.

## Consequences

- Leitbild core remains process-plant-agnostic.
- The process plant pack can evolve toward a real fixed-step solver without redesigning the topology format.
- AI agents and humans can author whole plant topologies as scenario/config data, while component physics remains code-backed and tested.
- Invalid plant graphs fail before simulation starts.
- Control-room surfaces and AI agents can use stable variable paths rather than ad hoc object fields.
- Simple conduit-local sensors, valves, and leaks can be modeled without exploding the graph into many tiny components.
- Complex valves, instruments, or fittings can still become components later when they need multiple ports or rich internal behavior.
- Internal high-frequency plant state does not become durable journal noise.
- Future higher-fidelity components can replace simpler component definitions behind the same typed ports and variable paths.
- The pack now has a real headless runtime/testbed before public query or UI surfaces are added.
- Adding a process API without runtime snapshot/restore and provider lifecycle support would be premature.

## Guardrails

- Do not add process-plant-specific HTTP endpoint families without a new ADR.
- Do not model continuous physics through object-to-object event messages.
- Do not treat raw process variables as `OperationalObject`s.
- Do not allow arbitrary scenario code or user-authored equations in V1.
- Do not make Mermaid or diagrams canonical topology.
- Do not make TypeScript plant graph files the runtime source of truth when scenario/config data can define the graph.
- Do not add placeholder component behavior. Component graph metadata is allowed because it is used by validation and compilation; solver behavior must be real when added.
- Do not use free-text variable units.
- Do not put unrelated behavior into process links. A link variable should observe or modify that one connection; multi-port or standalone behavior belongs in a component.
- Do not add public process query/command endpoints until they can be backed by the runtime lifecycle rather than static graph metadata.
