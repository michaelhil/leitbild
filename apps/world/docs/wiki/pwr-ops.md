---
title: PWR Operations
type: pack
---

# PWR Operations

!!! note "Status"
    Leitbild's reference PWR is a deterministic lumped operational simulator for scenarios, displays, procedures, and agent context. It is not licensing-basis thermal-hydraulic safety-analysis software.

PWR operations live inside the `process-plant` World Pack. A Scenario Plant selects three discoverable definitions:

- Plant Model `process-plant.pwr.reference`, parameterized by two to six primary loops
- Operating Point `process-plant.pwr.full-power`
- Automation Definition `process-plant.pwr.standard`

The Scenario Item is the only authored Plant record. Its compiled graph drives the runtime, I&C, displays, signal discovery, actions, assessments, and recording; there is no separate process-system configuration to keep synchronized.

## Runtime model

The Pack compiles validated graph data into indexed components, process links, signal bindings, and a fixed-step execution plan. Each running Plant owns an independent variable table, queued writes, automation state, ramp state, and compact restart checkpoint. Plants with the same Model may share immutable compiled structures but never runtime state.

Continuous calculations remain inside the Pack runtime. Operators, Scenario Timeline Cues, and agents use the same validated command boundary. Meaningful alarms, trips, and operational transitions enter the Run journal; dense process variables do not.

## Discovery and control

Use `process-plant.catalog.list` to discover Models, Operating Points, Automation Definitions, Action Presets, named assessments, Process Displays, recording profiles, and credibility evidence.

Queries that address a running Plant always include its explicit `plantId`. Important query families include:

- `process-plant.plants.list` and `process-plant.runtime.status`
- `process-plant.graph.*` for authored and compiled topology
- `process-plant.variables.*` and `process-plant.signals.*`
- `process-plant.ic.*` for rules and lifecycle state
- `process-plant.display.*` for definitions, projections, and current values
- `process-plant.transient.diagnostics`

Validated controls use `process-plant.control.write`, `process-plant.control.ramp`, `process-plant.ic.lifecycle`, or `process-plant.action.invoke`. Action Presets such as loss of feedwater, turbine trip, pump trip, or a developing leak resolve to ordinary queued writes and do not bypass signal permissions or physical limits.

## Process Displays and procedures

Process Displays are validated data definitions bound to graph-owned signals. Pack-owned reviewed widgets render them; display definitions do not contain generated UI code or process calculations.

Procedures are an optional World feature, not a Process Plant sub-engine. They inspect Pack signals and named assessments through generic operations, then issue the same validated commands as other actors.

## Recording

The `operations` Recording Profile samples published operator-facing variables at a one-second default cadence. The slower `engineering` profile samples every declared Plant variable. Recording is explicitly selected by the Scenario and stored by the Run Historian; it is not retained in runtime checkpoints.

## Engineering evidence

Run these checks after changing PWR topology, physics, or automation:

- `bun run process-plant:acceptance`
- `bun run process-plant:extended-validation`
- `bun run process-plant:credibility`
- `bun run process-plant:benchmark`

The credibility artifacts describe source-backed operational target envelopes. A green report means the simplified training model meets those declared envelopes, not that it is an engineering safety code.

See [ADR 0027](../adr/0027-single-source-process-plants-and-run-historian.md) for the current architecture.
