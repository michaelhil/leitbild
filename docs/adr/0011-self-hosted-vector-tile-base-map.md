# ADR 0011: Self-Hosted Vector Tile Base Map

## Status

Accepted.

## Decision

Leitbild uses self-hosted vector tiles as the only base map paradigm.

The canonical map artifact is a versioned PMTiles archive containing MVT vector tiles generated from the Geofabrik Norway OpenStreetMap extract with Planetiler. The active artifact is exposed as `/map/tiles/current.pmtiles`, described by `/map/capabilities.json`, and rendered through `/map/style.json`.

No raster OpenStreetMap fallback is kept. If the vector artifact or glyphs are missing, the map must fail visibly during startup.

## Rationale

The raster OSM tile approach was useful for early bootstrapping, but it made the base map a fixed image background. Leitbild needs a controlled operational picture with stable styling, readable control-center colors, queryable map-layer capabilities, and a path toward self-contained deployments.

Vector tiles let Leitbild control road hierarchy, POI visibility, risk/context layers, labels, and future query affordances without making map context canonical operational truth.

## Consequences

- MapLibre remains the map renderer.
- Base-map context is vector-only.
- Operational objects, routes, traffic conditions, alerts, and overlays remain Leitbild-controlled MapLibre layers above the base map.
- Routing remains a separate routing adapter concern. Vector tiles do not replace OSRM, Valhalla, GraphHopper, or future routing engines.
- The map capability manifest is the machine-readable contract for simulation providers, UI surfaces, AI agents, and developer tooling.
- Breaking map schema changes increment the manifest schema version. No backward compatibility is preserved.
- Hetzner acts as the canonical conversion and hosting environment for sandbox production.

## Alternatives Considered

- **Keep raster OSM tiles**: simple, but visually and architecturally limiting.
- **Hosted vector tiles**: fast to adopt, but creates provider dependency, keys, usage limits, and less control.
- **Raw OSM as SVG**: poor fit for slippy-map interaction, labeling, zooming, and performance.
- **OpenMapTiles/PostGIS stack**: mature, but operationally heavier than a batch Planetiler pipeline.
- **Tilemaker**: useful and customizable, but Planetiler is the better first fit for fast reproducible Norway-scale builds.
 
