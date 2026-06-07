# ADR 0024: PWR Transient Kernel And Fault Vocabulary

## Status

Accepted.

## Context

The process-plant pack already uses scenario-owned component graphs, typed variables, fixed-step runtimes, pack queries, and reference I&C rules. That is the right substrate for PWR operations, but major scenarios need deeper coupling than isolated component boxes:

- Primary inventory, pressure bias, leakage, safety injection, tube leakage, and containment release need to be visible as one transient state.
- Steam generator level should affect tube coverage and available heat transfer, not only a rendered level bar.
- Core heatup must respond to primary-flow loss.
- Electrical recovery and reference I&C state must be observable alongside transient physics.
- Scenario faults should be typed PWR actions that compile to ordinary validated process writes.

We still do not want a hidden second simulator, arbitrary equations in scenario JSON, or event-log physics. The graph variable table remains the canonical current process truth.

## Decision

Add a pack-owned PWR transient kernel in `src/packs/process-plant/runtime/pwr-transient-kernel.ts`.

The kernel is compiled once per `ProcessPlantRuntime` from the compiled process graph. It does not mutate state. It derives a coherent diagnostic view from canonical graph variables and is exposed through the read-only pack query `process-plant.transient.diagnostics`.

Deepen the existing component implementations rather than replacing the graph runtime:

- Reactor vessel now reports a primary inventory balance residual.
- Steam generators report tube coverage, uncovered tube fraction, and available heat-transfer fraction; uncovered tubes reduce heat transfer.
- Reactor core reports cooling availability, heat-removal deficit, and fuel heatup rate; reduced primary flow increases heatup.
- Transient diagnostics include primary, secondary, balance-of-plant, containment, core, safety-system, electrical, and conservation summaries.
- Runtime transient query results include active counts, highest severity, active first-out annunciators, and compact active lifecycle summaries when protection is configured.

Add typed scheduled PWR fault actions:

- `primaryBoundaryLeak`
- `steamGeneratorTubeLeak`
- `reactorCoolantPumpTrip`
- `lossOfOffsitePower`

These actions compile to the same validated `setVariable` command path as operator, scenario, and I&C writes. They do not create a privileged mutation path.

## Consequences

The process-plant pack now has a clear Module for PWR transient observability and a typed Interface for scenario fault authoring. This gives procedures, UI, AI agents, and tests a single read-only place to inspect major transient state without scraping many variables.

Generated credibility evidence for the PWR reference family is exposed through generic process-plant evidence queries. This keeps benchmark artifacts browseable from the UI without making generic UI code import PWR-specific runtime or graph modules.

This is intentionally a Goldilocks model: lumped and deterministic, not RELAP/TRACE/CFD. It is suitable for Leitbild operational scenarios, alarm logic, overviews, and runbook exercises. It is not a licensing-basis safety analysis code.

Future deepening should continue inside the same boundaries:

- Replace heuristic pressure/boiling correlations with documented compact correlations where they materially improve scenario behavior.
- Add acceptance traces for each design-basis scenario family.
- Add typed fault profiles for recovery actions and scenario phase markers when a scenario needs them.
- Keep durable event logs for meaningful accepted events, not high-frequency process projections.
