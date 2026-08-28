# Reference Data Pipeline

This document is the operator-facing companion to ADR 0019, ADR 0020, and ADR 0021. It describes how reference data (slow-moving, externally-sourced, contextual geospatial data) is ingested, built, served, and consumed in Leitbild.

## What is reference data?

Reference data is everything geospatial in Leitbild that is **not canonical operational truth**. It is contextual, slow-moving, externally-sourced, vector-renderable, read-only at runtime, and carries its own licence.

| Example | Source kind | Cadence |
|---|---|---|
| Norwegian airspace polygons | OpenAIP API | Weekly conditional fetch |
| Avinor airport points | GeoNorge WFS | Weekly conditional fetch |
| Halden process-plant exclusion zone | Hand-authored GeoJSON in repo | On commit |
| (future) Hospitals, road restrictions, marine zones, fuel maps | GeoNorge / OSM / Miljødirektoratet | Per source |

Reference data is rendered behind operational objects on the map, queryable by packs through a server-side spatial index, and discoverable through the existing Map Capability Manifest at `/map/capabilities.json`.

It is distinct from the base map (OSM PMTiles via Planetiler, see `docs/vector-tile-pipeline.md`) and from live operational truth (runtime-owned simulation state, see ADR 0003).

## Architecture summary

Five stages, one runner, per-dataset artifacts:

```text
remote/manual sources
       │  fetch  (conditional GET; manual = file read)
       ▼
   raw bytes
       │  parse  (source-specific; emits canonical Feature[])
       ▼
   validated features
       │  audit  (throws on schema regression or coverage drop)
       ▼
   tile build  (tippecanoe → <id>.pmtiles)
   sidecar     (write <id>.features.geojson alongside)
       │
       ▼
   promote  (atomic symlink swap; rewrite /map/capabilities.json)
```

Every dataset is produced by one call to `buildDataset(config)` followed by one call to `promoteBuild(id, buildId)`. Both live in `src/reference-data/pipeline.ts`.

## Disk layout on Hetzner

```text
/opt/leitbild/reference/
  sources/
    openaip/<sha256>.json.zst
    geonorge-lufthavn/<sha256>.gml.zst
    manual/<files-tracked-in-repo>
  builds/
    <dataset-id>/<build-id>/
      <dataset-id>.pmtiles
      <dataset-id>.features.geojson
      <dataset-id>.manifest.json
      audit-report.json
      build.json
  releases/
    <dataset-id>/
      current -> /opt/leitbild/reference/builds/<dataset-id>/<build-id>/
```

The last three builds per dataset are retained for rollback. Caddy serves `/map/datasets/<id>/current.pmtiles` from `releases/<dataset-id>/current/`.

## Commands

All commands run with Bun. Per-dataset filter is optional.

```sh
bun run reference:build                       # build all registered datasets
bun run reference:build --dataset aero-norway # build one
bun run reference:build --force               # ignore conditional-GET cache
bun run reference:promote --dataset aero-norway
bun run reference:promote --dataset aero-norway --build <build-id>   # roll back
bun run reference:status                      # print current symlink targets and AIRAC/build ids
```

Reference publication is deliberately separate from code deployment and is not
scheduled. An operator runs the relevant `reference:*` commands explicitly from
`/opt/leitbild/current` after checking source availability and disk headroom.

## Environment variables

Documented also in `data/secrets.example.env`.

| Variable | Required for | Notes |
|---|---|---|
| `OPENAIP_API_KEY` | OpenAIP source | Free at `accounts.openaip.net`. Never committed. |
| `GEONORGE_USER_AGENT` | GeoNorge sources | Optional but recommended; some endpoints request a meaningful User-Agent. Defaults to `"leitbild/<version> (research)"`. |
| `LEITBILD_REFERENCE_ROOT` | Pipeline | Defaults to `/opt/leitbild/reference` on the deploy host. Useful to override locally. |

## Authoring a new dataset

Three files, plus one entry in the registry. No infrastructure code.

1. **A `DatasetConfig`** in `src/reference-data/datasets/<id>.ts`. Declares sources, feature schema, tile-build config (per-category zoom and simplification), licences, and an audit function.
2. **A style module** in `src/ui/map/dataset-styles/<id>.ts`. Returns the MapLibre paint/layout for each category. The UI factory applies it automatically.
3. **A source module** in `src/reference-data/sources/<source-id>.ts` only if a new fetch/parse shape is needed. Existing source helpers (`geonorge-wfs.ts`, `openaip.ts`, `manual.ts`) are reused when possible.
4. **A registration line** in `src/reference-data/registry.ts` importing the dataset config.

Packs opt into the dataset by adding its id to their `referenceDatasetRefs` array.

## Attribution

The map's attribution control composes one line per active licence from each tileset's `licences[]` array in `/map/capabilities.json`. There are no hard-coded attribution strings anywhere in the UI.

Authoring a dataset config requires declaring its `licences[]`. Build failure if a licence ref is unknown to the licence registry in `src/reference-data/licences.ts`.

## Rollback procedure

If a promoted build is bad:

```sh
bun run reference:status                      # find the last-known-good build id
bun run reference:promote --dataset <id> --build <previous-build-id>
```

The promote step atomically swaps the symlink and rewrites `/map/capabilities.json` to reference the rolled-back build. Clients pick up the new tile content on next viewport read. The bad build remains on disk under `builds/` for inspection.

## Build failure handling

Per AGENTS.md's "avoid silent fallbacks" rule, the build fails loudly when:

- A parsed feature does not match the dataset's feature schema (zod parse failure above a small per-build threshold).
- A coverage audit threshold is not met (e.g. expected minimum FIR or TMA count).
- The PMTiles output cannot be opened or has zero tiles.
- The sidecar GeoJSON cannot be written or is empty.

A failed build does not promote. The previous release remains active. The build directory and `audit-report.json` are kept for inspection.

## Server-side consumption

Packs may query a dataset's features at runtime:

```ts
import { referenceIndex } from '@/core/reference-data/spatial-index'

const aero = referenceIndex('aero-norway')
const enclosing = aero.featuresContainingPoint(
  { type: 'Point', coordinates: [11.39, 59.12] },
  { layers: ['airspace'], altitudeM: 1500 },
)
```

The index is lazy-loaded on first call and reloads automatically when the dataset is promoted. Implementation details and forward-looking caveats are in ADR 0021.

## Cross-references

- **ADR 0019** — the abstraction and where it lives.
- **ADR 0020** — OpenAIP and GeoNorge as sources for the first dataset.
- **ADR 0021** — the sidecar GeoJSON decision.
- **`docs/vector-tile-pipeline.md`** — the OSM base map pipeline that this one parallels.
- **`docs/map-capability-manifest.md`** — the discovery contract.
- **Wiki**: `reference-data.md` (architecture) and `domains/airspace.md` (the first dataset).
