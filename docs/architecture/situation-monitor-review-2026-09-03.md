# Situation Monitor review — 3 September 2026

Status: implementation completed locally; release verification in progress. Findings below describe the audited baseline; the implementation outcome is recorded at the end.

## Conclusion

Keep Situation Monitor as one World Pack. Its placement, Workspace isolation, separation of evidence from physics, reuse of the Agent broker, lazy presentation, and bounded SQLite cache are appropriate. Do not replace it with a connector platform, another Module, or provider-specific Packs.

The main weaknesses are incomplete information semantics, premature truncation, a growing set of adapter switches, split map-symbol rendering, and freshness/lifecycle edge cases. These deserve attention before multiplying providers. The answer is not another rewrite of Leitbild: simplify the snapshot cache, tighten the adapter boundary, complete a small shared map presentation vocabulary, and exercise it with one genuinely useful Norway scenario.

## Evidence and verification

- Reviewed the complete Pack: configuration, descriptors, decoding, restricted HTTP, collection, persistence, runtime, capabilities, source editor, records panel, charts and media player; traced its shared map and Agent integration.
- All 14 current Situation Monitor tests passed. Latest GitHub CI passed. Production Host, World, Agents, Caddy, OSRM and public health passed read-only checks.
- Production map discovery declares Norway regional vector detail and a separate worldwide overview. Keeping a Norway demo does not require limiting the Pack geographically.
- In-memory diagnostic fixture, local Bun 1.4.0: 50,000 small point records across five collections; text+bounds search returning 200 records had approximately 21 ms median / 24 ms p95 over 30 queries. Individual 10,000-record replacements took 34–141 ms. These are local synthetic diagnostics, not production capacity guarantees or a substitute for polygon/media load tests.
- Reproduced forecast starvation: 1,100 forecast samples plus one event, queried using the current 1,000-record map limit, yielded one displayed forecast, omitted the event, and selected a forecast several days away despite a near-current sample existing.
- Reproduced retry loss: after a fixture returned HTTP 429 with `Retry-After: 3600`, releasing and reacquiring its last lease allowed another request about one second later. Failure deadlines are not persisted.
- Reproduced inconsistent media identity: two differently named/identified source configurations share a collection key but decode different record IDs because media IDs include the local source ID.
- Queried original Norwegian providers, not third-party mirrors. See the Norway section for findings and limits.

## 1. Foundations worth retaining

The useful topology is already small:

`Scenario source configuration → reviewed adapter → bounded Workspace snapshot cache → typed queries → map / inspector / Agents`

One Source may yield hundreds of camera records. A camera need not become another Source, Pack, Room or simulated Operational Object. Media remains an external reference and loads only when requested.

Keep the existing restrictions on public-network collection, credential references, body size, deadlines, redirects, collection concurrency, source counts and storage budgets. Keep queries read-only, source management explicitly permissioned, and external content untrusted. Keep accepted source changes separate from saving a Scenario revision.

## 2. Findings to fix before broadening ingestion

### A. Completeness and current-state correctness

**Map selection happens in the wrong order.** `runtime.ts` asks the general time-descending record query for the first N records, then groups forecasts and expands geometry. This lets future forecast rows monopolize the result. Expansion of multi-geometries also happens before enforcing the vertex budget, so a bounded response does not imply bounded intermediate allocation.

Use a map-specific selection over logical features/subjects, then enforce feature and vertex budgets during expansion. Preserve explicit returned/matched/truncated information. Do not solve this by increasing limits. Do not add a general ranking engine: stable, documented selection plus source filtering and visible limits is sufficient initially.

**The UI discards truncation.** The generic map loader extracts only `features`. It also uses one `Promise.all`, so one failing Pack query prevents fresh results from successful Pack queries. Return per-query coverage/error metadata and preserve good results with an explicit failed/stale layer indication. Failure must not be silently hidden.

**Selected records can outlive the cache.** MonitorPanel retains the previous selection when it disappears from the current list page. That avoids accidental deselection during pagination, but also leaves removed/expired/revised evidence displayed. Refresh an inspected record by identity on relevant changes; distinguish “outside this page” from “no longer retained.”

