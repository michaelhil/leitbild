# ADR 0004: Map Rendering Strategy

## Decision

Leitbild starts with MapLibre GL JS for the operational map.

The base map is self-hosted vector tiles, not raster tiles. See ADR 0011.

**Critical performance rule: imported/reference geometry is not operational-object geometry.** Large imported layers such as electric-grid corridors, airspace boundaries, contours, road context, or facility footprints must render as reference vector tiles plus sparse dynamic feature-state or sparse operational overlays. `OperationalObject`s are for operator-relevant live assets, controllers, loads, generators, branches, incidents, and other shared operational truth. A few hundred operational objects on a map is expected to be trivial and must stay visible; the rule is about avoiding future designs that turn tens of thousands of passive reference segments into live Control Instance objects.

MapLibre remains the operational map engine. Babylon.js is allowed for pack-specific 3D/FPV visualization when the surface is not the operational map itself. deck.gl remains deferred until a concrete visualization requirement justifies it.

## Rationale

The first research slice needs a persistent, interactive, layered, real-time operational map. MapLibre provides a WebGL map foundation without committing the project to heavier visualization stacks too early.

## Consequences

- Domain objects are projected into map view models above the vector base map.
- Slow-moving contextual geometry is rendered through pack-owned reference datasets, not projected through the Control Instance object/update loop.
- Dynamic map rendering is split by cadence: base map loads once, reference layers load on style setup, sparse operational sources update on object changes, pack query layers refresh on their own query cadence, and selected/hovered rich UI uses sparse overlays.
- Rich mini-trends and inspectors are rendered as UI overlays, not as canonical map data.
- Babylon.js is a pack-specific 3D visualization dependency for drone views, not the base map engine.
- deck.gl remains optional and unintroduced.
- Raster OpenStreetMap fallback paths are not part of the architecture.
