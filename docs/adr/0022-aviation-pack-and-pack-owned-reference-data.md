# ADR 0022: Aviation Pack And Pack-Owned Reference Data

## Status

Proposed. Promoted to Accepted once Phase B implementation lands and matches.

## Context

Phase A built a generic reference-data pipeline and used it to ship Norwegian airspace polygons (OpenAIP) plus Avinor airport points (GeoNorge) as a tileset named `aero-norway`. The dataset, its sources, schemas, visual style, and the Halden exclusion overlay all lived under `src/reference-data/` as "neutral" reference data. The map UI mounted a free-floating `MapLayersPanel` overlay top-right of the map to toggle visibility.

Two things are wrong with that placement now:

1. The UI doesn't fit the Leitbild rail model. Every other domain (`ambulance`, `weather`, `traffic`, `process-plant`) renders its controls inside the pack rail and activates only when a scenario opts in. Airspace toggles plonked on top of the map skip the rail and ignore scenario activation.

2. The aviation domain isn't one dataset — it will grow to include live aircraft from OpenSky and VATSIM, a source-swap command, future TFRs, NOTAMs, controller sectors, and possibly more. Spreading these across `src/reference-data/`, `src/ui/map/dataset-styles/`, and `data/reference/manual/` makes the codebase harder to navigate and harder to remove cleanly.

A future maritime or fire pack will want the same *pipeline* (build → tile → serve → spatial index). It will not want the same *domain knowledge*.

## Decision

All aviation-domain code lives in a new pack at `src/packs/aviation/`. The neutral reference-data pipeline at `src/reference-data/` stays, but only the *machinery* (build, fetch-cache, tippecanoe wrapper, manifest writer, spatial index, generic source helpers, licences registry, capability schema). Pack-specific datasets, parsers, schemas, styles, overlays, and providers move out.

### Files that move into `src/packs/aviation/`

```text
src/packs/aviation/
  pack.ts
  model.ts                              # AircraftPackData zod, source ids
  commands.ts                           # aviation.set_source (B.3)
  query.ts                              # fleet_snapshot, source_status, providers_available (B.2+)
  scenario.ts                           # pack codec
  rail.ts                               # rail-section presenter
  datasets/
    aero-norway.ts                      # from src/reference-data/datasets/
  sources/
    openaip.ts                          # from src/reference-data/sources/
    avinor-airports.ts                  # from src/reference-data/sources/
    vertical-limits.ts                  # from src/reference-data/sources/
  schemas/
    airspace.ts                         # from src/reference-data/airspace-schema.ts
    airport.ts                          # from src/reference-data/airport-schema.ts
    manual-overlay.ts                   # from src/reference-data/manual-overlay-schema.ts
  ui/
    aero-norway-style.ts                # from src/ui/map/dataset-styles/
  data/
    halden-exclusion-zone.geojson       # from data/reference/manual/
  sim/                                  # B.2+
    constants.ts
    opensky/{adapter,normalise}.ts
    vatsim/{adapter,normalise}.ts
    source-router.ts
```

### What stays neutral in `src/reference-data/`

```text
src/reference-data/
  types.ts                              # DatasetConfig, DatasetSource, LicenceRef
  pipeline.ts                           # buildDataset, promoteBuild
  fetch-cache.ts                        # etag / If-Modified-Since helper
  tippecanoe.ts                         # subprocess wrapper
  manifest-writer.ts                    # per-dataset manifest fragment writer
  capabilities.ts                       # /map/capabilities.json composition + schema v2
  spatial-index.ts                      # rbush-free PIP + altitude filter
  point-in-polygon.ts                   # hand-rolled, zero deps
  licences.ts                           # known licence registry (cc-by-nc-sa, nlod, etc.)
  registry.ts                           # collects DatasetConfigs contributed by packs
  sources/manual.ts                     # generic GeoJSON file loader
  sources/geonorge-wfs.ts               # generic WFS helper (reusable by any future GeoNorge consumer)
```