**Freshness is too coarse.** The panel says “Live · real time” whenever status exists, including failed or paused sources. `retrievedAt`, successful validation, provider update time, forecast validity, and camera capture time are different. A successful metadata poll must not imply a fresh camera image. Pausing collection currently still permits reading cached rows; say so explicitly. Expiry must invalidate map presentation even when no new data arrives.

### B. Snapshot-cache simplification

All production writes replace a complete provider window, yet `store.replace` retains an unused append/snapshot option and an upsert path after deleting that collection. Every successful unchanged response updates expiry on every row. Housekeeping runs before every replacement.

Use one collection metadata row for snapshot expiry, last validation, retry deadline and completeness. Let records inherit snapshot expiry. This removes per-record expiry rewrites, gives empty successful snapshots a real identity, and permits cleanup without destroying useful empty-feed metadata. Remove the unused append mode. Run expensive maintenance on a bounded cadence, not on every changed feed.

Persist backoff/provider deadlines on failures and honor them after a lease closes or the service restarts. Keep request-body changes distinct from status changes. Ensure listener errors cannot bypass request-slot cleanup or stop scheduling: the current initial notification runs after incrementing the global counter but before its cleanup-protected block.

Rename or explain “retention”: it currently means how long the latest snapshot remains usable after validation stops, not an archive of every event seen in that period. Records that disappear from the provider window disappear at replacement. That is a valid lean design, but a different promise from historical retention.

Collection sharing is Workspace-scoped, correctly. It also depends on mapping and retention settings, not merely URL equality. Avoid claiming all same-URL requests share. Fix media IDs to be independent of the first subscribing Source's local name/ID.

The database has expiry and collection/time indexes; its text and bbox predicates are database-side filters, not dedicated text/spatial indexes. Correct the documentation. Current measurements do not justify PostGIS, Elasticsearch, Redis, or an additional database. Consider SQLite FTS/R-tree only after representative profiling shows a need.

### C. Data-model gaps exposed by Norway

The generic GeoJSON adapter currently retains only identity, title, one time, URL and geometry. It drops descriptions, severity, validity intervals, measurements, camera status and media links. RSS does not preserve GeoRSS location. MET Locationforecast decodes instantaneous quantities but ignores interval precipitation and weather-condition symbols.

Add only semantics needed by real inputs:

- Provider category and provider-labelled severity/status, without inventing a universal risk score.
- Valid-from/valid-until and observed/captured time when supplied. Keep them separate from retrieval and publication.
- Stable subject/series identity before adding multi-station measurements. Grouping charts only by Source + measurement ID + unit would merge unrelated stations.
- A small bounded set of structured details for important provider fields and complete warning guidance. Do not silently truncate an official warning into a misleading summary.
- Multiple media references where a camera offers both a still image and a stream, with availability and expiry when known.

Do not add an arbitrary raw-payload dump, universal ontology or transformation language. Retain original evidence links. Provider decoders should explicitly identify unsupported/invalid data. A malformed feed must preserve the previous good snapshot; if individual records are rejected, show rejection counts and incomplete coverage rather than silently skipping them.

Current dot-path lookup cannot address arrays or literal dotted property names. Use a standard path representation or keep provider-specific interpretation in its decoder; do not grow a home-made expression language to handle every provider quirk.

### D. Adapter organization and discovery

Adding an adapter currently touches the source union, catalogue, URL construction, combined decoder, runtime probe/collector special cases and form conditionals. Five adapters are manageable; dozens would not be.

Keep a small shared, browser-safe descriptor for schema, fields, modalities, limits and provider documentation. Keep server-only collection/normalization handlers separate and validate descriptor/handler alignment. Let an adapter perform a bounded collection operation using the restricted HTTP client; a paged catalogue must not require pretending each camera is a separately configured Source.

Reuse existing authoring-field rendering where it fits; allow small provider-specific controls for genuinely different inputs. Do not build a general JSON-schema form framework. Remove `Record<string, any>` from the editor's principal draft model.

Discovery has two levels: discovering supported adapters, which exists; and discovering a provider's currently available datasets/cameras/stations, which does not. Support the latter through documented catalogues and bounded queries, not arbitrary HTML crawling. A reviewed provider integration is appropriate code; hand-maintained lists of camera URLs are not.

