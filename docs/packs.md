# Leitbild Packs

A **Leitbild Pack** is a namespaced bundle of operational capability.

Leitbild itself owns control instances, actors, roles, command envelopes, event ordering, state projection, map rendering, persistence, audit logs, metrics, and AI integration boundaries. Packs contribute pack-specific behavior behind those core seams.

Concrete pack implementations live in `src/packs/*`. The generic pack protocol, registry, and composition helpers live in `src/core/packs/*`.

## User-Facing Model

There is one installable unit: the pack.

Do not expose separate user-facing package types such as pack, simulation pack, scenario pack, UI pack, and asset pack. Those are contribution sections inside one pack.

Example repositories:

- `leitbild-pack-ambulance`
- `leitbild-pack-drone`
- `leitbild-pack-police`
- `leitbild-pack-robotaxi`

## Pack Contents

A pack may contain:

- pack schemas and pack object data validators
- object context schemas, context seed data, and agent-context renderers
- command kinds and payload validators
- pack runtime adapters or local simulation engines, including pack runtimes that compose with other active pack runtimes through the Runtime Hub
- pack runtime metadata, including the pack's default pack runtime
- object icons, map symbols, and style rules
- object categories, summaries, visible fields, hover details, noteworthy-update policy, and inspectors
- object-attached contextual fields contributed to other packs' objects, such as weather-at-location or communications state
- pack-level map area features when a pack owns derived spatial truth that should be rendered but should not become canonical core geometry, such as weather H3 cells and influence shapes projected from the weather pack's sparse field model
- pack queries for read-only runtime-owned computations, such as weather-at-point, H3 map features, traffic conditions intersecting a route, or ambulance dispatch state
- process graph definitions and validated process-link solver contracts when the pack owns a process pack runtime
- process signal bindings for procedure/operator/AI access, including graph-owned tag ids, equipment ids, descriptions, and external refs
- typed control/protection rules for pack-owned alarms, trips, and validated process writes
- operational projections for pack-internal simulations that need map/rail awareness without exposing every internal variable as an operational object
- generic operational demand handlers for cross-pack capability requests, such as ambulance responding to `medical.transport`
- command/action builders for UI controls
- interaction signal schemas and interaction handlers
- operational notification renderers and severity rules
- dashboard widgets and adaptive UI primitives
- research metrics, replay analyzers, and export helpers
- AI-agent prompts, role definitions, and tool descriptions

## Static V1

V1 uses static built-in packs only. A static pack is imported by Leitbild at build time and registered by code.

This is intentional. It lets the pack interface mature before Leitbild supports remote GitHub installation.

The first static pack is the ambulance dispatch pack.

## Future GitHub Distribution

Future pack repositories should use this layout:

```text
leitbild-pack-ambulance/
  leitbild.pack.json
  src/
    pack.ts
    model.ts
    commands.ts
    sim/
    ui/
    metrics/
  assets/
    icons/
  tests/
```

Installation should mirror the Samsinn pack model:

- bare name resolved through a configured registry
- `owner/repo` shorthand
- full Git URL
- clone into a temporary directory
- read `leitbild.pack.json`
- validate namespace and compatibility
- move into the final pack directory
- register contributions
- notify active UIs and control instances

Suggested environment variable:

```text
LEITBILD_PACK_SOURCES=leitbild-packs,michaelhil/leitbild-pack-ambulance
```

Suggested installed location:

```text
~/.leitbild/packs/<namespace>/
```

Server deployments may use:

```text
/opt/leitbild/packs/<namespace>/
```

## Manifest

Future external packs should include `leitbild.pack.json`.

```json
{
  "id": "ambulance",
  "name": "Ambulance Dispatch",
  "version": "0.1.0",
  "leitbild": ">=0.1.0",
  "description": "Ambulance dispatch pack, local runtime, and UI.",
  "contributes": {
    "objectTypes": ["ambulance", "hospital", "incident", "patient"],
    "commands": [
      "ambulance.create_object",
      "ambulance.set_destination",
      "ambulance.cancel_destination"
    ],
    "runtimes": ["ambulance-local"],
    "interactionSignals": [
      "asset.arrived_at_target",
      "facility.capacity_changed"
    ],
    "interactionHandlers": [
      "ambulance.arrival-handler",
      "ambulance.capacity-handler"
    ],
    "contextSchemas": ["ambulance.context.v1"],
    "ui": ["objectDisplay", "inspector", "actions"],
    "map": ["icons", "plannedRoutes"],
    "metrics": ["response_time", "time_to_scene"]
  },
  "dependencies": [],
  "compatibleWith": [],
  "conflicts": []
}
```

