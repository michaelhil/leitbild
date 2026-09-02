# ADR 0019: Pack-owned reference datasets and shared pipeline

## Status

Accepted. Consolidated on 2026-09-02 to describe the current implementation after removal of retired datasets.

## Context

Packs need licensed, slow-changing geographic context without embedding dataset-specific fetching and parsing in simulation core. Map rendering and server-side spatial queries need different representations of the same validated features.

## Decision

Packs own dataset definitions, source adapters, feature schemas, audits and styles. Application assembly attaches their `referenceData.builders`; the shared registry discovers these contributions and rejects duplicate dataset IDs.

Shared infrastructure in `src/reference-data/` handles fetching/cache, build orchestration, validation, manifests, attribution, promotion and the sidecar spatial index. Commands in `scripts/reference/` run explicitly from an installed code release. No scheduled source-pull service is installed.

Each dataset is published independently as PMTiles, a sidecar GeoJSON and a manifest under `builds/<dataset-id>/<build-id>`, selected through `releases/<dataset-id>/current`. The map capability manifest exposes published datasets. Caddy serves artifacts; no additional application HTTP server is introduced.

Tippecanoe builds reference vector tiles. The OSM base-map pipeline remains separate. Server-side queries read sidecar GeoJSON rather than decoding PMTiles.

## Alternatives and consequences

- A combined tileset would couple independently licensed and updated datasets; per-dataset artifacts keep publication and rollback independent.
- A separate geodata service would add deployment and network overhead without a current need. In-process queries suffice.
- Pack-owned datasets avoid a core registry importing domain parsers; a shared pipeline avoids duplicated build infrastructure.
- Sidecars consume additional disk space but simplify runtime queries.
- Source credentials are read only by builders that need them, not by general runtime discovery.
- Browser styles still require explicit registration in the UI style registry. Manifest discovery does not execute arbitrary remote code.
- Streaming ingestion, additional spatial predicates and a more sophisticated index should be added only for measured needs.

See `docs/reference-data-pipeline.md` for operational commands and ADR 0021 for the sidecar decision.