### E. Media and access boundaries

The lazy HLS player is appropriate. Its built JS chunk is about 561 KiB uncompressed, loaded on demand; MonitorPanel and SourceEditor are roughly 20 KiB and 11 KiB. Keep HLS out of initial startup and do not add another player framework.

Add current-image rendering, including capture/freshness status, deliberate loading and a bounded refresh cadence while visible. Keep video buffering bounded and unload hidden/closed players. Do not fetch hundreds of images simply because their markers are visible, transcode streams, or create an implicit recording archive.

The public HTTP guard protects server collection, but the shared URL schema alone does not enforce public destinations for client-loaded media. Audit browser media destinations separately. Also distinguish configured fetch URLs from provider-issued, short-lived signed playback URLs; the blanket credential-name prohibition would reject legitimate signed URLs from some catalogues. Never weaken server collection to solve browser playback.

Bearer-only credentials will not cover every future provider. Add an adapter-owned credential scheme only when needed, with server-side secrets; do not offer arbitrary secret headers in scenario JSON. The recommended first Norway data does not require this extension.

## 3. Map rendering, drawing and icons

### Present implementation

The map supports point, line and polygon Pack features, including multipart splitting, translucent polygon fills and configurable outlines. Situation Monitor chooses three colors by coarse record kind and renders all its points as fixed-size circles.

A generic `PackMapFeature.symbol` already exists. However, Situation Monitor does not populate it, the new native feature layer does not render it, and older anchored symbols still use Deck's custom 15-symbol atlas. Another UI helper contains a separate hand-written icon set while Lucide is already installed. There are alias mappings and silent unknown-symbol fallbacks. Adding yet another icon mechanism would worsen the problem.

Unify the symbol catalogue and Pack-feature rendering path, rather than adding a Situation Monitor-specific icon registry. Keep source-derived evidence separate from operational-object identity. Do not migrate unrelated 3D rendering just to finish this Pack.

Other map cleanup:

- Feature changes synchronize the native layer through both a callback and a reactive effect. Remove duplicate ownership.
- The native layer serializes/parses and replaces the complete feature collection on updates. Do not refresh unchanged evidence because a physical simulation clock advanced or a source merely entered “loading.” Partition updates by actual data revision and coalesce bursts.
- Old area projections still compute/store polygon presentation that is no longer drawn by their former Deck polygon layer. Remove truly dead work after verifying diagnostics and symbols.
- Animation metadata is still declared but is not consumed by the inspected map controllers. Resolve this honestly rather than retain an implied capability.
- Establish explicit ordering, selection highlighting and source visibility. Transparent areas must not blanket unrelated labels, assets or click targets. Geometry sorting alone is not a complete cross-layer order contract.

### What we can render without another map engine

| Need | Lean implementation |
| --- | --- |
| Highlight an alert area | Existing polygon fill + opacity, with a meaningful legend |
| Colored roads or boundaries | Existing line geometry, controlled width/color/dashes |
| Recognizable cameras, warnings, weather stations | Native symbols from the shared icon catalogue |
| Color by a measured value | Validated numeric color stops and an explicit unit/legend |
| Soft point-density gradient | Native heatmap, labelled as density rather than a physical field |
| Gradient along a line | Native line gradient with a line-metrics source |
| Actual continuous radar/forecast imagery | A bounded raster/image overlay, when a real source requires it |