## Namespacing

Pack contribution identifiers must be namespaced.

Examples:

- command kind: `ambulance.set_destination`
- runtime id: `ambulance-local`
- UI contribution: `ambulance.object-inspector`
- metric: `ambulance.response-time`

Packs must not shadow core contribution names.

## Composition

Multiple packs should eventually be active in one control instance, for example ambulance + police + drone.

Composition rules:

- Leitbild owns the control instance clock.
- Leitbild owns event ordering.
- Leitbild owns command envelopes and actor identity.
- Leitbild owns permissions and ownership rules.
- Leitbild owns object IDs and canonical state.
- Leitbild owns interaction signal ordering and effect commit.
- Packs publish events through Leitbild seams.
- Packs issue changes to other operational areas only through declared commands, interaction signals, and committed events.
- Pack interaction handlers inspect signals plus current control-instance state and return constrained effects. They must not mutate shared state directly.
- Packs that need another pack's capability should emit a generic demand signal when possible. The source pack describes the need; responder packs decide whether and how to materialize target objects or notifications.

Multi-pack runtime orchestration uses the Runtime Hub once more than one pack runtime is active in a Control Instance.

## Generic UI Boundary

Generic UI modules must not import pack-specific pack models, runtimes, geometry helpers, or condition calculators. They consume the pack protocol.

Pack-specific presentation belongs behind `LeitbildPack`:

- `presentObject` owns the category, icon, color, summary, object fields, status indicator, and noteworthy-update policy for one object.
- `contextualFields` is detail-tier enrichment only. It lets a pack add derived fields to another pack's object for inspectors, hover detail, or selected-object detail without making map and rail summaries pay for cross-pack inference. Contextual enrichment must use the presentation object index or a bounded pack query rather than scanning the full Control Instance object list on every row render.
- `mapAreaFeatures` lets a pack synchronously project object-derived spatial features into generic rendered areas when the current object snapshot is sufficient.
- `mapAreaFeatureLayers` declares which surface map layers activate pack area features so generic map lifecycle code does not hard-code a concrete pack such as weather.
- `mapAreaFeatureQueries` lets a pack request runtime-backed spatial features when rendering depends on runtime-owned private state. Weather uses this for H3 map features because the weather sparse field lives inside the weather pack runtime, not in generic UI state.
- `PackMapAreaFeature.anchorPoint` and `symbol` let pack runtime-projected areas carry an attached MapLibre symbol without rendering the same concept as an ordinary operational-object marker. Weather uses this for cloud icons that follow influence ovals.
- `PackMapAreaFeature.animation` is optional presentation metadata for smooth visual interpolation between pack runtime query refreshes. It may move rendered geometry and attached symbol anchors between two pack runtime-computed states, but it must not be treated as canonical simulation truth or used to update pack state.
- `createObjectTypes.parameters` lets packs declare creation controls for the generic create modal. Traffic can request severity, speed factor, and reason without hardcoding traffic fields into the modal.
- `PackQueryRequest` is the generic read-only API shape for runtime-owned computations. Core validates the envelope and routes it through the Runtime Hub; the active pack runtime validates the payload and returns a typed result or an explicit failure.

The generic map may still have a small static V1 layer vocabulary such as routes, traffic lines, generic pack areas, symbols, and overlays. That vocabulary must not contain pack algorithms. A later surface-registry pass should let packs register layer families and ordering metadata once the built-in surface model has settled.

Application assembly code may import built-in packs to create the active pack set. Shared UI components, map feature builders, and generic state modules should not.

## Process-Plant Operational Projection

The process-plant pack may expose selected process systems as ordinary Leitbild operational objects. These objects are facades, not the process simulation itself.

A scenario object of type `unit` declares:

- `systemId`: the process system it represents
- `location`: map point
- optional `clusterId`
- optional `coolingWater`

The local process-plant pack runtime projects runtime/I&C state back onto that object at the pack runtime tick. The projection includes status tone, status label, active alarm/trip counts, summary, and selected rail fields such as thermal power, electric output, pressurizer pressure, steam-generator level, radiation, and containment pressure. The process variable table remains the source of truth; the projection is only the shared operational picture for map, rail, AI overview, and cross-pack awareness.

