# Situation Monitor implementation

Approved 2026-09-03: implement a native, globally configurable World Pack, inspired by product capabilities rather than copied World Monitor code or data. Reuse Scenario Definitions, Runs, the World map, and Agents' capability broker.

## Delivery checkpoints

- [x] Foundations: global vector coverage, typed Pack map features, clock-independent observations, Pack-owned authoring/probe extension.
- [x] Collection: source schemas/adapters, restricted HTTP, shared Workspace collectors, bounded indexed records, durable live source edits, editor and inspector.
- [x] Measurements/media: original-provider forecasts, charts, supported on-demand video, visible failure and freshness.
- [x] Agents/release: discoverable reads and management, editable global/non-Norwegian examples, lifecycle/security/storage/performance tests, production verification.

## Boundaries

- One Pack, not one Pack per provider, third Module, connector platform or separate AI stack.
- Source configurations are authored in the Pack Selection and copied into a Run's durable Pack state. Saving live edits creates a new Scenario Revision explicitly.
- Source adapters are reviewed code; adding supported source configurations is runtime data. No arbitrary scripts or credential-bearing URLs.
- External records are evidence, not Operational Objects or physical control. Collection follows observation time; physics keeps the existing Run clock.
- Cache records are bounded and separate from configuration and scalar historian series. No automatic article/video archive.
- Collector leases are shared within a Workspace, not across private access scopes. Run deletion releases only its leases.
- Worldwide overview plus explicit regional detail; no full-detail planet download, external basemap fallback, or implied global routing.

Later scope remains unadvertised: CAP, fire detection, source-catalog discovery, imagery, observed tracks, frozen input import, continuous physical coupling and risk scoring.

## Implementation review

- Reused the SQLite engine already present in the Historian and Host, not a new database service.
- Generalized the existing Pack map-feature contract and removed the redundant Deck polygon rendering path. World map readiness now checks all declared basemap sources, including the global overview.
- Preserved normal Run idle/background policy; monitoring does not introduce hidden always-on jobs or claim restart persistence.
- Explicit source-to-Scenario save patches only Situation Monitor settings into the current Scenario, with revision checks. It does not re-save stale Plant/Grid parameters from the Run's pinned definition.
- Real provider checks returned USGS events, NASA feed entries and Tokyo forecasts. The global overview is about 1.3 MB, with separately validated country and place-label layers. Retain this small label set and let the renderer handle collisions, rather than thinning away countries at build time.

## Release verification — 3 September 2026

Application code: `8f3121d3`. Platform checks and builds passed. Tests: 18 contracts, 11 module runtime, 1,433 Agents (two existing skips), 635 World, 23 Host and one end-to-end integration; no failures.

Verified in an isolated production Workspace:

- Both new Scenario cards and the operator Room Definition are discovered; Situation Monitor settings load in the existing interactive Scenario editor.
- Global USGS/NASA collection and Tokyo forecasts return actual provider data. Regional watched-area filtering preserves unlocated records honestly.
- Native map geometry, global/regional views, forecast metadata and quantity-switchable charts render. Monitor-only Runs no longer display irrelevant physical-clock controls; timed orchestration still does.
- Source edits persist to the Run, and explicit save creates a new Scenario revision without overwriting unrelated settings.
- The actual Agent broker discovers the new schemas and reads live evidence; the default assistant's grants reject source-management commands. No paid model inference or autonomous management was exercised.
- A dynamically added video source played a real provider-hosted clip and unloaded successfully. Native video was browser-tested; provider-specific YouTube/HLS availability remains dependent on the chosen endpoint and browser.
- The existing Weather/Ambulance example still starts with its operational objects and clock controls.
- All three production services and public health pass.

Browser verification exposed and resolved a missing overview tile route, conflated vector label layers, and a pre-existing response wrapper that lost Bun file-slice offsets. A real HTTP regression test now verifies both tile routing and exact range response bytes. Overview URLs include the artifact build timestamp to prevent stale browser tiles after publication.

Deliberate limits remain: coarse global basemap, latest provider window rather than an archive, bounded map/query/chart output, no inferred physical effects, no AI video interpretation, and no promise of unattended collection across a service restart.