MapLibre supports [heatmaps](https://maplibre.org/maplibre-gl-js/docs/examples/create-a-heatmap-layer/), [line gradients](https://maplibre.org/maplibre-gl-js/docs/examples/create-a-gradient-line-using-an-expression/), [registered icons](https://maplibre.org/maplibre-gl-js/docs/examples/add-an-icon-to-the-map/) and [raster overlays](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-raster-tile-source/). A polygon's ordinary fill is not an arbitrary spatial gradient. Do not imply that interpolating sparse weather-station observations produces a validated weather field. Raster evidence overlays do not require changing our vector basemap.

There is no general user/Agent freehand annotation tool here yet. Source-derived map features and human/Agent annotations should use the same renderer but retain different provenance. Start with source visibility, style and selection; add a small shared annotation capability if arbitrary authoring is wanted, not invented External Records or executable map styles.

### Icon-library research

| Library | Assessment for Leitbild |
| --- | --- |
| Lucide | Best default: already installed; broad, consistent SVG set; per-icon tags and categories; small selective delivery. Existing map artwork can be consolidated instead of adding a second normal-purpose library. |
| Phosphor | Strong alternative, especially filled/duotone marks. Official core package includes a typed searchable catalogue, tags, categories and version metadata. Switching adds work without a current decisive coverage benefit. |
| Material Design Icons, Pictogrammers | Broad specialist coverage; SVG package includes `meta.json` with tags and aliases. Worth a future supplemental set if concrete domain gaps appear; many near-duplicates require curated search results. Distinct from Google's Material Symbols. |
| Google Material Symbols | Broad SVG/font collection with named glyphs and optical/weight variants. Whole variable-font delivery is unnecessary for map symbols; subsets/SVGs are more appropriate. |
| Maki | Designed for small map POIs, but too narrow as the only system-wide vocabulary. |
| Iconify | Useful data tooling, not itself one coherent icon family. Do not ship all sets or introduce a third-party runtime icon API dependency. |

Primary references: [Lucide guide](https://lucide.dev/guide/), [actual CCTV metadata](https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/cctv.json), [Phosphor core catalogue](https://github.com/phosphor-icons/core), [MDI metadata documentation](https://pictogrammers.com/docs/contribute/third-party/), [Material Symbols guide](https://developers.google.com/fonts/docs/material_symbols), [Maki](https://github.com/mapbox/maki), [Iconify metadata](https://iconify.design/docs/types/iconify-json-metadata.html).

Publish a small, searchable icon discovery capability returning canonical IDs, labels and tags. Keep the full pinned catalogue outside the initial JS bundle; load/cache only selected local artwork. Use one normal style, readable glyphs on category/status backgrounds, labels and legends. Validate icon IDs. Agents choose supported IDs and reusable styling rules, not SVG markup, remote URLs or an LLM call per incoming record. Provider categories select initial symbols deterministically; users/Agents may configure overrides. Preserve any genuinely useful specialist symbols as explicit catalogue entries, not aliases hidden in rendering code.

## 4. One Norway demonstration

Replace the two Situation Monitor World examples with **Norway — live situation**. Keep global configurability and all supported adapter functionality. This removal should target the two demo Definitions, not unrelated Scenarios or existing Runs.

Recommended content:

1. MET active weather warnings as actual colored geographic areas, with validity, severity and guidance.
2. Vegvesen reported road disruptions, with line geometry and current/planned status.
3. Vegvesen road-weather observations, retaining station identity and units.
4. Vegvesen cameras discovered from its live catalogue, with still-image and video availability.

No fixed list of towns, stations or camera URLs. Use a Norway-wide starting view and user-controlled source/viewport filtering. A quiet alert feed should honestly show no current warnings, not synthetic filler.

### What was verified live

The [official WFS capabilities endpoint](https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/ows?service=WFS&request=GetCapabilities) returned dataset discovery without authentication. The camera collection returned 895 entries in approximately 0.79 MB, including 143 entries with HLS URLs and video availability declared. Road-weather reported 467 entries; traffic reports approximately 2,450 and changing. These are a point-in-time sample, not guaranteed coverage or uptime.

Two advertised HLS master playlists returned HTTP 200 and permissive CORS. A child live playlist changed between checks. This verifies advertised streams and live playlist delivery, not browser playback of every camera. Browser/Safari checks, actual video decoding, unavailable-camera handling and stale-image behavior remain implementation acceptance tests.

The provider's newer `CctvSimple_v2` collection returned the same 143 video availability declarations but no video URL fields. The existing published `CctvSimple` includes the URLs. Select and validate a complete published dataset; never guess a URL from a camera ID or blindly prefer a name ending in `_v2`.

[Vegvesen's WFS/WMS specification](https://git.vegvesen.no/projects/DATEX2/repos/datex2-spesifications/raw/3.1/NPRA_DATEXII_3_1_Specification_WFS-WMS_v1.1.pdf?at=2e2915c358a24616d580b6e3e9ca5f764c1885f1) describes public catalogue access, camera status and media fields. This is a different access path from its registration-required DATEX REST service. Attribute Statens vegvesen and retain availability information. Use catalogue refreshes, not HTML scraping.

[MET MetAlerts](https://api.met.no/weatherapi/metalerts/2.0/documentation) returned a real Norwegian marine gale-warning polygon during the check. Its GeoJSON endpoint is documented as comparatively costly/beta, so use restrained polling and caching. A dedicated small decoder is justified to preserve warning semantics; merely adding four field paths would lose important content.

### Alternatives considered

- [Windy Webcams](https://api.windy.com/webcams/docs) provides geographical discovery but needs an API key and returns expiring media URLs. It is useful for later global coverage, not necessary for the initial Norway demo. Do not equate its imagery/timelapses with continuous live video.
- [SkylineWebcams](https://www.skylinewebcams.com/support/faq.html) restricts live embedding to webcam hosts; third-party snapshot embeds are a different offering. Do not scrape its stream internals.
- [NVE HydAPI](https://api.nve.no/doc/hydrologiske-data/) has valuable water-level/flow data and station discovery but requires registration. Defer it rather than make the first demo depend on extra credentials.
- [NVE flood warnings](https://api.nve.no/doc/flomvarsling/) can extend natural-hazard coverage later. Preserve full warning meaning and attribution; do not duplicate weather-warning integration before the first coherent scenario works.

## 5. AI integration

Retain the current capability broker and read-versus-management grants. The ordinary companion can inspect retained evidence; the separately permissioned operator can manage sources. No new Agent framework is needed.

Add typed discovery of dataset options, observed fields/units and available map symbols. Extend record queries with practical kind/status/validity and subject filters rather than making the Agent page through everything. Expose source failures, upstream completeness, last validation and original timestamps alongside results.

An Agent must be able to answer “which cameras near this road currently advertise live video?” using catalogue records without fetching every video. It should be able to explain “metadata is current, but the last image is old.” Configuring source inclusion or presentation must not allow it to alter simulated Weather/Grid/Plant state implicitly.

Do not automatically analyze/transcribe video. Any future image analysis should be explicit, bounded, permissioned and timestamped; an interpretation is not provider evidence. Do not let feed text configure adapters, credentials or grants.

## 6. Proposed implementation sequence and adversarial gates

1. **Correctness and cache cleanup:** map selection/truncation, durable retry deadlines, empty snapshots, collection-level expiry, stable media identity, visible stale/removed records, protected notification lifecycle. Remove dead store options.
2. **Adapter and record boundary:** compact per-adapter handlers/descriptors, bounded WFS discovery and pagination helper, explicit provider decoders, validity/subject/media semantics. Support complete snapshots atomically; never replace good data with a silently partial page set.
3. **Shared map presentation:** consolidate icon catalogue and Pack symbols, remove duplicated synchronization/dead projections, add source visibility/legend/selection and restrained configurable styling. Separate data revisions from collection-status changes and physical-clock refreshes. Add heatmaps or raster overlays only with an actual use case.
4. **Norway data and media:** implement the four source types above; one catalogue source emits many camera records; only requested media loads. Reuse HLS. Add still-image rendering and explicit age/availability. Replace the two World demo cards with the one Norway scenario.
5. **Editor, AI and tests:** source/dataset/symbol discovery uses the same descriptors as validation; interactive edits save normally to Run/Scenario. Verify browser playback, source removal, multi-user edits, shared leases, restart/backoff, empty and partial catalogues, malformed geometry, dateline coverage, bursts and bounded storage. Then deploy under the standing deployment instruction.

Adversarial limits: no universal ETL graph, auto-installing adapters, generic crawler, plugin marketplace, per-camera Source hierarchy, unbounded raw archives, new spatial database, arbitrary styling expressions, per-record LLM enrichment, automatic physical coupling or wholesale map-engine replacement. Readability matters more than minimizing line count: expand dense multi-operation code and use small tested helpers rather than another abstraction tier.
