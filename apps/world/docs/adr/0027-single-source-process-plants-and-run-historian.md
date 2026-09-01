# ADR 0027: Single-source Process Plants and Run Historian

## Status

Accepted.

## Context

Process Plant scenarios described one plant twice: a Pack-configured process system owned its graph and runtime settings, while a Scenario Item owned its map-visible unit and referred back through `systemId`. Plant construction also exposed inline graphs, graph references, graph assemblies, fragments, presets, parameter overlays, initial-state overlays, and separately parsed runtime configuration. The resulting paths overlapped and made discovery and editing harder than the underlying fixed-step runtime required.

Process displays, procedure integration, demo transients, and local telemetry grew as adjacent mechanisms. Several contain PWR-specific assumptions behind nominally generic interfaces. Local telemetry also retains unbounded series inside periodically rewritten runtime checkpoints, while other World Packs have no equivalent historical-data boundary.

## Decision

A Process Plant Scenario Item is the single authored description of a Plant. It selects a Plant Model, Operating Point, Automation Definition, location, and Pack-owned presentation metadata. Scenario compilation derives both the Operational Object projection and Pack runtime definition from that Item. Pack configuration contains only genuine Pack-wide settings.

Plant Models are validated graph data produced by a typed Pack-owned model definition. Built-in PWR variants are resolved inside the PWR definition from one validated reference template using PWR-local loop selection; product code does not derive variants by broad string substitution over ids or variable paths. The compiled flat graph remains the only runtime topology. Loop grouping is model metadata, not a nested runtime actor hierarchy.

The Process Plant calculation kernel remains Pack-owned, deterministic, fixed-step, and code-reviewed. Component behavior is registered with its Component Type, compiled immutable plans may be shared by Plants using the same model digest, and each Plant keeps an independent variable table. PWR-only topology checks, diagnostics, assessments, actions, displays, and automation remain PWR contributions rather than base-kernel behavior. Arbitrary equations and runtime-loaded physics plugins remain unsupported.

Action Presets are the one reusable boundary for parameterized failures and transients. They expose validated parameters and resolve through the same command and queued-write path used by operators, Scenario Timelines, and agents. Process Displays expose validated palette and binding metadata, while Pack-owned renderers remain reviewed code. This decision does not create a universal cross-Pack display language.

Procedures form a cohesive optional World feature. They read Pack-owned signals and named assessments through generic operation descriptors rather than Process Plant procedure-specific queries. Procedure sources are configurable; Procedure remains external to Process Plant physics and I&C.

The Historian is an optional Simulation Run service that persists only explicitly selected Pack observations. Packs publish named Recording Profiles and their runtimes emit typed series descriptors with batched samples when a Scenario selects one. There is no intermediate policy language or hand-authored signal list. The existing Durable Journal remains the source of meaningful committed events; the Historian does not duplicate it. Runtime checkpoints never contain historical series. The durable sample store is per-Run SQLite behind a narrow Run-owned interface.

## Consequences

- A Plant cannot have a dangling or mismatched separately authored runtime system.
- Existing scenarios and tests are rewritten to the new schema; no legacy parser, aliases, migration, or compatibility adapter is retained.
- Catalog discovery becomes schema- and metadata-driven rather than source-file-driven.
- The large fixed PWR graph variants, substitution assembly, runtime-private schedule, static demo-transient UI registry, and local unbounded telemetry are removed.
- Identical Plant Models can share compiled immutable structures without sharing runtime state.
- AI agents can discover model parameters, components, signals, actions, assessments, displays, and recording choices without receiving executable code.
- Process Plant remains one World Pack; Component Types, Automation Definitions, Action Presets, and Process Displays do not become independent Packs.
- Historian recording is opt-in and bounded. The Process Plant and Ambulance Packs prove that the boundary supports both static solver variables and dynamic Operational Objects without a universal signal schema.
- The Durable Journal remains meaningful operational history rather than a dense process trace.

## Guardrails

- Do not reintroduce a separate authored process-system list joined to Plant Items by id.
- Do not add alternative inline/ref/assembly startup paths around the Plant Model definition boundary.
- Do not use arbitrary string substitution as the model-composition mechanism.
- Do not move PWR assumptions into the generic Process Plant graph or runtime kernel.
- Do not allow generated executable display, procedure, action, or physics code.
- Do not record all Pack-private variables by default or store time series in runtime checkpoints.
- Do not make Historian samples canonical current World state.
