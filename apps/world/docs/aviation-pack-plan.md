# Aviation Pack — Phase B Plan

This document complements ADR 0022 (architecture) and ADR 0023 (rail `mapLayerGroups`). It is the operator-facing companion: what ships in which phase, in what order, with what observable behaviour change.

## Context

Phase A built the reference-data pipeline and shipped Norwegian airspace polygons (OpenAIP) plus Avinor airport points (GeoNorge) as a tileset `aero-norway`. The UI rendered a free-floating layer-toggle panel top-right of the map. The panel sat outside any pack and ignored scenario activation.

Phase B restructures everything aviation-related into a single pack `src/packs/aviation/`, moves visibility control into the pack rail, and adds live aircraft from OpenSky and VATSIM with a runtime source-swap.

## Phasing

### B.0 — docs only (this commit)

- ADR 0022 — aviation pack architecture
- ADR 0023 — `mapLayerGroups` protocol field
- Amendment block at the bottom of ADR 0019
- This plan document
- Wiki rename `domains/airspace.md` → `domains/aviation.md` (carrying the existing skeleton forward)

No code touches. No observable change.

### B.1 — file moves + pack skeleton + rail-driven visibility

- All aviation-specific files move from `src/reference-data/*` and `src/ui/map/dataset-styles/` and `data/reference/manual/` into `src/packs/aviation/`.
- `src/reference-data/registry.ts` becomes a collector: `collectRegisteredDatasets(packs, env)`.
- Pack-protocol field changes:
  - **Remove** `referenceDatasetRefs?: string[]` (introduced in A.1, never used).
  - **Add** `referenceDatasets?: DatasetConfig[]` — direct contribution.
  - **Add** `mapLayerGroups?: PackMapLayerGroup[]` — rail toggles.
- New `src/packs/aviation/rail.ts` presenter + a small Svelte component rendered inside the rail.
- The free-floating `MapLayersPanel` is removed from the operational map shell.
- A new scenario `src/scenarios/norway-airspace.scenario.json` activates the pack and renders the rail-driven toggles for airspace + airports.
- No live aircraft yet.
- Production behaviour: existing Halden / Oslo scenarios continue working unchanged because they do not declare `aviation` in their `packs:` list. The new `norway-airspace` scenario is the only place airspace renders. On-disk state on Hetzner does not change; the build CLI just sources the dataset from a different code location.

### B.2 — OpenSky live aircraft

- New pack runtime `src/packs/aviation/sim/opensky/`:
  - OAuth2 client_credentials authentication; token cached, refreshed at 80% of expiry.
  - REST `GET /api/states/all?lamin&lomin&lamax&lomax` polled every 5–10 s; adaptive backoff on 429.
  - State vector → `OperationalObject` of `kind: 'aircraft'` with `pack: 'aviation'`.
- Aircraft `OperationalObject`s flow through the existing object-rail machinery (one row per aircraft below the existing pack-defined categories).
- A source picker appears in the aviation rail section (radio buttons; OpenSky vs VATSIM — but only OpenSky is wired this phase).
- Secrets: `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` joined to `/etc/leitbild/reference.env` on Hetzner.
- Aircraft are *ephemeral*: filtered out of snapshot restore in the pack runtime's `connect()`.

### B.3 — VATSIM + runtime source-swap

- New pack runtime `src/packs/aviation/sim/vatsim/`: public JSON poll every 15 s, bbox-filtered.
- New composite pack runtime `src/packs/aviation/sim/source-router.ts`: holds active source in private state; switches via the `aviation.set_source` command without scenario reload.
- Switch flow: cancel pending fetch, emit `object.deleted` for every current aircraft, replace activeSource, emit `aviation.source_changed` notification, start new poll loop. No ghosts.
- Source picker in the rail becomes fully interactive.

### B.4 — Scenarios + polish

- New `src/scenarios/halden-aviation.scenario.json` combining aviation + weather + ambulance for a richer demo. The Halden exclusion overlay sits inside the pack's `data/` folder.
- Culling: at zoom <5 the symbol layer becomes a heatmap aggregate; >2000 visible aircraft drop by lowest altitude and oldest update.
- Trails: last N positions per aircraft kept in the projection.
- Hover card enrichment: per-aircraft altitude / heading / speed / squawk, plus cross-pack "inside airspace" via the existing spatial index.
- Per-aircraft selection halo.

## File-move map (B.1)

```text
src/reference-data/datasets/aero-norway.ts            → src/packs/aviation/datasets/aero-norway.ts
src/reference-data/sources/openaip.ts                 → src/packs/aviation/sources/openaip.ts
src/reference-data/sources/avinor-airports.ts         → src/packs/aviation/sources/avinor-airports.ts
src/reference-data/sources/vertical-limits.ts         → src/packs/aviation/sources/vertical-limits.ts
src/reference-data/airspace-schema.ts                 → src/packs/aviation/schemas/airspace.ts
src/reference-data/airport-schema.ts                  → src/packs/aviation/schemas/airport.ts
src/reference-data/manual-overlay-schema.ts           → src/packs/aviation/schemas/manual-overlay.ts
src/ui/map/dataset-styles/aero-norway.ts              → src/packs/aviation/ui/aero-norway-style.ts
data/reference/manual/halden-exclusion-zone.geojson   → src/packs/aviation/data/halden-exclusion-zone.geojson
```

`src/reference-data/` retains: `types.ts`, `pipeline.ts`, `fetch-cache.ts`, `tippecanoe.ts`, `manifest-writer.ts`, `capabilities.ts`, `spatial-index.ts`, `point-in-polygon.ts`, `licences.ts`, `registry.ts`, `sources/manual.ts`, `sources/geonorge-wfs.ts`.

## Production deploy notes

The dataset id (`aero-norway`) and on-disk paths (`/opt/leitbild/reference/releases/aero-norway/current/...`) do not change. No migration on Hetzner. The next `bun run reference:rebuild` will continue to find and refresh `aero-norway` because the build CLI walks `worldPacks` and the aviation pack contributes the same `DatasetConfig`.

## Reverting / removing the pack

`src/packs/aviation/` deletes cleanly: drop the folder, drop one line from `src/app-assembly.ts` and one from `src/ui/pack-loader.ts`, and aviation is gone. No central registry to clean. That cleanliness is the point.

## Cross-references

- **ADR 0019** — pipeline (amended at the bottom for this pivot)
- **ADR 0020** — OpenAIP / GeoNorge source choices (unchanged)
- **ADR 0021** — sidecar GeoJSON (unchanged)
- **ADR 0022** — aviation pack architecture
- **ADR 0023** — `mapLayerGroups` field on `WorldPack`
- **Wiki**: `leitbild-wikis/leitbild` → `wiki/domains/aviation.md` (rename of `airspace.md`)
