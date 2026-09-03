# Situation Monitor implementation

Approved 2026-09-03: implement a native, globally configurable World Pack, inspired by product capabilities rather than copied World Monitor code or data. Reuse Scenario Definitions, Runs, the World map, and Agents' capability broker.

## Delivery checkpoints

- [x] Foundations: global vector coverage, typed Pack map features, clock-independent observations, Pack-owned authoring/probe extension.
- [x] Collection: source schemas/adapters, restricted HTTP, shared Workspace collectors, bounded indexed records, durable live source edits, editor and inspector.
- [x] Measurements/media: original-provider forecasts, charts, supported on-demand video, visible failure and freshness.
- [ ] Agents/release: discoverable reads and management, editable global/non-Norwegian examples, lifecycle/security/storage/performance tests, production verification.

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
- Real provider checks returned USGS events, NASA feed entries and Tokyo forecasts. The global overview build is 1,124,870 bytes. Initial full World suite: 627 passing tests; expanded Pack coverage adds persistence, isolation, indexed search, dateline, geometry, parser and budget cases.
- Interactive production verification remains the final gate.
