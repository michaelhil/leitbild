# Scenario authoring implementation

The approved cleanup keeps Scenario Definition → Compiled Scenario → Simulation Run as three purposeful boundaries. No compatibility parsers or migration aliases were added. Existing retained definitions/runs are not rewritten or deleted; unsupported old shapes require recreation.

## Implemented

- One browser-safe authored schema, strict API response schemas, and semantic validation before preview/save/start. Runtime/profile/command selection, schedulability, conditional query dependencies, core context, electrical endpoints and startup object references are checked. Forward startup references no longer depend on item order; missing or cyclic references identify the involved items.
- Authored `ScenarioDefinition` and internal `CompiledScenario` now agree with the domain vocabulary. The compiler, definition schema and preview projection have separate responsibilities. Unused linked-record targets and route/polygon editor scaffolding are removed.
- Recording belongs to each Pack Selection. Starting View is only map framing and visibility choices; fixed screen regions and persisted rail width are removed. New Pack layers/categories are discovered without resetting deliberate visibility preferences.
- Timeline object snapshots and Pack mutation codecs are removed. Ordinary live commands handle incident creation/counts, deletion, Drone model/swarm changes and Weather control. Full Weather replacement retains revision checking; its narrow enable/disable setter can be safely scheduled without supplying a future revision. Guidance, highlights and genuine interaction signals remain distinct from commands.
- Forms derive defaults from their owning seed/schema and straightforward limits from schemas. Plant/Grid reference choices expose compatibility; Drone config and authored/runtime model resolution share one schema. Ambulance references/equipment are editable. Weather keyframes are explicitly sparse ordered records, not implicit inheritance for every collection.
- Static preview uses Pack-owned geometry, including Weather ellipses. The editor bounds work to one request plus the newest pending structural draft; title/map-only edits do not recompile topology. Stale responses cannot replace current preview state.
- Save continues editing, saved revisions can be launched separately, launch failures remain visible, and closing warns about dirty state. Cancelling new placement removes the incomplete item. Duplicate-item, basic Timeline controls and validated advanced configuration cover data without imposing a universal form/graph language.
- Agents owns one Definition Library per Workspace across runtime eviction. Real simultaneous revision edits have one winner. Definition writes validate Pack/tool/script references and publish concrete result schemas.
- An unreadable retained Run is reported as unavailable without hiding healthy sibling Runs or rewriting retained state.

## Full power

`process-plant.pwr.full-power` owns the initial reactor-power, turbine-load and selected steam-generator-flow fractions. They resolve to 1, across two through six loops, without Halden-specific overrides or component-id assumptions. Sparse authored overrides remain intentional and validated. Initial fuel temperatures and neutral temperature-feedback references share a calculation, avoiding a leftover partial-power reference immediately introducing negative reactivity.

Tests inspect initialized solver values, the first neutral-feedback step, a real reactor trip, sparse overrides, bad parameters and restored progress. This is an initial operating condition, not an equilibrium solver or a power clamp: subsequent output is still calculated by the existing thermal/hydraulic, turbine and protection models. The refactor does not claim those models have gained new physical calibration.

## Time and lifecycle

See [Run clock decision](../../apps/world/docs/adr/0030-run-clock-and-observation-time.md). All local Packs within a Run read the same monotonic clock. Controls and cues are serialized; transition/shutdown barriers flush progress before changing rate or persisting the final state. Simulation epoch, wall observation time, solver step coordinates and wall-time Agent/lease activity have explicit separate purposes.

Drone no longer skips delayed numerical work. Recording is scheduled against Run elapsed time, not the minimum private age of participating assets. Fresh shared object timestamps and Weather/Grid command projections now use observation time, while physical samples retain explicit simulation time.

## Deliberate limits

- Scenario validation does not promise every future command will succeed: users can remove assets and external/live preconditions can change. Those failures are reported at execution. The basic Timeline editor is not a workflow language or a static proof engine.
- The advanced editor is intentional for deep graphs and model parameters. There is no claim that every supported document has a bespoke form. It validates the complete candidate scenario before applying changes.
- Weather is observable alongside Plant/Grid but does not secretly alter their physics. New physical responses require consumer-owned models.
- Existing Pack-specific geometry, solver and fleet limits remain authoritative. There is no uniform asset-count limit pretending a Drone and a large Plant have the same cost.
- Graceful shutdown/restart is synchronized; abrupt-crash persistence remains non-atomic across the existing journal/snapshot/private-checkpoint stores. Exact replay or seek would require coordinated checkpoint generations. This limitation is explicit, not hidden behind state reconstruction.

## Verification

Focused regressions cover all-loop full-power initialization, a real five-Pack shared-clock Run through pause/rate controls and restart, live incident updates, equal-time cue ordering, pause/restore without replay, conditional providers, forward/missing references, keyframe append/reset, latest-only previews and concurrent Agents writes. Full platform checks, tests, production builds and browser/deployment verification are recorded in the completion report.

Warm four-Plant/Grid/Weather compilation measured approximately 18–40 ms during the concurrent regression run; the base Pack authoring catalog was 43,966 JSON bytes before adding runtime-discovered command descriptors. No additional compiler cache or worker farm was introduced. The main preview saving is avoiding unnecessary compilations and bounding in-flight work.