The pipeline serves any pack that wants to ship a tileset. Aviation is its first real consumer; maritime, fire-station coverage, hospital-network reference data are all plausible future consumers without depending on `aviation`.

### Pack contract changes (two optional fields)

```ts
export interface LeitbildPack {
  // ...existing fields...

  /**
   * Reference datasets contributed by this pack. The reference-data pipeline
   * (build CLI, manifest writer, spatial index) walks all active packs at
   * startup and collects their datasets. A pack that needs an external API key
   * declares it via env-bound source factories; missing env throws on first
   * `build()` call, not at module load.
   */
  readonly referenceDatasets?: ReadonlyArray<DatasetConfig>

  /**
   * Rail-side layer-group toggles. When a pack contributes mapLayerGroups,
   * the control rail renders a section with one row per group plus an
   * optional source-picker. The toggles drive
   * `setLayoutProperty(layerId, 'visibility', ...)` against the layers the
   * pack-bound reference datasets and providers expose.
   */
  readonly mapLayerGroups?: ReadonlyArray<PackMapLayerGroup>
}

export interface PackMapLayerGroup {
  readonly id: string                            // 'airspace', 'airports', 'aircraft'
  readonly label: string
  readonly defaultVisible: boolean
  /** MapLibre layer-id glob, e.g. 'reference:aero-norway:*:*' */
  readonly layerIdPattern: string
}
```

The previous `referenceDatasetRefs?: ReadonlyArray<string>` field added in Phase A.1 is removed; no caller existed. Packs now directly own their datasets.

### CLI behaviour

`bun run reference:build` walks `leitbildPacks` from `src/app-assembly.ts`, calls `collectRegisteredDatasets(packs, env)`, builds each in order. Failure in one pack's dataset does not block other packs. The dataset *id* and on-disk paths (`/opt/leitbild/reference/releases/<id>/current/...`) do not change — only the code location moves. No production state migration on Hetzner.

### Cross-pack dataset sharing (not done in v1)

If a future drone pack also wants the airspace tileset, it imports `aviation/datasets/aero-norway.ts` explicitly. Explicit imports keep the dependency reviewable. We do not put `aero-norway` back into a neutral registry just to avoid the import.

## Consequences

- **`docs/adr/0019-reference-data-pipeline.md` placement-and-ownership claims are amended.** Datasets are pack-owned; pipeline is neutral. ADR 0019's "datasets neutral" rule is corrected in an amendment block at the bottom of that ADR.
- **The free-floating `MapLayersPanel` is removed from `MapSurface`.** Visibility flows through the pack rail.
- **Scenario opt-in is enforced.** Existing Halden / Oslo scenarios continue to work unchanged because they do not declare `aviation` in their `packs:` list. To preserve the live-demo airspace view, Phase B.1 ships `src/scenarios/norway-airspace.scenario.json` activating the pack.
- **No new runtime dependencies.** The move is mechanical — same code, different folder; one new presenter for the rail section; one new pack file.
- **Existing 500+ tests stay green.** Import paths are rewritten; logic doesn't change.
- **`data/reference/manual/halden-exclusion-zone.geojson` moves into `src/packs/aviation/data/`.** The `.gitignore` exception for `data/reference/` is removed since `data/reference/` becomes empty (or kept if other packs adopt the convention; we'll drop it for v1).
- **Production `OPENAIP_API_KEY` env stays at `/etc/leitbild/reference.env`.** The pack's dataset reads it at build time, same as before.

## Forward-looking caveats

- If aviation grows large enough to split (e.g., separate `airspace` and `live-aircraft` packs), the dataset stays with airspace; live aircraft become a sibling pack that may reference the airspace dataset by explicit import or by re-introducing a string-id registry.
- Cross-cutting context like "which airspace contains this aircraft" is answered by the server-side spatial index (ADR 0021), which packs query via the existing pack-query surface. No new mechanism needed.
