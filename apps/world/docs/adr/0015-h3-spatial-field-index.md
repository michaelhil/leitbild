# ADR 0015: H3 Spatial Field Index

## Status

Accepted.

## Context

The weather pack needs a scalable field model: every point should have queryable default weather, but only cells affected by weather objects or residual surface evolution should be materialized. The same kind of field will likely be useful for wildfire, radiation, population exposure, and other future packs.

The earlier weather implementation used pack-local axial hex math for visual cells. That was useful for proving the concept, but it created a second spatial-index vocabulary and made it too easy for UI code to become weather-specific.

## Decision

Use H3 as Leitbild's global hexagonal spatial field index, but hide the dependency behind `src/core/spatial/*`.

Rules:

- only the core spatial wrapper imports `h3-js`
- packs use core spatial functions such as `hexCellAtPoint`, `hexCellsForPolygon`, `hexCellBoundary`, and `hexParentCell`
- UI does not import H3 or pack field internals
- weather field computation remains inside the weather pack
- the generic map renderer receives provider-projected Pack map features with declared layer and style metadata

The weather pack now uses an H3 sparse field for ground truth computation. Default global conditions are implicit. Materialized cells are those currently affected by weather influence objects, those still evolving after a prior influence, or stable non-default cells that should remain queryable.

The UI receives weather as projected map features, not as a weather field store. The generic UI asks the active Pack for map feature query requests, then invokes the Simulation Run Capability. The Weather provider answers `world.weather.map-features` from its authoritative sampler. Weather map projection is split into:

- base H3 grid outlines for the current viewport and zoom
- affected H3 cells, including persistent ground conditions after an influence is removed
- weather influence shapes derived from keyframed ovals

Those feature families use the generic map feature renderer. The generic map must not import weather sparse-field code, weather condition calculators, or H3 directly. [ADR 0029](0029-authoritative-weather-and-read-only-pack-dependencies.md) defines authoritative sampling, bounded coverage and persistent ground mechanics.

## Consequences

Positive:

- one globally stable cell vocabulary for future field packs
- deterministic cell ids across clients, reloads, and server processes
- natural aggregation via H3 parent cells for lower zooms and larger regions
- a clean dependency boundary around H3
- less risk that weather-specific grid math leaks into generic UI code
- reusable cell ids for future pack-to-pack references, such as wildfire smoke over weather cells or radiation deposition over response assets

Tradeoffs:

- H3 is a real runtime dependency and must remain isolated
- Map visualization still needs careful feature budgeting by viewport and zoom
- exact rendered visual cells may be coarser than truth cells at low zoom
- the spatial index is shared, but pack field state is not; cross-pack use requires explicit query or interaction contracts

Rejected:

- pack-local axial hex grids, because they duplicate spatial indexing and are harder to share across packs
- square grids, because they are simpler but produce less natural neighborhood relationships for field phenomena
- materializing a global world grid, because default cells are cheap to answer implicitly and should not consume memory
- representing weather cells as `OperationalObject`s, because field cells are internal pack state, not operator-addressable entities
