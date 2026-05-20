# PWR Process Simulation V1 Design Spec

## Purpose

Leitbild should be able to host process-control simulations that interact with the wider operational world. The first feasibility target is a simplified Westinghouse-style pressurized water reactor (PWR) plant that can support common emergency scenario studies such as steam generator tube rupture (SGTR), loss of feedwater, turbine trip/load rejection, reactor trip, and recovery actions.

V1 is not a licensing-grade thermal-hydraulic analysis code. It is a medium-fidelity process-control simulator intended to test whether Leitbild can run, inspect, control, and coordinate a coupled plant model credibly enough for control-room workflow research, AI-agent studies, and cross-domain scenario interaction.

The key feasibility question is whether a declarative component graph, typed ports/edges, a compiled runtime graph, and a fixed-step solver can make plant evolution understandable, efficient, replayable, and extensible.

## Core Decision

The PWR simulation lives inside a `pwr` pack. Leitbild core remains use-case agnostic.

The architectural decision is recorded in [ADR 0017](./adr/0017-pwr-process-simulation-component-graph.md).

Inside the pack:

- `PlantGraphSpec` describes plant topology and parameters as validated data.
- Component definitions declare parameters, ports, variables, and later solver behavior.
- A graph compiler validates raw specs and compiles them into indexed runtime graphs.
- A fixed-step runtime owns continuous process evolution.
- A variable registry exposes stable paths, units, writability, and publish policy.
- Discrete events represent commands, trips, alarms, threshold crossings, and scenario injections.
- Pack queries expose read-only process state through Leitbild's generic query surface.

Leitbild core sees selected operational objects, commands, queries, events, and surfaces. It does not see every internal plant variable as an `OperationalObject`.

## Canonical Authoring Model

V1 uses a TypeScript data-builder DSL that emits JSON-compatible data.

This gives:

- TypeScript autocomplete and refactoring support.
- Branded ids for internal code.
- Runtime Zod validation for loaded specs.
- A pure-data canonical shape that can later be serialized to JSON or generated from YAML.
- Mermaid diagrams generated from the canonical graph instead of Mermaid being the source of truth.

Mermaid is documentation/debug output only. It is not the canonical plant model.

## Plant Graph Spec

The graph spec contains:

- `schemaVersion`
- `id`
- `title`
- `timestep`
- `components`
- `connections`
- `publishedVariables`

Component instance:

```ts
interface ComponentInstanceSpec {
  readonly id: ComponentId
  readonly kind: ComponentKind
  readonly label: string
  readonly parameters: unknown
  readonly initialState?: unknown
}
```

Connection:

```ts
interface ConnectionSpec {
  readonly id: ConnectionId
  readonly from: PortRef
  readonly to: PortRef
  readonly edgeKind?: EdgeKind
  readonly medium?: string
}
```

Raw port refs use a compact authoring form such as `sgA.primaryOutlet`. Runtime code must not repeatedly parse these refs during every tick. They are parsed and resolved once by the compiler.

## Typed Ports And Edges

Component definitions declare named ports with a kind and direction.

Port kinds:

- `hydraulic`
- `thermal`
- `hydraulicThermal`
- `electricalAc`
- `mechanicalShaft`
- `controlSignal`
- `logicSignal`

Port directions:

- `in`
- `out`
- `bidirectional`

Edge kinds:

- `hydraulicFlow`
- `thermalContact`
- `steamFlow`
- `electricalPower`
- `mechanicalTorque`
- `controlSignal`
- `logicSignal`

Typed ports are part of the graph. They prevent impossible topology and determine which solver pass owns a connection. For example, a hydraulic pump outlet can connect to a pipe inlet, but an electrical breaker output cannot connect directly to a hydraulic pump inlet.

## Graph Compiler

Raw specs compile once before runtime.

Compilation steps:

1. Validate the raw schema.
2. Reject duplicate component ids and connection ids.
3. Resolve component kinds through the component registry.
4. Validate parameters using the component definition.
5. Parse port refs.
6. Validate referenced components and ports.
7. Validate port compatibility and direction.
8. Infer or validate edge kind.
9. Validate published variables against component variable definitions.
10. Build indexed component and edge tables.
11. Group edges by edge kind.
12. Produce a compiled variable registry.

Invalid topology fails before simulation starts with explicit diagnostics. There should be no silent fallbacks.

## Runtime Graph

The compiled graph uses numeric indices, not string lookups in hot loops.

```ts
interface CompiledPlantGraph {
  readonly specId: PlantGraphId
  readonly components: ReadonlyArray<CompiledComponent>
  readonly componentIndexById: ReadonlyMap<ComponentId, number>
  readonly edges: ReadonlyArray<CompiledEdge>
  readonly edgesByKind: Readonly<Record<EdgeKind, ReadonlyArray<number>>>
  readonly variables: ReadonlyArray<CompiledVariable>
}
```

This keeps the future solver deterministic and efficient. If profiling later shows the need, the indexed graph can move hot numeric state into typed arrays without redesigning the spec.

## Variable Registry

Every meaningful process value has a stable variable path and metadata.

Variable descriptors include:

- `path`
- `label`
- `kind`
- `unit`
- `domain`
- `writable`
- `publish`

Publish policies:

- `internal`
- `telemetry`
- `alarm`
- `leitbild`

Example paths:

- `core.powerMw`
- `core.reactivityPcm`
- `rcs.loopA.hotLeg.temperatureC`
- `pressurizer.pressureMPa`
- `sgA.levelPercent`
- `feedwater.trainA.flowKgPerS`
- `protection.reactorTrip.active`

