# Process Plant Simulation V1 Design Spec

## Purpose

Leitbild should be able to host process-control simulations that interact with the wider operational world. The first feasibility target is a pressurized water reactor plant, but the pack identity is deliberately broader: `process-plant`.

V1 is not a licensing-grade thermal-hydraulic analysis code. It is a medium-fidelity process-control simulator intended to test whether Leitbild can run, inspect, control, and coordinate coupled plant models credibly enough for control-room workflow research, AI-agent studies, and cross-domain scenario interaction.

The key feasibility question is whether a scenario-owned component graph, typed ports/edges, a compiled runtime graph, and a fixed-step solver can make plant evolution understandable, efficient, replayable, and extensible.

## Core Decision

Process plant simulations live inside the `process-plant` pack. Leitbild core remains use-case agnostic.

The architectural decision is recorded in [ADR 0017](./adr/0017-process-plant-component-graph.md).

Inside the pack:

- `PlantGraphSpec` describes plant topology and parameters as validated data.
- component definitions declare parameters, ports, variables, and later solver behavior.
- a graph compiler validates raw specs and compiles them into indexed runtime graphs.
- a fixed-step runtime owns continuous process evolution.
- a variable registry exposes stable paths, units, writability, and publish policy.
- discrete events represent commands, trips, alarms, threshold crossings, and scenario injections.
- pack queries expose read-only process state through Leitbild's generic query surface.

Leitbild core sees selected operational objects, commands, queries, events, and surfaces. It does not see every internal plant variable as an `OperationalObject`.

## Scenario-Owned Process Assembly

The full plant run is assembled from a Leitbild Scenario Definition. The scenario declares active packs and may include one or more `processSystems`. Each process system names the owning pack, the component library, and a graph data object.

```json
{
  "processSystems": [
    {
      "id": "plant",
      "pack": "process-plant",
      "componentLibrary": "process-plant",
      "graph": {
        "schemaVersion": 1,
        "id": "process-plant.pressurized-water-reactor.v1",
        "title": "Pressurized Water Reactor",
        "timestep": { "fixedStepMs": 100 },
        "components": [],
        "connections": [],
        "publishedVariables": []
      }
    }
  ]
}
```

This makes plant topology config-owned rather than hardcoded in TypeScript. A future AI agent can author a complete plant graph by writing scenario/config data, then Leitbild validates and compiles it before runtime.

The reusable machinery remains code-owned:

- component type definitions,
- parameter/state schemas,
- graph compiler,
- solver/runtime,
- provider query surface,
- command/event handlers.

That boundary is deliberate. Scenarios instantiate components and connect them; they do not invent arbitrary physics in V1.

## Canonical Graph Format

V1 uses JSON-compatible graph data as the canonical runtime input. The current built-in pressurized water reactor graph lives at `src/packs/process-plant/specs/pressurized-water-reactor.graph.json`.

A TypeScript data-builder DSL remains available as an authoring and test helper. The builder is not the runtime source of truth. Runtime plant assembly should load graph data from the Scenario Definition or from a graph data file referenced by scenario tooling.

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
- `steam`
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

## Current Component Library

The current component library is intentionally small. It defines graph interfaces and variables, not running physics yet.

- `reactorCore`
- `steamGenerator`
- `centrifugalPump`
- `feedwaterSource`
- `turbineLoadSink`

These names avoid temporary fidelity labels. The current implementation is still an early model, but the public component kind names should remain stable unless a deliberate breaking change is made.

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
- `sgA.levelPercent`
- `feedwaterA.flowKgPerS`
- `turbine.electricMw`

The registry is the shared language for process surfaces, AI agents, tests, trends, scenario scripts, and pack queries.

## Solver Boundary

Continuous physics is solver-owned. Discrete events are for operational changes.

Do not model continuous plant physics through component-to-component event messages such as "pump emitted water" or "steam generator received hot water." That creates order-dependent behavior and breaks physical coherence.

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

## Feasibility Scenarios

V1 should prove the architecture against three scenario families.

Steam generator tube rupture-like transient:

- primary-to-secondary leak path,
- primary pressure/inventory effect,
- secondary indications,
- alarm/trip behavior,
- operator response variables.

Loss of feedwater:

- feedwater flow reduction or loss,
- steam generator level decrease,
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

V1 should use the existing generic pack query route. Do not add `/api/process-plant/*` endpoint families without a new ADR.

Candidate queries:

- `process-plant.variables.read`
- `process-plant.variables.search`
- `process-plant.graph.read`
- `process-plant.alarms.list`
- `process-plant.trends.read`
- `process-plant.runtime.status`

Candidate commands:

- `process-plant.control.write`
- `process-plant.control.operate`
- `process-plant.alarm.acknowledge`
- `process-plant.scenario.injectFault`

Candidate events:

- `process-plant.alarm.entered`
- `process-plant.alarm.cleared`
- `process-plant.trip.actuated`
- `process-plant.operator.action`
- `process-plant.variable.thresholdCrossed`
- `process-plant.modeChanged`

These are future runtime surfaces. The current implementation covers only the graph/spec foundation.

## Persistence And Replay

The process plant provider will own private runtime state. It must persist enough provider snapshot data to restore a running plant without replaying the scenario definition as if it were current state.

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

V1 acceptance should include a headless performance test for the first reactor graph. A useful target is simulating one hour of plant time faster than real time in headless mode, or maintaining stable real-time execution under expected UI query load.

## Implementation Phases

Phase 1: graph/spec foundation:

- TypeScript data-builder DSL,
- Zod schemas,
- component registry,
- graph compiler,
- validation diagnostics,
- Mermaid generator,
- first pressurized water reactor graph spec,
- compiler tests.

Phase 2: runtime skeleton:

- variable registry runtime,
- fixed-step runtime shell,
- provider snapshot shape,
- read-only variable query.

Phase 3: minimal process slice:

- reactor core,
- primary loop,
- steam generator,
- feedwater source,
- turbine/load sink,
- simple control/protection logic.

Phase 4: emergency scenario tests:

- steam generator tube rupture-like transient,
- loss-of-feedwater transient,
- turbine trip/load rejection.

Phase 5: Leitbild integration:

- process plant pack registration,
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
- licensing-grade analysis,
- FMI/FMUs,
- multi-rate solvers,
- arbitrary user-authored equations,
- distributed solver execution,
- every variable as an operational object,
- Mermaid as canonical source,
- UI-first implementation before runtime feasibility.

## Guardrails

- Keep process-plant logic in `src/packs/process-plant/*`.
- Keep Leitbild core free of plant-specific terminology.
- Use TypeScript and Bun.
- Do not add JavaScript files.
- Do not add placeholder production paths.
- Fail loudly on invalid graph specs.
- Do not introduce a second HTTP server.
- Do not add domain-specific HTTP endpoint families.
- Do not blur continuous solver state with discrete events.
- Do not treat generated Mermaid diagrams as canonical topology.
