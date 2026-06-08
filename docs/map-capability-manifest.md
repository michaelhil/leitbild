# Map Capability Manifest

`/map/capabilities.json` is the machine-readable contract for Leitbild's self-hosted map-context data products.

It tells UI surfaces, pack runtimes, AI agents, and developer tooling what contextual map layers exist and which properties may be used.

## Principles

- The manifest is canonical; prose docs are explanatory.
- Tile data is context, not canonical operational state.
- Fields are intentionally normalized and bounded.
- Optional fields must be treated as absent unless present in a loaded tile feature.
- Breaking changes increment `schemaVersion`.
- No backward compatibility is preserved.

## Main Concepts

**Tileset ID**:
The named map product. Current base value: `leitbild-osm-norway`.

**Schema Version**:
The version of the map capability contract, not the OpenStreetMap extract date.

**Layer**:
A discoverable vector tile source layer with geometry, category, intended use, and fields.

**Terrain Tileset**:
An optional raster DEM PMTiles product advertised as `kind: "terrain"`. The current terrain contract uses Terrarium or Mapbox-encoded PNG tiles at `/map/terrain/current/{z}/{x}/{y}.png`, with TileJSON at `/map/terrain/current/tiles.json`. If `/opt/leitbild/maps/current/terrain.pmtiles` is absent or unreadable, the manifest still advertises the terrain entry with `availability.status: "unavailable"` so renderers and diagnostics do not fabricate elevation.

**Field Availability**:
`required` means the pipeline expects the field when the layer exists. `optional` means the field is useful when present but callers must handle absence.

## Intended Use By Consumers

UI:

- Build styles.
- Inspect map features.
- Enable or disable map-context tools.
- Decide whether drone/3D views can use real DEM terrain or must remain flat.

Pack runtimes:

- Understand which contextual map hints can be queried.
- Avoid hard-coded assumptions about unavailable fields.
- Keep routing logic separate from visual tile context.

AI agents:

- Receive bounded explanations of available map context.
- Avoid treating OSM-derived map context as live operational truth.

## V1 Categories

- `road_semantics`
- `operational_poi`
- `risk_context`
- `mobility_constraint`
- `base_context`

These categories are intentionally broad enough for ambulance, traffic, drone, robotaxi, maritime, and future control-center domains without pretending the base map is a pack.
