# ADR 0020: OpenAIP And GeoNorge As Reference Data Sources

## Status

Accepted.

## Context

Leitbild needs Norwegian airspace polygons and authoritative airport points for the ADSB pack and for future packs that reason about airspace context (drone, search-and-rescue, traffic, ambulance air transport). ADR 0019 establishes the generic pipeline that ingests reference data; this ADR records which sources we use for the first concrete dataset, `aero-norway`, and why.

We investigated three candidates:

- **aero-nav.com / ENOR package.** Carries an explicit licence statement: "All data provided are for private PC flight-simulation use only!" Leitbild is a multi-user research platform, not private PC flight simulation. The licence does not cover our use. Rejected.
- **OpenAIP** (`openaip.net`). Community-maintained worldwide aeronautical database with airspace polygons, airports, navaids, obstacles. API V2 with free key. Updates regenerated weekly (Thursday 03:00 UTC), aligned with the 28-day AIRAC cycle. Licence: CC BY-NC-SA 4.0.
- **GeoNorge** (`geonorge.no`). Norway's national catalogue for public-sector geospatial data, run by Kartverket. Avinor publishes airport points and runway polygons as WFS endpoints. Licence: NLOD 2.0 (Norwegian Licence for Open Government Data — attribution only, fully open including commercial). Does not publish open structured airspace polygons; Avinor's authoritative airspace lives in the eAIP as HTML/PDF.

## Decision

The `aero-norway` dataset is composed of three sources with distinct roles:

| Layer | Source | Licence | Refresh |
|---|---|---|---|
| Airspace polygons (FIR, TMA, CTR, CTA, ATZ, R/P/D, class A–G) | OpenAIP API V2 | CC BY-NC-SA 4.0 | Weekly conditional GET, AIRAC-aligned |
| Airport points and ICAO labels | GeoNorge `Lufthavnpunkt Avinor WFS` | NLOD 2.0 | On GeoNorge cycle, conditional GET |
| Scenario-specific overlays (e.g. Halden process-plant exclusion zone) | Hand-authored GeoJSON tracked in `data/reference/manual/` | Repo-owned | On commit |

Three orthogonal source decisions:

### OpenAIP for airspaces

Chosen because it is the only freely-licensed, structured, polygon-shaped airspace source covering Norway that we can lawfully use as a research platform. Its CC BY-NC-SA 4.0 licence is acceptable because:

- We are non-commercial. The research platform does not generate commercial revenue from the data.
- We do not redistribute the dataset. We render it in a Leitbild deployment we operate; we do not publish derivative GeoJSON or PMTiles downloads.
- We attribute the source in the map's attribution control.

If a commercial Leitbild deployment becomes a concrete prospect, the data layer is pluggable specifically so the OpenAIP source can be swapped for a paid licensed source (e.g. Navigraph) by changing one `DatasetConfig`. No code outside `src/reference-data/sources/` would change.

### GeoNorge for airports

Chosen because Avinor's WFS is authoritative for Norwegian airports and is licensed NLOD 2.0, which is more permissive than OpenAIP (no NC restriction). Where we have a choice between an authoritative open-source publisher and a community publisher, we prefer the authoritative one. The licence asymmetry also preserves more future options: if the airport layer were ever to be carved out for a different use case, NLOD would not constrain it.

### Hand-authored overlays for scenario-specific geometry

Chosen because some scenarios (notably the Halden process-plant exclusion zone) require geometry that no public dataset publishes. Repo-tracked GeoJSON is a first-class source kind in ADR 0019's pipeline, with the same validation, tile-build, and serve path as remote sources. This keeps the abstraction symmetric and avoids a "real data versus mocked data" split.

### Attribution composition

The map's attribution control renders one line per active licence, deduplicated across datasets:

```
Map © OpenStreetMap contributors
Airspace © OpenAIP contributors · CC BY-NC-SA 4.0
Airports © Avinor · NLOD 2.0
```

The attribution control reads from the per-tileset `licences[]` array in `/map/capabilities.json` and composes the strings; no hard-coded attribution lines anywhere in the UI.

### Refresh cadence

- OpenAIP: weekly Thursday check, 03:30 UTC, conditional GET. AIRAC officially cycles every 28 days; weekly checks catch both AIRAC effective dates and community edits between cycles.
- GeoNorge: same weekly schedule, separate conditional GET.
- Manual overlays: rebuilt on commit, no fetch.

All three sources flow through one pipeline invocation (`bun run reference:build`); per-source no-ops are cheap.

### Coverage audit

OpenAIP is community-maintained and coverage for ENOR is not guaranteed. The build step runs the dataset's `audit` function over the parsed features and fails the build if any of the following baseline thresholds are not met:

- FIR features ≥ 2 (Norway has Bodø and Stavanger FIRs)
- TMA features ≥ 10 (Oslo, Bergen, Stavanger, Trondheim, Bodø, Tromsø, and others)
- CTR features ≥ 8
- Airport features ≥ 40 (Avinor operates ~45 airports)

Build failure prevents promote. The previous release remains active. An operator notification is logged. Thresholds are refined after the first real pull (Phase A.4).

### What this decision does not do

- It does not enforce the licence at runtime through environment flags or build gates. The licence is a policy obligation we follow; it is not something the build system polices.
- It does not lock the airspace source to OpenAIP forever. The dataset config can swap sources; downstream consumers see the same feature schema.
- It does not exclude future commercial sources. ADR 0019's pipeline is source-agnostic by design.

## Consequences

- Two new environment variables: `OPENAIP_API_KEY` (required for the airspace fetch), and an optional `GEONORGE_USER_AGENT` (some GeoNorge WFS endpoints request a meaningful User-Agent header). Both documented in `data/secrets.example.env` in Phase A.6. Neither is committed.
- The map UI's attribution control must support multi-line composition. Existing component is extended in Phase A.5.
- A failed coverage audit blocks promote. The operator must inspect `audit-report.json` to understand which categories regressed. This is the correct behaviour under `AGENTS.md`'s "avoid silent fallbacks" rule.
- Wiki page `domains/airspace.md` documents what coverage is currently observed in ENOR. Updated in A.7 with concrete counts.
- A future commercial deployment swaps the airspace source. The swap is a config change to `datasets/aero-norway.ts` plus a new source module in `sources/`. The dataset id, schema, and consumer code do not change.
