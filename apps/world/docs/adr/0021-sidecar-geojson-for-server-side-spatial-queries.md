# ADR 0021: Sidecar GeoJSON For Server-Side Spatial Queries

## Status

Accepted.

## Context

ADR 0019 establishes the reference-data pipeline. Two distinct consumers read the data:

- The **browser**, which renders vector tiles directly through MapLibre. PMTiles is the right artifact: it serves the browser tile-by-tile, range-byte, with zero server logic.
- The **server**, which answers pack queries such as "what airspace contains this aircraft position right now". This needs a fast point-in-polygon over the feature set, callable from interaction handlers and pack-query code paths.

The naïve approach for the server is to parse the PMTiles archive at runtime using a library such as `@protomaps/pmtiles` plus turf, walking tiles to recover features and running spatial predicates. This was considered.

The build step already produces the canonical, validated, normalised set of features as a `Feature[]` in memory immediately before tile generation. Discarding that and re-extracting it from the tile archive at runtime is wasted work, adds a runtime dependency on a tile reader, and exposes the server to tile-level concerns (z/x/y addressing, feature splitting across tiles, simplification at coarse zoom) that are irrelevant to spatial predicates over the full-fidelity dataset.

## Decision

Each reference-data build produces two artifacts side by side under the same `builds/<dataset-id>/<build-id>/` directory and is promoted atomically together:

- `<dataset-id>.pmtiles` — the vector tile archive for the browser.
- `<dataset-id>.features.geojson` — the full-fidelity validated feature collection for the server.

The PMTiles file is served directly by Caddy under `/map/datasets/<id>/current.pmtiles`. The sidecar GeoJSON is never served to the public. It is read only by the server-side spatial index module.

The server-side spatial index module exposes one function:

```ts
export const referenceIndex = (datasetId: string): {
  featuresContainingPoint(point: GeoJsonPoint, opts?: QueryOpts): Feature[]
}
```

Internally it lazily loads the sidecar on first call, indexes feature bounding boxes with `rbush`, and answers each query with `rbush.search` followed by `@turf/boolean-point-in-polygon` over the candidate features. Reload-on-promote is handled by file-watching the symlinked `current` directory.

The interface is intentionally one method. Additional spatial predicates (`featuresInBbox`, `nearestK`, line/polygon intersection) are added only when a real caller asks for them. There are no current callers that need them.

### What this does not do

- It does not introduce a tile reader on the server. PMTiles is for the browser.
- It does not introduce a second canonical store of features. The sidecar is generated from the same in-memory feature collection as the tiles, in the same build step. They cannot diverge.
- It does not require the sidecar to be served to the browser. The browser uses tiles.
- It does not require an external in-memory database. The dataset sizes in scope (tens of megabytes per dataset, in normalised GeoJSON) fit comfortably in process memory.

## Consequences

- **Disk usage roughly doubles** per dataset. For `aero-norway`, expected PMTiles size is on the order of single-digit megabytes; the sidecar GeoJSON will be perhaps 1.5×–3× the PMTiles size. Total per-dataset footprint stays in the tens of megabytes. Disk is not a constraint at this scale.
- **Server memory grows by the size of currently loaded sidecars.** Lazy loading means only consulted datasets occupy memory. With a handful of datasets we expect tens to low hundreds of megabytes of resident feature data, which is negligible for the existing single-server deployment.
- **Build atomicity** must include both files. The build writes both into the build directory before the promote symlink swap. Tile and sidecar are guaranteed to come from the same source build because they are produced from the same in-memory feature collection.
- **No PMTiles parsing on the server**, which means no dependency on `@protomaps/pmtiles` or related libraries in the runtime bundle.
- **Reload on promote** is handled by watching `releases/<dataset-id>/current` symlink target changes. The spatial index drops the indexed sidecar and lazy-loads the new one on the next query. There is no scheduled reload; reload follows the promote signal.
- **Query performance** is bounded by rbush candidate filtering (O(log N) per query at indexing time, fast bbox candidate retrieval) plus point-in-polygon on candidate features. For Norway-scale airspace counts (hundreds to low thousands of polygons), per-query latency is sub-millisecond.

## Forward-looking caveats

- Datasets exceeding ~200 MB normalised GeoJSON should switch to a streamed loader and a chunked sidecar layout (for example, one sidecar file per H3 resolution-3 region or per category). The threshold is observational, not a hard cap; revisit when a real dataset approaches it.
- If a future dataset has spatial predicates beyond point-in-polygon and rbush + turf becomes a bottleneck, the spatial index module can adopt a more specialised structure (e.g. `geofabric`, a custom GeoBuf, or precomputed H3 coverage) without changing the public function signature.
- If at some point a browser-side spatial index is needed (e.g. AI agents running in the client), the sidecar GeoJSON could be served to authorised clients through the existing API. This is not in scope for v1 and not required by any current consumer.
