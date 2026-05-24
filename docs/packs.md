# Leitbild Packs

A **Leitbild Pack** is a namespaced bundle of operational-domain capability.

Leitbild itself owns control instances, actors, roles, command envelopes, event ordering, state projection, map rendering, persistence, audit logs, metrics, and AI integration boundaries. Packs contribute domain-specific behavior behind those core seams.

Concrete pack implementations live in `src/packs/*`. The generic pack protocol, registry, and composition helpers live in `src/core/packs/*`.

## User-Facing Model

There is one installable unit: the pack.

Do not expose separate user-facing package types such as domain pack, simulation pack, scenario pack, UI pack, and asset pack. Those are contribution sections inside one pack.

Example repositories:

- `leitbild-pack-ambulance`
- `leitbild-pack-drone`
- `leitbild-pack-police`
- `leitbild-pack-robotaxi`

## Pack Contents

A pack may contain:

- domain schemas and domain object data validators
- object context schemas, context seed data, and agent-context renderers
- command kinds and payload validators
- simulation adapters or local simulation engines, including providers that compose with other active providers through the Simulation Hub
- provider metadata, including the pack's default simulation provider
- object icons, map symbols, and style rules
- object categories, summaries, visible fields, hover details, noteworthy-update policy, and inspectors
- object-attached contextual fields contributed to other packs' objects, such as weather-at-location or communications state
- pack-level map area features when a pack owns derived spatial truth that should be rendered but should not become canonical core geometry, such as weather H3 cells and influence shapes projected from the weather pack's sparse field model
- pack queries for read-only provider-owned computations, such as weather-at-point, H3 map features, traffic conditions intersecting a route, or ambulance dispatch state
- process graph definitions and validated process-link solver contracts when the pack owns a process simulation runtime
- process signal bindings for procedure/operator/AI access, including graph-owned tag ids, equipment ids, descriptions, and external refs
- typed control/protection rules for pack-owned alarms, trips, and validated process writes
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
  "description": "Ambulance dispatch domain, local simulator, and UI.",
  "contributes": {
    "domains": ["ambulance_dispatch"],
    "objectTypes": ["ambulance", "hospital", "incident", "patient"],
    "commands": [
      "ambulance.create_object",
      "ambulance.set_destination",
      "ambulance.cancel_destination"
    ],
    "simulationProviders": ["ambulance-local"],
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
- provider id: `ambulance-local`
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
- Packs issue changes to other operational domains only through declared commands, interaction signals, and committed events.
- Pack interaction handlers inspect signals plus current control-instance state and return constrained effects. They must not mutate shared state directly.

Multi-pack simulation orchestration uses the Simulation Hub once more than one provider is active in a Control Instance.

## Generic UI Boundary

Generic UI modules must not import pack-specific domain models, simulators, geometry helpers, or condition calculators. They consume the pack protocol.

Pack-specific presentation belongs behind `LeitbildPack`:

- `presentObject` owns the category, icon, color, summary, object fields, status indicator, and noteworthy-update policy for one object.
- `contextualFields` lets a pack add derived fields to other packs' objects without teaching the generic rail or map about that pack. For example, a weather pack may add a `Weather` field to an ambulance by sampling active weather objects at the ambulance position.
- `mapAreaFeatures` lets a pack synchronously project object-derived spatial features into generic rendered areas when the current object snapshot is sufficient.
- `mapAreaFeatureQueries` lets a pack request provider-backed spatial features when rendering depends on provider-owned private state. Weather uses this for H3 map features because the weather sparse field lives inside the weather provider, not in generic UI state.
- `PackMapAreaFeature.anchorPoint` and `symbol` let provider-projected areas carry an attached MapLibre symbol without rendering the same concept as an ordinary operational-object marker. Weather uses this for cloud icons that follow influence ovals.
- `PackMapAreaFeature.animation` is optional presentation metadata for smooth visual interpolation between provider query refreshes. It may move rendered geometry and attached symbol anchors between two provider-computed states, but it must not be treated as canonical simulation truth or used to update pack state.
- `createObjectTypes.parameters` lets packs declare creation controls for the generic create modal. Traffic can request severity, speed factor, and reason without hardcoding traffic fields into the modal.
- `PackQueryRequest` is the generic read-only API shape for provider-owned computations. Core validates the envelope and routes it through the Simulation Hub; the active provider validates the payload and returns a typed result or an explicit failure.

The generic map may still have a small static V1 layer vocabulary such as routes, traffic lines, generic pack areas, symbols, and overlays. That vocabulary must not contain pack algorithms. A later surface-registry pass should let packs register layer families and ordering metadata once the built-in surface model has settled.

Application assembly code may import built-in packs to create the active pack set. Shared UI components, map feature builders, and generic state modules should not.

## Spatial Field Contributions

Packs that need spatial fields, such as weather or a future wildfire pack, should use the shared spatial-index wrapper in `src/core/spatial/*` rather than importing geospatial indexing libraries directly. V1 uses H3 behind that wrapper because it gives globally stable hierarchical cells, viewport coverage, parent/child aggregation, and deterministic ids that work across users and reloads.

The boundary remains pack-owned:

- the pack computes its own field state
- the pack decides which field cells are materialized, active, decaying, or default
- the pack projects only the needed visual features through a provider-backed pack query; weather currently answers `weather.mapFeatures` with base grid outlines, affected H3 cells, and weather influence shapes
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

Queries must be read-only. They must not issue commands, mutate provider state, publish events, or perform hidden retries. Query kinds are registered by convention inside each pack/provider and must validate payloads at the provider boundary.

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
- `process-plant.runtime.status`
- `process-plant.telemetry.published`
- `process-plant.trends.read`
- `process-plant.ic.status`

Process-plant also accepts `process-plant.control.write` through the generic Control Instance command endpoint. The payload identifies a process system, exactly one signal reference (`path` or `tagId`), and a typed value. The provider resolves tag ids inside that explicit system, validates writability/type, and queues the write for the next solver phase; it does not mutate variables through the query route.

Process-plant also accepts `process-plant.ic.acknowledge`. The payload identifies a process system and an I&C lifecycle id such as `alarm:high-pressure:pzr-high-pressure`. Acknowledgement updates alarm/trip lifecycle state only; it does not clear the underlying process condition or mutate plant physics.

Process-plant signal queries expose graph-owned procedure/operator bindings. A signal binding may include `tagId`, `equipmentId`, `description`, and `externalRefs`, but it still resolves to a compiled variable path. Tags are unique only within one process system. There is no implicit current-unit lookup and no separate simulator binding catalog.

Process-plant I&C is the pack's simplified instrumentation-and-control substrate. It is not embedded procedure execution and not continuous physics. It reads instrumentation signals, evaluates normal controller logic, protection functions, alarms, permissives, and interlocks for one explicit process system, then emits persistent alarm/trip state transitions or validated queued writes. External procedure runners and AI agents should query signal and condition truth through the pack query surface and issue commands through the generic command path. `process-plant.conditions.evaluate` evaluates the same typed condition language used by rules and returns both the truth value and the signals read, which makes procedure/AI reasoning auditable without adding a procedure engine to the pack.

Process-plant permissives and interlocks are command gates, not hidden component side effects. They resolve target signals through graph-owned bindings and constrain the same queued write path used by operators, scenarios, AI agents, and internal I&C write effects. `process-plant.procedure-tags.validate` is a read-only compatibility helper for external procedure tag appendices; it reports missing or mismatched tags but does not parse or execute procedure documents.

Process-plant may also provide reference I&C behavior through an explicit per-system `icRef`. The current built-in reference is `process-plant.pressurized-water-reactor.ic.v1` for the built-in pressurized-water-reactor graph. It supplies reference plant automation and annunciation for common transients; it does not supply procedure execution, operator guidance, or EOP branching. A system config must choose either `icRef` or inline `protection`, not both.

Process-plant graph queries now expose compiled connection metadata as `connectionKind`, optional fluid `service`, `nominalFluid`, `designPhase`, `solverModel`, and indexed incoming/outgoing adjacency. Consumers should use the pack query surface rather than parsing scenario files directly when they need the runtime topology.

Process-plant variable queries expose both component variables and link-local variables. Current tank and condenser variables include inventory, level, temperature, makeup/production, and available outlet flow. Reactor coolant pumps may expose `developedHeadPa`, `loopFlowTargetKgPerS`, and `loopFlowKgPerS` when they own a declared primary loop. The current PWR graph also exposes reactor-vessel primary coolant inventory, inventory deviation, and pressure bias; the pressurizer remains the canonical RCS pressure source. Steam generators may expose `tubeLeakFraction`, `primaryToSecondaryLeakKgPerS`, and `secondaryRadiationMSvPerH` for SGTR-like faults. Current link variables include flow, temperature, pressure, radiation, valve position, and leak area where declared by the graph. Consumers should treat these as pack-owned process state, not core operational-object fields.

Process-plant provider config may define timed process actions and telemetry sampling per process system. This makes multi-system scenarios possible without adding a fleet-wide process abstraction to Leitbild core: a scenario can instantiate any number of independent `processSystems`, and each system can have its own telemetry variables and schedule. The process-plant provider persists runtime snapshots, fired scheduled actions, and telemetry buffers per system in provider-private state; it does not write dense process trends into the Control Instance event journal. Runtime snapshots include graph identity and compiled variable paths, and restores fail visibly when provider-private state no longer matches the compiled process graph.

Process-plant systems may use either an inline `graph` or a pack-owned `graphRef`. `graphRef` is the preferred shape for scenarios that instantiate existing graphs such as `process-plant.pressurized-water-reactor.v1` many times. A process system must define exactly one graph source, and unknown refs fail in the process-plant compiler before runtime starts. Per-system `parameters` overlay component parameters before graph compilation, while `initialState` initializes declared runtime variables before the first solver tick. Neither field may mutate topology.

## Interaction Contributions

Packs may contribute interaction capability for cross-object and cross-simulation behavior.

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
- Domain events are accepted canonical history after Leitbild validates, orders, persists, and broadcasts the effects.

Unknown signal payloads may be stored for audit, but must not mutate canonical state unless a registered handler validates and accepts them.

## Traffic Conditions

Traffic packs should model route-affecting road state first as aggregate traffic conditions: congestion zones, blocked segments, slow corridors, and access restrictions.

Individual traffic vehicles may be added later as a detail layer, but aggregate traffic conditions are the preferred first operational object because they are cheaper to render, easier for operators to understand, and easier for AI agents to reason over.

Traffic conditions may create route impacts for mobile assets. They should not silently reroute assets unless a future control-instance policy explicitly enables automatic rerouting.

## Scenario, Mission, and Context Use

Packs may contribute reusable data and schemas used by scenarios:

- **Object Context contributions** may seed perspective-bearing awareness or provide pack-specific renderers for agent context views.
- **Provider metadata** declares which runtime providers a pack offers and which one is the default for ordinary scenarios.
- **Scenario support codecs** may expand compact scenario object specs and operations into full validated `OperationalObject`s. These codecs belong to packs because packs own their `domainData`, object defaults, and domain vocabulary.

Packs must keep boundaries clear:

- `domainData` is pack-owned domain operational truth.
- `context` is perspective-bearing awareness.
- mission progress is runtime state owned by Leitbild, not static pack data.
- scenarios are top-level compositions that list active packs; they are not owned by one pack.
- provider ids are internal runtime wiring. Scenario APIs should expose `packs`, not low-level provider ids, unless a debug/runtime-detail endpoint explicitly asks for them.
- restored control instances use snapshots/history, not scenarios.
- object presentation decides whether revision changes are noteworthy for operator attention. Frequent motion updates should not become rail `new` badges; packs should enable noteworthy updates only for object types where a changed field is operationally meaningful.
- pack helpers may construct full `OperationalObject`s, but packs must not introduce a second production seed-object model beside Scenario Definitions.
- compact scenario files may name pack object specs, but the expanded Scenario Definition is still the runtime contract.
- multi-pack scenarios may override a pack's default provider and may provide provider config keyed by pack id. The Scenario Catalog resolves those pack-level choices into provider ids before the Simulation Hub starts providers.

## Trust Model

Code packs are trusted executable code. Installing one is equivalent to adding code to the Leitbild runtime.

Future installer work must make this explicit and validate:

- manifest schema
- namespace
- Leitbild version compatibility
- declared command kinds
- declared simulation providers
- declared UI contributions
- dependency and conflict metadata

Data-only scenario bundles may be introduced later for lower-risk distribution of scenarios, layouts, icons, and static map data.
