# ADR 0025: Pack, Runtime, Source, and Pack Data Terminology

## Status

Accepted.

## Context

Leitbild originally used `domain` for object ownership and `provider` for the active simulation implementation behind a pack. Those names became ambiguous as packs grew beyond classical domains. Weather is a capability pack, not a domain. Electric Grid combines topology, state estimation, load-flow, live data, and scenario behavior behind one capability boundary.

The older vocabulary now obscures the architecture:

- `domain` sometimes means pack ownership, sometimes physics discipline, and sometimes business area.
- `provider` sounds like an external service even when the implementation is an in-process runtime such as process-plant.
- `source` is already the correct word for external data feeds, reference-data inputs, route provenance, source code, and MapLibre sources.

## Decision

Use this vocabulary for active architecture and new code:

- **Pack**: the user-facing and architectural capability module. A scenario composes packs.
- **Pack runtime**: the active implementation that backs a pack inside a Simulation Run. A runtime may be a local simulation, a replay runtime, or a live adapter.
- **Source**: an external, reference, live-feed, map, route, or code input used by a runtime or UI surface.
- **Pack data**: pack-owned object payload on an `OperationalObject`.
- **Simulation Run event**: a committed event in canonical Simulation Run history.

Breaking renames:

- `OperationalObject.domain` becomes `OperationalObject.packId`.
- `OperationalObject.domainData` becomes `OperationalObject.packData`.
- `DomainId` becomes `PackId`.
- `DomainEvent` becomes `SimulationRunEvent`.
- `SimulationAdapter` becomes `PackRuntimeAdapter`.
- `SimulationConnection` becomes `PackRuntimeConnection`.
- `SimulationEvent` becomes `PackRuntimeEvent`.
- `simulationProviders` becomes `runtimes`.
- `defaultSimulationProviderId` becomes `defaultRuntimeId`.
- `providerOverrides` becomes `runtimeOverrides`.
- `providerConfigs` becomes `runtimeConfigs`.
- `providerId` becomes `runtimeId` for pack-runtime identity.
- `providerStateStore` becomes `runtimeStateStore`.

Process-plant variable metadata is a separate classification. Its `domain` field becomes `discipline` with values such as `thermal`, `hydraulic`, `electrical`, `control`, `chemical`, and `radiological`.

Do not add compatibility aliases for the old names. Scenario files, persisted Simulation Run state, API payloads, and tests should use the new vocabulary directly. Old persisted state may fail validation after this breaking change.

## Exceptions

Keep `source` where it truly means a source:

- reference-data `SourceId` and source loaders
- MapLibre sources and source layers
- route geometry source provenance
- process-link source/target endpoints
- displayed source code paths

Keep `provider` only for unrelated third-party or infrastructure concepts where the word is already precise, such as a routing provider selected by environment configuration. Do not use `provider` for pack runtime backing.

## Consequences

The electric grid pack and future packs can use the same clear stack:

```text
scenario -> packs -> pack runtimes -> sources
object -> packId + packData
history -> Simulation Run events
```

This is a broad breaking rename. The benefit is a cleaner vocabulary before additional packs deepen the architecture.
