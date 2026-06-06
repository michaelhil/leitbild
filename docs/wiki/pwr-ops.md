---
title: PWR Operations
type: pack
---

# PWR Operations

!!! note "Status"
    Leitbild now has a pack-owned PWR transient diagnostic kernel in the process-plant pack. The model is a deterministic lumped operational simulator, not a licensing-basis thermal-hydraulic safety analysis code.

PWR operations in Leitbild live in the `process-plant` pack. PWR is a catalog contributor: it contributes fixed reference graph refs, a modular reference assembly, reusable loop/base fragments, graph-aware reference I&C, and the unit overview surface to the generic process-plant catalog.

The current fixed reference graph is `process-plant.pressurized-water-reactor.v1`. Modular PWR scenarios should prefer `assemblyRef: "process-plant.pwr.reference.assembly.v2"` with an explicit loop-count/loop-id config, then use graph-aware I&C through `icRef: "process-plant.pwr.reference.graph.ic.v2"` so alarms, trips, controllers, and overview displays derive their loop set from the compiled graph.

The process-plant catalog view exposes the fixed PWR refs, the modular assembly ref, the reusable fragment refs, and the dynamic I&C pattern `process-plant.pwr.reference.<loopCount>-loop.ic.v2`.

## Runtime Model

The PWR runtime uses the normal process-plant architecture:

- scenario-owned component graph and parameters
- catalog-backed graph refs, modular assemblies, graph fragments, I&C refs, and process surfaces
- typed component/link variables with stable paths, units, tags, and writability
- fixed-step runtime with validated commands
- reference I&C rules for alarms, trips, permissives, interlocks, and automatic writes
- read-only pack queries for UI, procedures, and AI agents

The transient diagnostic kernel is compiled from the graph and reads canonical runtime variables after each fixed step. It does not mutate state.

## Transient Diagnostics

Use the pack query `process-plant.transient.diagnostics` with `{ "systemId": "..." }`.

The response summarizes:

- **Primary**: inventory, inventory fraction, pressure, pressure bias, boundary leak, safety injection, SG tube leak flow, aggregate reactor-coolant flow, and running RCP count
- **Secondary**: SG inventory, steam mass, level, voiding, tube coverage, heat transfer, steam outflow, feedwater flow, feedwater tank state, and auxiliary-feedwater reserve/flow
- **Balance of plant**: turbine output/steam use, condenser backpressure, heat rejection, hotwell inventory, and cooling-water availability
- **Containment**: pressure, sump inventory, incoming release, radiation source term
- **Core**: fission power, decay heat, total thermal power, cooling availability, heat-removal deficit, fuel heatup rate
- **Safety systems**: accumulator inventory/outflow, safety bus state, running diesels
- **Electrical**: bus voltage/energization, degraded bus count, served/demand load, and unserved load count
- **Conservation**: primary inventory residual, SG liquid/steam residuals, SG boiling residuals, pressurizer residuals
- **I&C**: configured state, active alarm/trip/rule/failure counts, highest active severity, active first-out annunciators, and compact active lifecycle summaries when protection is configured

This is the recommended overview/query surface for PWR operations displays, procedure context, AI context, and scenario acceptance checks.

## Steam Generator Behavior

Steam generators now expose tube-bundle coverage variables:

- `sgX.tubeCoverageFraction`
- `sgX.tubeUncoveredFraction`
- `sgX.availableHeatTransferFraction`

As SG level falls below the configured tube-bundle top, available heat transfer degrades. This gives overview displays and diagnostics a direct way to distinguish ordinary level change from tube uncovering and heat-removal degradation.

## Core Cooling Behavior

The core now exposes:

- `core.coreCoolingAvailabilityFraction`
- `core.coreHeatRemovalDeficitMw`
- `core.fuelHeatupRateCPerS`

Primary-flow loss affects core cooling availability and fuel heatup. The model remains compact and deterministic, but RCP coastdown and loss-of-flow scenarios now have a clearer thermal consequence.

## Typed PWR Fault Actions

Scenario schedules may use typed PWR fault actions. They compile to ordinary validated runtime writes and do not bypass limits or writability.

- `primaryBoundaryLeak`: sets a process-link leak area fraction
- `steamGeneratorTubeLeak`: sets an SG tube leak fraction
- `reactorCoolantPumpTrip`: trips an RCP running state
- `lossOfOffsitePower`: opens the offsite breakers

Use these for major scenario setup instead of raw path writes when the scenario intent is one of these standard PWR faults.

## Engineering Boundaries

The current model is suitable for operational scenario behavior, overview displays, procedure exercises, and AI/runbook context. It is not a RELAP/TRACE/CFD replacement.

Future deepening should keep the same boundaries:

- add acceptance traces per design-basis scenario family
- replace heuristics with compact documented correlations where they materially improve behavior
- keep continuous physics inside the process-plant pack runtime
- keep durable event logs for meaningful accepted events, not high-frequency process projections

Application ADR: `docs/adr/0024-pwr-transient-kernel.md`.
