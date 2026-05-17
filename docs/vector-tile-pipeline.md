# Vector Tile Pipeline

Leitbild's base map is built from OpenStreetMap data into a self-hosted PMTiles artifact. The production sandbox uses Hetzner as the canonical conversion and hosting environment.

## Goals

- Use one vector map paradigm; do not keep raster OSM fallbacks.
- Generate Norway-scale vector tiles from a Geofabrik `.osm.pbf` extract.
- Keep the conversion repeatable, inspectable, and batch-oriented.
- Expose a machine-readable capability manifest so UI surfaces, simulation providers, and AI agents know which map-context layers exist.
- Keep map context separate from canonical operational truth.

## Hetzner Layout

```text
/opt/leitbild/maps/
  sources/
    norway-latest.osm.pbf
  tools/
    planetiler.jar
  fonts/
    Noto Sans Regular/
      0-255.pbf
      ...
  builds/
    <build-id>/
  releases/
    leitbild-osm-norway/
      <build-id>/
        norway.pmtiles
        capabilities.json
        style.json
        build.json
  current -> /opt/leitbild/maps/releases/leitbild-osm-norway/<build-id>
```

`current` is replaced atomically by the promotion script. Leitbild and Caddy read only from `current`.

## Commands

Hetzner prerequisites:

- Java 21 runtime for Planetiler.
- `curl`.
- enough disk for the source extract, build scratch data, and PMTiles release.

The default Planetiler heap is `3g` so the pipeline can run on the current Hetzner sandbox class. Larger machines should set `LEITBILD_PLANETILER_JAVA_XMX`, for example `12g` on a Mac Studio or larger server.

The initial Hetzner sandbox has 3.7 GiB RAM, 8 GiB swap, and 2 vCPU. Planetiler can run there, but it warns that the OS page cache is constrained for memory-mapped temporary files. A 16 GiB / 8 vCPU conversion host is the preferred operating target once map rebuilds become routine.

Run these on Hetzner from `/opt/leitbild/app`:

```sh
LEITBILD_MAP_ROOT=/opt/leitbild/maps bun run maps:rebuild
LEITBILD_MAP_ROOT=/opt/leitbild/maps bun run maps:status
```

The build id defaults to a timestamp. Set `LEITBILD_MAP_BUILD_ID` when you want a predictable release name.

Recommended memory settings:

```sh
# Current small Hetzner sandbox
LEITBILD_PLANETILER_JAVA_XMX=3g

# Preferred 16 GiB conversion host
LEITBILD_PLANETILER_JAVA_XMX=10g
```

The individual steps are also available when debugging:

```sh
LEITBILD_MAP_ROOT=/opt/leitbild/maps LEITBILD_MAP_BUILD_ID=<build-id> bun run maps:download
LEITBILD_MAP_ROOT=/opt/leitbild/maps LEITBILD_MAP_BUILD_ID=<build-id> bun run maps:fonts
LEITBILD_MAP_ROOT=/opt/leitbild/maps LEITBILD_MAP_BUILD_ID=<build-id> bun run maps:build
LEITBILD_MAP_ROOT=/opt/leitbild/maps LEITBILD_MAP_BUILD_ID=<build-id> bun run maps:promote
```

## Conversion Engine

The pipeline uses Planetiler's OpenMapTiles-compatible profile. The initial layer set is intentionally constrained:

- `landcover`
- `landuse`
- `water`
- `waterway`
- `building`
- `transportation`
- `transportation_name`
- `poi`
- `aeroway`
- `boundary`
- `place`

This covers road semantics, operational POIs, risk/context layers, and mobility constraints without carrying the full OSM tag universe.

Glyphs are mirrored into `/opt/leitbild/maps/fonts` from the OpenMapTiles generated font endpoint. After mirroring, production serves glyphs locally through Caddy; the browser does not depend on the external font endpoint at runtime.

## Artifact Contract

- Tile archive: `/map/tiles/current.pmtiles`
- Style: `/map/style.json`
- Capability manifest: `/map/capabilities.json`
- Glyphs: `/map/fonts/{fontstack}/{range}.pbf`

Caddy serves the large PMTiles archive and glyph files directly. The Leitbild server serves style and capability metadata and can also serve PMTiles for local development if `LEITBILD_MAP_ROOT` points at a valid artifact.

## Schema Evolution

The capability manifest is canonical. Documentation explains the manifest, but simulation providers and developer tools should read the manifest itself.

Rules:

- Additive map-layer fields require a new tile build and manifest update.
- Breaking changes increment `schemaVersion`.
- No backward compatibility is preserved.
- Do not expose raw OSM tag dumps as a convenience. Normalize only fields with a clear operational use.
- Do not treat tile features as operational objects. They are contextual map data.

## Baked-In V1 Feature Scope

Road semantics:

- road class
- road labels
- bridge/tunnel hints where available
- one-way/access/service/maxspeed hints where available

Operational POIs:

- hospitals
- fire stations
- police
- doctors/pharmacies
- helipads
- airports/ports
- fuel/charging where available

Risk/context:

- land use
- land cover
- water and waterways
- buildings
- administrative boundaries

Mobility constraints:

- service/restricted roads where available
- ferries and rail where available
- aeroway/runway context

## Verification

After promotion:

```sh
curl -fsS https://leitbild.samsinn.app/map/capabilities.json
curl -fsS https://leitbild.samsinn.app/map/style.json
curl -fsSI https://leitbild.samsinn.app/map/tiles/current.pmtiles
curl -fsSI https://leitbild.samsinn.app/map/fonts/Noto%20Sans%20Regular/0-255.pbf
```

The browser startup modal should complete the map step only after MapLibre loads the vector style and PMTiles source.