## Spatial Field Contributions

Packs that need spatial fields, such as weather or a future wildfire pack, should use the shared spatial-index wrapper in `src/core/spatial/*` rather than importing geospatial indexing libraries directly. V1 uses H3 behind that wrapper because it gives globally stable hierarchical cells, viewport coverage, parent/child aggregation, and deterministic ids that work across users and reloads.

The boundary remains pack-owned:

- the pack computes its own field state
- the pack decides which field cells are materialized, active, decaying, or default
- the pack projects only the needed visual features through a runtime-backed pack query; weather currently answers `weather.mapFeatures` with base grid outlines, affected H3 cells, and weather influence shapes
- the generic UI renders those features through MapLibre sources and layers without knowing the pack's internal data structures

This prevents the map from becoming weather-specific while still letting several future packs reuse the same spatial index vocabulary. H3 cell ids are allowed to cross pack boundaries as spatial references; weather state, fire state, radiation state, and exposure state must remain separate pack-owned data unless an explicit interaction or query contract is introduced.

## Pack Query Surface

The generic Control Instance API exposes one read-only query route:

```text
POST /api/control-instances/:id/queries
```

The request envelope is:

```json
{
  "packId": "weather",
  "kind": "weather.sampleAtPoint",
  "payload": {}
}
```

The response envelope is either:

```json
{
  "response": {
    "ok": true,
    "packId": "weather",
    "kind": "weather.sampleAtPoint",
    "result": {},
    "generatedAt": "2026-05-20T12:00:00.000Z"
  }
}
```

or an explicit failure:

```json
{
  "response": {
    "ok": false,
    "packId": "weather",
    "kind": "weather.sampleAtPoint",
    "reason": "weather pack does not support query kind: weather.foo",
    "generatedAt": "2026-05-20T12:00:00.000Z"
  }
}
```

Queries must be read-only. They must not issue commands, mutate pack runtime state, publish events, or perform hidden retries. Query kinds are registered by convention inside each pack/pack runtime and must validate payloads at the pack runtime boundary.

Current built-in query kinds:

- `weather.sampleAtPoint`
- `weather.sampleAlongRoute`
- `weather.summarizeArea`
- `weather.mapFeatures`
- `weather.fieldStats`
- `ambulance.objects`
- `ambulance.object`
- `ambulance.dispatchState`
- `traffic.conditions`
- `traffic.condition`
- `traffic.conditionsForRoute`
- `process-plant.systems.list`
- `process-plant.graph.read`
- `process-plant.variables.read`
- `process-plant.variables.search`
- `process-plant.signals.resolve`
- `process-plant.signals.read`
- `process-plant.signals.search`
- `process-plant.conditions.evaluate`
- `process-plant.procedure-tags.validate`
- `process-plant.control.validate`
- `process-plant.catalog.list`
- `process-plant.catalog.source`
- `process-plant.credibility.list`
- `process-plant.credibility.read`
- `process-plant.runtime.status`
- `process-plant.transient.diagnostics`
- `process-plant.telemetry.published`
- `process-plant.trends.read`
- `process-plant.ic.status`
- `process-plant.ic.catalog`
- `process-plant.surfaces.list`
- `process-plant.surface.read`
- `process-plant.surface.snapshot`
- `process-plant.surface.project`
- `process-plant.artifact.read`
- `process-plant.alarms.status`
- `process-plant.alarms.summary`
- `process-plant.alarms.history`

Process-plant also accepts `process-plant.control.write` through the generic Control Instance command endpoint. The payload identifies a process system, exactly one signal reference (`path` or `tagId`), and a typed value. The pack runtime resolves tag ids inside that explicit system, validates writability/type, and queues the write for the next solver phase; it does not mutate variables through the query route. `process-plant.control.validate` uses the same validation and permissive/interlock gate path as a read-only dry run, so UI and AI clients can explain whether a control write would be accepted before issuing it.

Process-plant also accepts `process-plant.ic.lifecycle`. The payload identifies a process system, an I&C lifecycle id such as `alarm:high-pressure:pzr-high-pressure`, and one lifecycle action: `acknowledge`, `reset`, `suppress`, `unsuppress`, `shelve`, or `unshelve`. It may include a human-readable `reason` and a `shelveDurationMs` for time-bounded shelving. These actions update alarm/trip lifecycle state only; they do not clear the underlying process condition, execute procedures, or mutate plant physics.

