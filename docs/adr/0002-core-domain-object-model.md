# ADR 0002: Core Domain Object Model

## Decision

Leitbild uses a canonical `OperationalObject` envelope for research/control-center state.

GeoJSON-compatible geometry is used inside the spatial model, but GeoJSON is not the full canonical object format.

## Rationale

GeoJSON is excellent for geometry and map rendering, but Leitbild also needs operational state, telemetry summaries, tasking, alerts, ownership, communication state, provenance, timestamps, and domain-specific data.

## Consequences

- Map render data is derived from canonical objects.
- Domain modules validate their own `domainData`.
- Coordinate helpers make longitude/latitude order explicit.
