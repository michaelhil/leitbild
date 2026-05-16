# ADR 0002: Core Domain Object Model

## Decision

Leitbild uses a canonical `OperationalObject` envelope for research/control-center state.

GeoJSON-compatible geometry is used inside the spatial model, but GeoJSON is not the full canonical object format.

`domainData` remains the domain-specific operational truth owned and validated by a domain pack.

`context` is optional perspective-bearing awareness: facts, activity, references, and summaries that describe what an asset, operator, system process, or AI perspective knows or remembers.

## Rationale

GeoJSON is excellent for geometry and map rendering, but Leitbild also needs operational state, telemetry summaries, tasking, alerts, ownership, communication state, provenance, timestamps, and domain-specific data.

Leitbild also needs artificial situation awareness for agents and operators. That awareness can be incomplete, stale, uncertain, or perspective-specific, so it must be separate from canonical operational truth.

## Consequences

- Map render data is derived from canonical objects.
- Domain modules validate their own `domainData`.
- Core validates the cross-domain `context` envelope.
- Coordinate helpers make longitude/latitude order explicit.
- Agent context views are derived from object state, domain data, context, and mission/task state; they are not persisted as canonical state.
