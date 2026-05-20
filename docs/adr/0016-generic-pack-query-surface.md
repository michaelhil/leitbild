# ADR 0016: Generic Pack Query Surface

## Status

Accepted.

## Context

Leitbild needs read-only access to pack-owned computations that are not canonical Control Instance object state.

Examples:

- weather at a point
- weather along a route
- weather H3 map features from the provider-owned sparse field
- traffic conditions affecting a route
- ambulance dispatch state summaries

Adding bespoke HTTP endpoints for each domain would make core and generic UI modules increasingly domain-specific. Reading only from operational objects is also insufficient because some packs maintain provider-private computational state. The weather sparse H3 field is the first clear example: it stores materialized cells, residual evolution, and stable non-default cells that should not become `OperationalObject`s.

## Decision

Use one generic read-only pack query route:

```text
POST /api/control-instances/:id/queries
```

The request envelope is:

```ts
interface PackQueryRequest {
  readonly packId: string
  readonly kind: string
  readonly payload: unknown
}
```

Core validates the envelope and routes it to the active simulation provider for `packId` through the Simulation Hub. The provider validates the query-specific payload and returns either a result or an explicit failure.

Queries are not commands. Query handlers must not mutate provider state, emit events, or commit canonical changes.

Weather map rendering uses this surface. The weather pack contributes `mapAreaFeatureQueries`; the UI calls those queries and caches the returned `PackMapAreaFeature`s for MapLibre source updates. This keeps `MapSurface` generic and synchronous from MapLibre's perspective while allowing weather rendering to use provider-owned H3 truth.

Provider-backed map features may include optional visual animation metadata and an attached symbol anchor. Weather uses this for influence ovals: the provider returns the current and next projected geometry plus anchor points, and the UI interpolates the rendered polygon and cloud icon between query refreshes. The interpolation is presentation-only; H3 affected cells and sparse-field truth remain provider-owned and query-backed.

## Consequences

Positive:

- core remains pack-agnostic
- AI agents and tests get a stable read-only API surface
- provider-private computational state can be exposed intentionally without becoming canonical object state
- future packs can add read models without new HTTP route families
- weather H3 rendering now uses provider sparse-field truth rather than UI-side weather recomputation

Tradeoffs:

- the query surface is another boundary that must be validated and documented
- query kind names must remain disciplined and namespaced
- UI code needs a small async cache for provider-backed map features
- synchronous contextual fields still need separate design if they must depend on provider-private state

Rejected:

- hardcoded `/api/weather/*`, `/api/traffic/*`, and `/api/ambulance/*` endpoints, because they contaminate core
- arbitrary provider RPC, because it would blur commands and queries
- materializing provider field cells as operational objects, because field cells are internal computational state
- UI-side weather recomputation, because it misses provider-owned sparse-field memory