Process-plant alarm queries are convenience views over the same I&C lifecycle state, not a second alarm model. `process-plant.alarms.status` returns current alarms and trips plus a summary, `process-plant.alarms.summary` returns grouped counts and first-out state, and `process-plant.alarms.history` returns bounded transition history with operator/client provenance.

Process-plant signal queries expose graph-owned procedure/operator bindings. A signal binding may include `tagId`, `equipmentId`, `description`, and `externalRefs`, but it still resolves to a compiled variable path. Tags are unique only within one process system. There is no implicit current-unit lookup and no separate runtime binding catalog.

Process-plant I&C is the pack's simplified instrumentation-and-control substrate. It is not embedded procedure execution and not continuous physics. It reads instrumentation signals, evaluates normal controller logic, protection functions, alarms, permissives, and interlocks for one explicit process system, then emits persistent alarm/trip state transitions or validated queued writes. I&C rules may include structured annunciator metadata and optional mode conditions, but both are still declarative rule data, not procedure code. External procedure runners and AI agents should query signal and condition truth through the pack query surface and issue commands through the generic command path. `process-plant.conditions.evaluate` evaluates the same typed condition language used by rules and returns both the truth value and the signals read, which makes procedure/AI reasoning auditable without adding a procedure engine to the pack.

Process-plant permissives and interlocks are command gates, not hidden component side effects. They resolve target signals through graph-owned bindings and constrain the same queued write path used by operators, scenarios, AI agents, and internal I&C write effects. `process-plant.procedure-tags.validate` is a read-only compatibility helper for external procedure tag appendices; it reports missing or mismatched tags but does not parse or execute procedure documents.

Process-plant reusable assets are registered through generic catalog contributions rather than hardcoded in the generic runtime/query layer. Contributions can provide graph specs, assemblies, graph fragments, fragment presets, I&C refs, graph-aware I&C refs, dynamic I&C ref patterns, and process surfaces. `process-plant.catalog.list` exposes those contributed refs/ids for tooling and UI discovery; the operational UI includes a read-only process-plant catalog view for browsing and copying them.

Process-plant credibility evidence is exposed through generic read-only evidence queries. `process-plant.credibility.list` returns evidence sets applicable to one compiled system, and `process-plant.credibility.read` returns a named generated artifact. Current PWR evidence is one registered evidence contributor; generic UI reads the evidence query and does not import PWR-specific models.

Process-plant may also provide reference I&C behavior through an explicit per-system `icRef`. Built-in PWR refs are contributed through the same process-plant catalog. Fixed refs such as `process-plant.pressurized-water-reactor.ic.v1` remain available for fixed reference graphs; graph-aware refs such as `process-plant.pwr.reference.graph.ic.v2` derive loop ids from the compiled graph and are preferred for modular PWR variants. Reference I&C supplies plant automation and annunciation for common transients; it does not supply procedure execution, operator guidance, or EOP branching. A system config must choose either `icRef` or inline `protection`, not both.

Process-plant graph queries now expose compiled connection metadata as `connectionKind`, optional fluid `service`, `nominalFluid`, `designPhase`, `solverModel`, and indexed incoming/outgoing adjacency. Consumers should use the pack query surface rather than parsing scenario files directly when they need the runtime topology.

Process-plant variable queries expose both component variables and link-local variables. Current tank and condenser variables include inventory, level, temperature, makeup/production, and available outlet flow. Reactor coolant pumps may expose `developedHeadPa`, `loopFlowTargetKgPerS`, and `loopFlowKgPerS` when they own a declared primary loop. The current PWR graph also exposes reactor-vessel primary coolant inventory, inventory deviation, and pressure bias; the pressurizer remains the canonical RCS pressure source. Steam generators may expose `tubeLeakFraction`, `primaryToSecondaryLeakKgPerS`, and `secondaryRadiationMSvPerH` for SGTR-like faults. Current link variables include flow, temperature, pressure, radiation, valve position, and leak area where declared by the graph. Consumers should treat these as pack-owned process state, not core operational-object fields.

