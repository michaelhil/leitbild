# ADR 0019: Reference Data Pipeline

## Status

Proposed. Promoted to Accepted once Phase A.7 confirms the landed code matches this decision.

## Context

Leitbild repeatedly needs to ingest slow-moving, externally-sourced, geospatial reference data and surface it on the map as contextual information for operators, packs, scenarios, and AI agents.

Examples that are already on the horizon:

- Norwegian airspace polygons (FIR, TMA, CTR, CTA, ATZ, R/P/D, class A–G) from OpenAIP.
- Avinor airport points and runway polygons from GeoNorge.
- Hand-authored scenario overlays such as a process-plant exclusion zone around the Halden site.
- Future candidates: hospital locations, road restrictions, marine zones, wildfire fuel maps, fire-station coverage.

These all share five properties:

1. **Slow cadence** (weekly to yearly), not real-time.
2. **Contextual**, not canonical operational truth.
3. **Vector-renderable** (polygons, lines, points).
4. **Read-only** at runtime.
5. **Licensed**, each source carrying its own attribution and use restrictions.

This is the definitional shape of a Map Context Layer, already named in `CONTEXT.md` and the Map Capability Manifest, but until now Leitbild has only had one such tileset (the OSM base map produced by `docs/vector-tile-pipeline.md`), and its build path lives in `scripts/` with no runtime library because nothing in `src/` consumes it programmatically.

The next generation of needs is different. Packs and AI agents must be able to ask "what airspace is this point in" or "what hospitals are within 5 km of this route". That requires a server-side spatial index, which requires a runtime library, not just build scripts.

We previously rejected aero-nav as a source because its licence restricts use to private PC flight simulation. We previously chose OpenAIP (CC BY-NC-SA 4.0) plus GeoNorge (NLOD 2.0) as the right starting sources, both legally usable for a research platform with attribution. Those source decisions are in ADR 0020. This ADR is about the abstraction that lets those decisions be implemented without baking either source into core code.

## Decision

Reference data is a first-class architectural primitive in Leitbild, distinct from operational truth, served as a per-dataset pair of artifacts (PMTiles for the browser, sidecar GeoJSON for the server), discovered through the existing `/map/capabilities.json` manifest, indexed in-process for pack consumers, and rendered through a manifest-driven UI factory.

### Placement

The runtime library lives at `src/reference-data/` as a top-level peer of `src/map/`, `src/simulation/`, `src/scenarios/`, `src/routing/`, `src/core/`, `src/packs/`, and `src/ui/`. The existing codebase reserves `src/core/` for the abstract model and protocol primitives (`core/model`, `core/packs`, `core/scenarios`, `core/spatial`, `core/control-instances`, `core/api`) and places larger runtime-layer concerns at the top level as peers (`src/map/` for map artifacts, `src/simulation/` for the simulation hub). Reference data is a runtime layer in the same shape as `src/map/`: it produces and serves artifacts that the rest of the system consumes. Top-level placement matches that precedent.

The build CLI lives at `scripts/reference-build.ts` and `scripts/reference-promote.ts`, mirroring the existing `scripts/maps-*` split for OSM.

The deploy artifacts (systemd unit, timer, pull script) live under `deploy/`, named with the `leitbild-reference-*` prefix to avoid collision with the existing `leitbild-pull-deploy-*` and any future `leitbild-maps-*` units.

Per-dataset on-disk layout on Hetzner mirrors the existing OSM tile layout:

```text
/opt/leitbild/reference/
  sources/<source-id>/<sha256>.<ext>          # cached raw fetches
  builds/<dataset-id>/<build-id>/
    <dataset-id>.pmtiles
    <dataset-id>.features.geojson             # sidecar, see ADR 0021
    <dataset-id>.manifest.json
    audit-report.json
    build.json
  releases/<dataset-id>/current               # atomic symlink
```

### The protocol surface

The entire abstraction is one config interface plus two functions. There are no source/parser/index protocol classes. Plain async functions compose into a pipeline. This is intentional: protocols add value when a second implementation arrives, not in anticipation of one.

```ts
export type DatasetSource =
  | { kind: 'manual'; path: string }
  | { kind: 'remote'; id: string;
      fetch: (cache: FetchCache) => Promise<RawBytes>;
      parse: (raw: RawBytes) => Promise<Feature[]> }

export interface DatasetConfig {
  readonly id: string
  readonly featureSchema: ZodSchema
  readonly sources: ReadonlyArray<DatasetSource>
  readonly tilebuild: TilebuildConfig
  readonly licences: ReadonlyArray<LicenceRef>
  readonly audit?: (features: Feature[]) => void
}

export const buildDataset:   (cfg: DatasetConfig)               => Promise<BuildId>
export const promoteBuild:   (datasetId: string, b: BuildId)    => Promise<void>
```

The server-side spatial consumer is a single function returning a single-method index:

```ts
export const referenceIndex = (datasetId: string): {
  featuresContainingPoint(point: GeoJsonPoint, opts?: QueryOpts): Feature[]
}
```

Additional methods (`featuresInBbox`, `nearestK`, etc.) are added only when a real caller asks for them.

### Pack contract change

One optional field is added to `LeitbildPack`:

```ts
readonly referenceDatasetRefs?: ReadonlyArray<string>
```

Packs reference datasets by string id. Datasets remain neutral (they live in `src/reference-data/datasets/`, not inside packs), preserving pack independence. A future drone pack and the ADSB pack can both consume `aero-norway` without depending on each other.

The change is backwards compatible. Existing packs ignore it.

### Per-dataset PMTiles, not a single combined tileset