The registry is the shared language for process surfaces, AI agents, tests, trends, scenario scripts, and pack queries.

## Solver Boundary

Continuous physics is solver-owned. Discrete events are for operational changes.

Do not model continuous plant physics through component-to-component event messages such as “pump emitted water” or “steam generator received hot water.” That creates order-dependent behavior and breaks physical coherence.

Instead:

- components expose ports and variables,
- the compiled graph owns connections,
- solver passes compute flows, transfers, inventories, and state changes,
- events are emitted only for discrete transitions.

Discrete event examples:

- operator command accepted,
- pump started or tripped,
- valve demand changed,
- reactor trip actuated,
- alarm entered or cleared,
- scenario fault injected,
- threshold crossed.

V1 should use a deterministic fixed-step solver. A 100 ms internal timestep is a reasonable first target, with lower-frequency telemetry publication.

Solver pass order:

1. apply queued commands,
2. apply scheduled scenario injections,
3. run control and protection logic,
4. solve hydraulic and steam flow approximations,
5. solve heat transfer approximations,
6. update component states,
7. compute derived variables,
8. evaluate alarms and trips,
9. publish selected telemetry/events,
10. store provider snapshot state.

## V1 Feasibility Scenarios

V1 should prove the architecture against three scenario families.

SGTR-like transient:

- primary-to-secondary leak path,
- primary pressure/inventory effect,
- secondary indications,
- alarm/trip behavior,
- operator response variables.

Loss of feedwater:

- feedwater flow reduction or loss,
- SG level decrease,
- degraded heat removal,
- reactor/turbine trip logic,
- simplified auxiliary/emergency feedwater path.

Turbine trip/load rejection:

- steam demand change,
- secondary pressure response,
- reactor power/control response,
- protection/alarm response.

The initial target is credible process directionality and control-room usefulness, not nuclear-grade fidelity.

## Pack Surface

V1 should use the existing generic pack query route. Do not add `/api/pwr/*` endpoint families without a new ADR.

Candidate queries:

- `pwr.variables.read`
- `pwr.variables.search`
- `pwr.graph.read`
- `pwr.alarms.list`
- `pwr.trends.read`
- `pwr.runtime.status`

Candidate commands:

- `pwr.control.write`
- `pwr.control.operate`
- `pwr.alarm.acknowledge`
- `pwr.scenario.injectFault`

Candidate events:

- `pwr.alarm.entered`
- `pwr.alarm.cleared`
- `pwr.trip.actuated`
- `pwr.operator.action`
- `pwr.variable.thresholdCrossed`
- `pwr.modeChanged`

These are future runtime surfaces. Phase 1 implements only the graph/spec foundation.

## Persistence And Replay

The PWR provider will own private runtime state. It must persist enough provider snapshot data to restore a running plant without replaying the scenario definition as if it were current state.

Persist:

- plant spec id/version,
- compiled graph version/hash,
- component states,
- values needed for restart,
- clock state,
- active alarms,
- trend buffer policy.

Do not persist every high-frequency telemetry frame into the durable journal. The durable journal remains meaningful accepted history. Provider snapshots hold current runtime truth.

## Performance Strategy

The performance strategy is architectural:

- compile graph once,
- use numeric component and port indices,
- group edges by physical domain,
- use a fixed timestep,
- publish selected variables only,
- avoid parsing raw graph strings in the solver loop,
- add typed arrays only after profiling proves they are needed.

V1 acceptance should include a headless performance test for the first PWR graph. A useful target is simulating one hour of plant time faster than real time in headless mode, or maintaining stable real-time execution under expected UI query load.

## Implementation Phases

Phase 0: documentation and ADRs.

Phase 1: graph/spec foundation:

- TypeScript data-builder DSL,
- Zod schemas,
- component registry,
- graph compiler,
- validation diagnostics,
- Mermaid generator,
- first PWR lite graph spec,
- compiler tests.

Phase 2: runtime skeleton:

- variable registry runtime,
- fixed-step runtime shell,
- provider snapshot shape,
- read-only variable query.

Phase 3: minimal process slice:

- reactor core lite,
- primary loop,
- steam generator lite,
- feedwater source,
- turbine/load sink,
- simple control/protection logic.

Phase 4: emergency scenario tests:

- SGTR-like transient,
- loss-of-feedwater transient,
- turbine trip/load rejection.

Phase 5: Leitbild integration:

- PWR pack,
- provider adapter,
- generic pack queries,
- commands,
- events,
- snapshot/restore.

Phase 6: first control-room surface:

- mimic display,
- alarm panel,
- trend panel,
- basic controls.

## Non-Goals For V1

- full plant fidelity,
- RELAP/TRACE replacement,
- FMI/FMUs,
- multi-rate solvers,
- arbitrary user-authored equations,
- distributed solver execution,
- every variable as an operational object,
- Mermaid as canonical source,
- UI-first implementation before runtime feasibility.

## Guardrails

- Keep PWR-specific logic in `src/packs/pwr/*`.
- Keep Leitbild core free of PWR terminology.
- Use TypeScript and Bun.
- Do not add JavaScript files.
- Do not add placeholder production paths.
- Fail loudly on invalid graph specs.
- Do not introduce a second HTTP server.
- Do not add domain-specific HTTP endpoint families.
- Do not blur continuous solver state with discrete events.
- Do not treat generated Mermaid diagrams as canonical topology.