Process-plant runtime config may define timed process actions and telemetry sampling per process system. This makes multi-system scenarios possible without adding a fleet-wide process abstraction to Leitbild core: a scenario can instantiate any number of independent `processSystems`, and each system can have its own telemetry variables and schedule. Pack runtime config system keys must match declared process system ids exactly; unknown keys are rejected because they almost always indicate a scenario authoring typo. The process-plant pack runtime persists runtime snapshots, fired scheduled actions, and telemetry buffers per system in runtime-private state; it does not write dense process trends into the Control Instance event journal. Runtime snapshots include graph identity and compiled variable paths, and restores fail visibly when runtime-private state no longer matches the compiled process graph.

Process-plant systems may use an inline `graph`, a pack-owned `graphRef`, or an `assemblyRef` with `assemblyConfig`. `graphRef` is the preferred shape for scenarios that instantiate existing graphs many times. `assemblyRef` is the preferred shape when the final graph should be generated from reusable fragments, for example PWR variants with different loop counts or a non-PWR plant assembled from shared process fragments. A process system must define exactly one graph source, and unknown refs fail in the process-plant compiler before runtime starts. Per-system `parameters` overlay component parameters before graph compilation, while `initialState` initializes declared runtime variables before the first solver tick. Neither field may mutate topology.

## Interaction Contributions

Packs may contribute interaction capability for cross-object and cross-runtime behavior.

An **Interaction Signal** is a scoped claim, observation, or interaction attempt. Examples:

- `asset.arrived_at_target`
- `facility.capacity_changed`
- `incident.patient_count_updated`
- `observation.detected`
- `ai.recommendation.created`

An **Interaction Handler** validates signal payloads it understands, inspects the current control-instance snapshot, and returns constrained effects such as object upserts, object deletes, or operational notifications.

Packs must keep the distinction clear:

- Signals are input claims or observations.
- Handler effects are proposals.
- Control Instance events are accepted canonical history after Leitbild validates, orders, persists, and broadcasts the effects.

Unknown signal payloads may be stored for audit, but must not mutate canonical state unless a registered handler validates and accepts them.

## Traffic Conditions

Traffic packs should model route-affecting road state first as aggregate traffic conditions: congestion zones, blocked segments, slow corridors, and access restrictions.

Individual traffic vehicles may be added later as a detail layer, but aggregate traffic conditions are the preferred first operational object because they are cheaper to render, easier for operators to understand, and easier for AI agents to reason over.

Traffic conditions may create route impacts for mobile assets. They should not silently reroute assets unless a future control-instance policy explicitly enables automatic rerouting.

## Scenario, Mission, and Context Use

Packs may contribute reusable data and schemas used by scenarios:

- **Object Context contributions** may seed perspective-bearing awareness or provide pack-specific renderers for agent context views.
- **Pack runtime metadata** declares which runtime pack runtimes a pack offers and which one is the default for ordinary scenarios.
- **Scenario support codecs** may expand compact scenario object specs and operations into full validated `OperationalObject`s. These codecs belong to packs because packs own their `packData`, object defaults, and pack vocabulary.

Packs must keep boundaries clear:

- `packData` is pack-owned operational truth.
- `context` is perspective-bearing awareness.
- mission progress is runtime state owned by Leitbild, not static pack data.
- scenarios are top-level compositions that list active packs; they are not owned by one pack.
- runtime ids are internal runtime wiring. Scenario APIs should expose `packs`, not low-level runtime ids, unless a debug/runtime-detail endpoint explicitly asks for them.
- restored control instances use snapshots/history, not scenarios.
- object presentation decides whether revision changes are noteworthy for operator attention. Frequent motion updates should not become rail `new` badges; packs should enable noteworthy updates only for object types where a changed field is operationally meaningful.
- pack helpers may construct full `OperationalObject`s, but packs must not introduce a second production seed-object model beside Scenario Definitions.
- compact scenario files may name pack object specs, but the expanded Scenario Definition is still the runtime contract.
- multi-pack scenarios may override a pack's default pack runtime and may provide runtime config keyed by pack id. The Scenario Catalog resolves those pack-level choices into runtime ids before the Runtime Hub starts pack runtimes.

## Trust Model

Code packs are trusted executable code. Installing one is equivalent to adding code to the Leitbild runtime.

Future installer work must make this explicit and validate:

- manifest schema
- namespace
- Leitbild version compatibility
- declared command kinds
- declared pack runtimes
- declared UI contributions
- dependency and conflict metadata

Data-only scenario bundles may be introduced later for lower-risk distribution of scenarios, layouts, icons, and static map data.
