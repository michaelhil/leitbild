# Reference Data Pipeline

Reference data is read-only geospatial context, separate from live simulation objects and the base map. Electric Grid currently contributes the `grid-norway` dataset.

## Ownership and discovery

- Each Pack owns its dataset builder, feature schemas, source adapters and map style.
- `src/reference-data/` owns the shared fetch cache, validation/build pipeline, manifests, attribution and spatial index.
- `src/app-assembly.ts` assembles Packs; `collectRegisteredDatasets(worldPacks)` discovers their `referenceData.builders` without fetching data.
- The map capability manifest at `/map/capabilities.json` discovers published datasets. The UI registers the active Packs' dataset IDs using the style registry in `src/ui/map/reference-data-controller.ts`.
- Adding a dataset still requires registering its style in that UI registry; styles are not dynamically downloaded.

## Build and publication

The pipeline loads sources, validates features, applies the dataset audit, writes a sidecar GeoJSON, runs tippecanoe, and writes the dataset manifest and audit report. Promotion changes the dataset's current symlink. A failed build is not automatically promoted.

```text
/opt/leitbild/reference/
  sources/<source-id>/                    cached source data
  builds/<dataset-id>/<build-id>/         immutable artifacts and audit report
  releases/<dataset-id>/current           symlink to published build
```

PMTiles provide browser rendering; the sidecar provides server-side feature queries. Caddy serves artifacts beneath `/map/datasets/<dataset-id>/current/`.

Run these commands from `apps/world`:

```sh
bun run reference:build --dataset grid-norway
bun run reference:promote --dataset grid-norway --build <build-id>
bun run reference:status
bun run reference:prune
bun run reference:prune -- --yes
```

Pruning is dry-run by default and retains the current build plus the newest three builds per dataset. Publication is an explicit operator action, independent of code deployment; no scheduled source-pull service is installed.

## Grid source configuration

`src/packs/electric-grid/reference-datasets.ts` is the authoritative configuration entry point. The default source is OSM PBF; `GRID_NORWAY_SOURCE` can select `overpass` or `nve-nettanlegg`. Source-specific URLs, the PBF path, User-Agent and geographic extent are optional environment configuration documented by that builder. `LEITBILD_REFERENCE_ROOT` overrides the artifact root.

Source attribution and licensing remain dataset metadata; the UI composes attribution from the published manifests.

## Adding a dataset

1. Implement its schema, source parsing, audit and `DatasetConfig` inside the owning Pack.
2. Contribute a builder through `referenceData.builders` at application assembly.
3. Implement its Pack-owned map style and register it in the UI style registry.
4. Test validation, build failure behavior, manifest discovery and map rendering.

Reuse shared fetching and manual-file helpers where their semantics fit. Do not move dataset-specific parsing into core.

## Server-side queries

`referenceIndex(datasetId, releaseRoot)` in `src/reference-data/spatial-index.ts` asynchronously loads the sidecar and returns `featuresContainingPoint([longitude, latitude], options)`. It uses bounding-box filtering followed by polygon containment, with optional category and altitude filters. It is not a road network, elevation service or simulation state store.

See ADR 0019 for the ownership decision, ADR 0021 for sidecar artifacts, and `docs/vector-tile-pipeline.md` for the separate base-map pipeline.