Each dataset gets its own PMTiles file. We considered a single combined tileset with named source-layers; we chose per-dataset because cadence, licence, and rollback are dataset-scoped concerns and a combined tileset entangles them. The browser cost (one HTTP request per dataset's first viewport read) is amortised by long cache headers and PMTiles' range-byte reads.

### Manifest discovery

The promote step rewrites the full `/map/capabilities.json` atomically. Fragments are not merged at request time; that simplification removes a class of read/write coordination bugs and keeps the server hot-path read-only.

Promoting to schema version 2 introduces a `tilesets: [...]` array entry replacing the single-tileset shape. All consumers of the manifest (server, UI, AI-agent context builders) are updated in lock-step. This migration ships in Phase A.6 alongside the first real dataset promote; earlier phases write per-dataset manifest fragments to disk without touching the live `/map/capabilities.json` response.

### Build dependency

The pipeline invokes `tippecanoe` as a subprocess. It must be installed on any host that runs `bun run reference:build`. A small `deploy/setup-reference.sh` installs it on Hetzner the same way `deploy/setup-osrm.sh` provisions OSRM. Local development on macOS uses Homebrew.

We do not unify this with Planetiler. Planetiler is the right tool for OSM PBF; tippecanoe is the right tool for streaming GeoJSON. Wrong-tool either direction.

### What this decision does not include (explicit YAGNI list)

The following were considered and rejected from v1. Each is recoverable if and when a real caller needs it; none of them block the abstraction now.

- Streaming async iterator parsers. Datasets up to ~200 MB normalized fit in memory.
- A merger / dedupe protocol. The first datasets do not overlap. When two sources cover the same category, a per-category priority object is sufficient.
- A multi-method spatial index (`featuresInBbox`, `nearestK`). The first caller needs only point-in-polygon.
- Manifest fragment merging at request time. Promote rewrites the full manifest.
- Server-side PMTiles parsing. The sidecar GeoJSON satisfies all current server-side reads (see ADR 0021).
- Retrofitting the OSM tileset through this abstraction. OSM has no runtime consumer; converting it would be churn without benefit.
- Per-dataset HTTP endpoints. Tiles are served by the existing Caddy from static files; the discovery manifest is the single public surface.

## Consequences

- **One HTTP server rule preserved.** The pipeline is a CLI and a systemd timer; serving is static; the spatial index runs in-process inside the existing `src/core/api/server.ts`.
- **`src/core/spatial/` (H3) and `src/reference-data/spatial-index.ts` (rbush + turf polygon PIP) are siblings, not parent/child.** They solve different problems: H3 is for sparse field indexing (weather cells); rbush + turf is for polygon point-in-polygon over vector reference data.
- **Disk usage** roughly doubles per dataset because of the sidecar GeoJSON. Trade-off accepted in ADR 0021.
- **Manifest schema version bumps to 2.** Existing consumers must be updated in A.1. Wiki and `docs/map-capability-manifest.md` note the migration.
- **New runtime dependencies**: `@turf/boolean-point-in-polygon`, `@turf/helpers`, `rbush`. All small. Tree-shakable. Added in A.1.
- **New build dependency**: `tippecanoe` on the Hetzner build host. Provisioned by `deploy/setup-reference.sh` in A.6.
- **Pack contract changes by one optional field.** No existing test breaks.
- **Each new dataset is "config + parser + style + register".** Typically four small files, no infrastructure code. The abstraction earns its keep at dataset count two.
- **OpenAIP and GeoNorge specific decisions** are in ADR 0020 and the in-repo design doc `docs/reference-data-pipeline.md`; this ADR remains source-agnostic.
- **Sidecar artifact strategy** is in ADR 0021.
- **Manual GeoJSON overlays** (e.g. the Halden process-plant exclusion zone) live as `data/reference/manual/*.geojson` in the repo, referenced by dataset configs as `{ kind: 'manual', path }`. Repo-tracked data overlays are explicitly first-class, not a workaround.

## Forward-looking caveats

- Datasets exceeding ~200 MB normalized should switch to a streamed parser path and a chunked sidecar layout. Revisit when that case arises.
- If multiple datasets begin to share large fetch infrastructure (e.g. a fleet of GeoNorge WFS endpoints), the source helper module `src/reference-data/sources/geonorge-wfs.ts` may be promoted to its own folder. Not a v1 concern.
- If a commercial Leitbild deployment becomes a real prospect, the OpenAIP source must be swapped for a paid licensed source. The data layer is pluggable specifically to make that swap a config change, not a code change.

## Amendment — 2026-05-26 (Phase B)

The "datasets are neutral" claim is corrected: **datasets are pack-owned; the pipeline is neutral.** See ADR 0022 for the rationale and the file-move from `src/reference-data/datasets/` and `src/reference-data/sources/` into `src/packs/aviation/`. The pipeline infrastructure listed under "Placement" above (types, pipeline, fetch-cache, tippecanoe, manifest-writer, capabilities, spatial-index, point-in-polygon, licences, registry, manual.ts, geonorge-wfs.ts) remains in `src/reference-data/`. Aviation-specific code (OpenAIP source, Avinor airports source, vertical-limit converter, airspace/airport/overlay schemas, aero-norway dataset, aero-norway style module, Halden overlay) moves into `src/packs/aviation/`. The pack-protocol field added in this ADR is renamed and re-shaped: `referenceDatasetRefs?: ReadonlyArray<string>` (string-id reference into a neutral registry) is replaced by `referenceDatasets?: ReadonlyArray<DatasetConfig>` (direct contribution). The "What this decision does not include" YAGNI list still stands. Phase B.0 makes the amendment; Phase B.1 carries out the file moves.
