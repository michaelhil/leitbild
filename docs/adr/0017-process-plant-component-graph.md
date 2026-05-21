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

The graph uses typed component ports and typed links. Raw component/port references are parsed once by a graph compiler, which validates topology, parameters, port compatibility, variable publication, and connection direction before runtime. The compiler produces indexed component and link tables for the future solver.

Connections are also process links. They may remain pure topology, or they may own optional physical metadata and link-local process variables such as flow, pressure, radiation, valve position, or leak area. Link variables join the same process variable registry as component variables and can be published, read, or controlled using stable variable paths.

Continuous physics stays inside the process plant pack runtime. Leitbild events are used for discrete operational transitions such as commands, trips, alarms, scenario injections, and threshold crossings. Pack queries expose selected read-only process state through the generic pack query surface; process-plant does not add a process-specific HTTP endpoint family.

Process variables use structured quantity/unit metadata instead of free-text units. The runtime is headless and fixed-step: commands are applied at the start of a tick, ordered solver phases update continuous state, and snapshots expose current variable values for tests, provider persistence, and queries.

The runtime code is factored into an orchestrator, a variable table, component behaviors, process-link behaviors, and a small behavior contract. The variable table is the single authoritative in-memory state for compiled component and link variables; behavior modules do not maintain shadow copies.

Component and process-link behaviors run through a constrained behavior context. Behavior definitions declare audit-facing read dependencies and declared write outputs; the execution-plan compiler validates declared write paths against the compiled graph, and the context enforces that behavior updates only write those outputs. Read declarations remain reviewable metadata until all graph-dependent reads are normalized through shared helpers. This keeps the solver functional and explicit without turning V1 into a general-purpose runtime plugin framework. Runtime writes and accepted commands validate finite values, invalid ratio bounds, and negative non-negative physical quantities before they become provider snapshots or telemetry. A full invariant scan remains available as an explicit debug check rather than a default per-step allocation.

The process-plant simulation provider owns provider-private runtime state. It persists runtime snapshots in a provider sidecar under the Control Instance directory rather than writing dense process variables into the Control Instance object snapshot or durable event journal. The sidecar includes elapsed process time, fixed-step remainder, queued commands, and variable values.

The provider also owns process-specific schedules and telemetry buffers. Scenario `providerConfigs["process-plant"]` can configure timed variable writes and selected trend sampling per process system. This keeps pump trips, valve operations, rod moves, and process trends inside the process-plant pack instead of turning core scenario scripting into a process-control language.

The first process slice is a lumped-parameter directional model, not analysis-grade thermal hydraulics. It couples reactor heat generation, decay heat, fuel temperature, primary coolant flow/temperature, steam-generator tube-metal heat transfer, secondary-side mass balance, steam production, turbine steam use/electrical output, condenser sink, and pressurizer pressure/inventory control. Shared thermophysical helpers hold the approximate constants and formulas used by these behaviors. This proves that the graph/variable/solver architecture can carry a coherent primary-to-secondary energy path while keeping continuous physics inside the pack runtime. It does not yet claim a fully closed condensate/feedwater loop or a solved primary pressure field.

## Consequences

- Leitbild core remains process-plant-agnostic.
- The process plant pack can evolve toward a real fixed-step solver without redesigning the topology format.
- AI agents and humans can author whole plant topologies as scenario/config data, while component physics remains code-backed and tested.
- Invalid plant graphs fail before simulation starts.
- Control-room surfaces and AI agents can use stable variable paths rather than ad hoc object fields.
- Process-link terminology is used in compiled/runtime code. Scenario authors define `connections` with an explicit `connectionKind`; fluid links must also declare a `service` such as `primaryCoolant`, `mainSteam`, `feedwater`, `auxFeedwater`, or `condensate`.
- `nominalFluid`, `designPhase`, and `solverModel` describe design intent for a fluid connection without making phase or fluid identity a brittle hard-coded label.
- Simple conduit-local sensors, valves, and leaks can be modeled without exploding the graph into many tiny components.
- The built-in graph now exercises a four-loop plant skeleton with four steam generators, four reactor coolant pumps, main and auxiliary feedwater paths, main steam/header/turbine/condenser paths, charging/letdown, and pressurizer topology.
- Complex valves, instruments, or fittings can still become components later when they need multiple ports or rich internal behavior.
- Internal high-frequency plant state does not become durable journal noise.
- Future higher-fidelity components can replace simpler component definitions behind the same typed ports and variable paths.
- Solver behavior now has explicit read/write metadata and an enforced write contract, making richer future components less likely to corrupt unrelated plant state.
- The runtime phase list reflects actual execution; telemetry publication is a read-out from the variable table, not a hidden state-changing phase.
- The pack now has a real headless runtime/testbed plus Control Instance provider integration.
- The generic query surface can inspect systems, graph topology, variables, published telemetry, and runtime status without new HTTP routes.
- The generic query surface can also read configured trend buffers through `process-plant.trends.read`.
- `process-plant.control.write` is a real provider command for writable variables; invalid writes are rejected before they enter the solver queue.
- Provider-private state restores process runtimes after reload without turning variables into operational objects.
- The current built-in graph can now exercise the first primary/secondary energy path in headless tests.
- Multi-unit process scenarios do not need a separate cluster runtime. A scenario can instantiate multiple process systems, each with the same graph and different schedules/telemetry config. The current six-unit benchmark runs six expanded plant graphs independently in one provider.
- Physics-deepening work must preserve the optimized execution model: compile once, use the variable table as the only authoritative state, reuse compiled adjacency indexes, and avoid per-tick graph parsing or new shadow state.

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
- Do not expose process variables through object snapshots or object updates.
- Do not persist queued commands only in memory; accepted commands must survive provider close/reopen until the solver applies them.
- Do not give behavior modules unrestricted access to mutate the variable table.
- Do not add a dynamic behavior/plugin loader until there is a concrete second implementation pressure; scenario data instantiates graphs, but solver behavior remains reviewed TypeScript code in V1.
- Do not duplicate thermophysical constants in individual behaviors; add reviewed helper functions when a formula becomes shared across components or links.
