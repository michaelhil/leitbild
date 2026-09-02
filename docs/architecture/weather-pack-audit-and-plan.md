# Weather Pack audit and proposed rebuild

Date: 2026-09-02. Weather findings are based on the current implementation, including direct local runtime experiments. Weather changes below are proposed for approval, not implemented. Aviation and Traffic removal is separately completed.

## Recommendation

Keep Weather as an independent Pack. Rebuild its internals around **authored weather influences, one sampling path, and persistent ground conditions**. Keep the existing shared H3 wrapper, Scenario Library, Runtime Hub, Capability broker, editor and Historian. Do not introduce an environmental microservice, general-purpose field engine, new orchestration language, or a mandatory integration Pack.

Weather is about 2,345 lines across 12 files. Its main problem is not sheer size: it is inconsistent truth, incomplete lifecycle handling, and duplicated configuration paths. The package boundary is useful; some implementation choices inside it need replacement.

Fire should eventually be a separate Pack. Weather supplies atmospheric conditions; Fire owns fuel, ignition, combustion, spread, suppression and smoke. They can share spatial primitives without sharing a solver or becoming mutually dependent.

## Completed removal

- Removed Aviation and Traffic Pack implementations, registrations, lazy UI loaders, icons, Aviation source selector, live-source adapters, Aviation reference-data builders/schemas/styles, obsolete fixtures and Pack-specific documentation.
- Removed the Aviation Agents demo and VATSIM tool. Generic Pack-loading tests now use independent test-only examples.
- Removed the saved Aviation definition from both active Workspaces and its two unreferenced stored revisions.
- Deleted the Aviation reference release/builds and its two source-cache directories on production, approximately 68 MiB in total, and removed the unused OpenAIP credential from the server environment file. No archive was created. Source code remains recoverable from Git; deleted generated source/tile data would need reacquisition/rebuilding or an existing independent backup.
- Preserved all six existing World runs, other Agents rooms, the grid dataset, Ambulance routing, Drone operations, and common base-map geographic features. An airport drawn on the base map or represented as an electricity consumer is not the deleted Aviation Pack.
- Preserved the generic route-impact data model consumed by Ambulance. It is useful operational state, not a dependency on Traffic. Route-planned signals likewise remain general simulation events.

Code commit: `bc3553b2`. Production release: `20260902T185052Z-bc3553b203-9155ba9892`.

## Current lifecycle and functional inventory

| Stage | Current implementation | Assessment |
|---|---|---|
| Discovery | Application assembly, Pack descriptor, runtime descriptor and six typed Simulation Capabilities | Correct common boundary; descriptions need more domain semantics |
| Authoring | One `weather_condition` Scenario Item; Pack config declares custom extension fields | Areas editable only in part; probes cannot be authored as Scenario Items |
| Compilation | `scenario.ts` expands area defaults and keyframes into Weather objects | Deterministic compilation is worth retaining; state constructors are duplicated in live creation |
| Influences | Ellipses with center, axes, rotation, priority, falloff and timed keyframes | Useful compact representation; interpolation/overlap need stricter semantics |
| Atmosphere | Temperature, humidity, wind, visibility, cloud and precipitation | Prescribed scenario conditions, not numerical weather prediction or a real forecast feed |
| Ground | Temperature, normalized wetness, standing water, snow, ice and frost | Heuristic accumulation/freezing/melting/drying; no terrain/material/drainage inputs |
| Spatial field | Sparse H3 cells plus an active-cell set | Good sparsity concept; geometry work and state retention need correction |
| Runtime | Local adapter, five-second wall timer, Simulation Clock hooks | Commands and read time can disagree; no Weather field checkpoint |
| Projection | Influence object summaries, sampled probes and runtime-generated map polygons | Different consumers can see different conditions |
| Interaction | Read queries and contextual presentation fields | No implemented Weather-to-Ambulance, Drone, Plant or Grid physical response |
| Recording | Generic command/object journal; no Weather recording profile | Dense ground evolution is neither retained as current restart state nor offered as selected observation series |
| Shutdown/reopen | Clears timer/subscribers; reconnect rebuilds field from objects | Lost surface memory on idle-runtime close or restart |

Primary files: [Pack](../../apps/world/src/packs/weather/pack.ts), [schema](../../apps/world/src/packs/weather/model.ts), [scenario codec](../../apps/world/src/packs/weather/scenario.ts), [runtime](../../apps/world/src/packs/weather/sim/adapter.ts), [influence evaluation](../../apps/world/src/packs/weather/influence.ts), [sparse field](../../apps/world/src/packs/weather/cell-field.ts), [ground model](../../apps/world/src/packs/weather/conditions.ts), [queries](../../apps/world/src/packs/weather/query.ts), [projection](../../apps/world/src/packs/weather/projection.ts).

## Findings requiring correction

### 1. Ground state changes without time passing

`cellStateFrom` blends the previous surface toward an influence's authored surface on every update, including updates with zero elapsed time. Clock changes, committed object observations and commands all call this path. Observing the runtime's own emitted objects can therefore apply forcing again.

Local reproduction with a 50%-weighted wetness influence, repeatedly evaluated at exactly the same time:

| Evaluation | Grid wetness |
|---|---:|
| First | 0.5000 |
| Second | 0.7500 |
| Third | 0.8750 |
| Fourth | 0.9375 |

The separate analytic presentation calculation remains at 0.5. This is both a time-step bug and a disagreement about current conditions, not merely an approximation due to grid resolution.

**Change:** distinguish initial ground state, continuing atmospheric forcing and explicit ground interventions. Repeated observation must be idempotent; only an elapsed-time integration step or an explicit accepted action may change ground state.

### 2. Restart loses the field

Weather's snapshot contains objects, not the accumulated sparse surface field, and its adapter never uses `runtimeStateStore`. A direct snapshot/reconnect experiment changed sampled wetness from **0.96875 to 0.5**. Ground left behind by a moved/deleted influence is not reconstructible from the remaining objects.

**Change:** use the existing Pack runtime-state persistence mechanism for the sparse field and its simulation timestamp. Derivable atmosphere/geometry caches should not be persisted. Validate configuration/influence identity and checkpoint time on restore; never silently substitute initial conditions for corrupt or missing required resume state. Use the existing flush policy and report its crash-recovery window honestly; this is not a promise of transactional, zero-loss persistence. Flush on orderly close.

### 3. Clock semantics and update delivery are inconsistent

- Commands use wall-clock `nowIso()` for simulation observations and influence time origins. A probe created in a paused `2026-01-01T09:00:00Z` simulation was stamped `2026-09-02T18:53:18Z`.
- `quality.validAt` doubles as the immutable keyframe origin. Updating observation freshness would accidentally move the keyframe timeline.
- Runtime queries can lag the run clock between five-second updates. `setClock` recomputes with zero elapsed time rather than defining how ground state advances across a seek.
- Change detection omits wind speed/direction, humidity, visibility, cloud cover and standing water. A local wind-only experiment returned **9 m/s through the query but 3 m/s in the probe object** after a runtime tick.
- Timer failures are not caught and surfaced with the explicit degraded-runtime handling used in the newer Grid runtime.

**Change:** separate wall receipt time, simulation time, influence start time and sample time. Use a bounded simulation-time integration step independent of browser refresh. Publish command effects immediately; sample/projection tolerances must cover every published field. Pause does not integrate. Forward seeking requires bounded stepping; backward seeking must be rejected unless restoring a checkpoint/reset is explicitly supported. Do not invent historical ground data by evaluating today's field at an old timestamp.

### 4. Three views of Weather do not agree

The Pack's contextual asset fields call `weatherSampleAtPoint`, which recomputes conditions from influences without ground memory. Queries/probes sample the sparse field. Map queries can combine current field cells with influence shapes evaluated at a caller-supplied different time.

**Change:** one runtime-owned sampler for all current reads. Renderers format results; they do not infer weather from Weather objects. Return simulation time, field revision, units and spatial resolution. Map aggregation is explicitly a presentation summary, not a different physics calculation.

### 5. H3 usage has correctness and resource-budget gaps

- `core/spatial/hex-index.ts` discards polygon holes. A test polygon containing a hole still returned the cell centered inside that hole.
- Center-based coverage can omit a small/narrow influence entirely. A valid one-metre influence produced zero cells, while the analytic calculation at its center reported wetness 0.5.
- `truthResolution` is stored in per-object **render** settings; the highest value selects one runtime-wide grid. Resolution 0 is ignored by a truthiness check and becomes 8. Live additions do not cleanly redefine the grid.
- Area sizes, keyframe counts, resolution and polygon coverage have no coordinated work budget. Resolution 15 is accepted.
- Map base-grid limiting generates the full candidate array before checking the 4,000-cell threshold. It is an output limit, not a safe allocation limit. Affected-cell and influence output are not covered by that limit.

**Change:** one explicit field resolution in Pack configuration, separate display resolution. Bound geometry and work before allocation; also cap final outputs. Retain exact point-based atmospheric sampling so a small weather influence cannot disappear. For ground, state a coverage/resolution policy and expose its limits; do not silently paint a whole large cell at full strength for a tiny influence.

### 6. Query descriptions promise more than implementations enforce

`sample-along-route` describes bounded sampling, but any positive `intervalM` is accepted and a while-loop creates every sample. Tiny intervals can exhaust CPU/memory. Polygon/route input sizes are also unbounded. Area summaries scan only stored cells, ignoring normal background area and polygon holes, so their counts do not represent the whole requested area.

**Change:** hard point/vertex/cell/response budgets, documented minimum spacing, and explicit errors or reported coarsening. Include coverage, effective spacing/resolution, background handling and timestamps in results. Use a shared, tested containment implementation rather than another exterior-ring-only helper. A browser timeout cannot cancel synchronous server computation already in progress.

### 7. Configuration, naming and controls have drifted

- Scenario type `weather_condition`, live types `weather_area`/`weather_probe`, and stored `conditionKind` create an unnecessary naming translation.
- Live areas and Scenario areas have separate constructors and different validation. Runtime extension values bypass the Scenario's declared extension schema.
- Full states are expanded into every keyframe, so an influence intended to change only rain also brings default wind/temperature/surface values into overlapping influences.
- Duplicate keyframe times and inconsistent falloff grids can pass initial validation and fail only during interpolation. Frames are re-sorted repeatedly during evaluation.
- Editor controls expose only part of the model: no precipitation-type selector, full wind settings, probes or keyframe editing. Its location defaults contain Oslo coordinates instead of relying solely on placement.
- Live area creation advertises no parameter controls despite requiring both ellipse radii; the generic point-creation UI cannot supply a complete useful area request without further configuration.
- `showAffectedCells` and `showIcon` are accepted but not consistently honored. Confidence values are fixed constants, not measured uncertainty.
- Custom extension fields have no concrete operational consumer in production. They add a second type/interpolation system without providing new weather physics.

**Change:** one area specification and one probe specification reused by compilation, runtime actions and editor defaults. Keep influences as explicit patches over a run baseline. Remove the unused extension mini-language unless a concrete consumer is identified before implementation. Remove ineffective controls and fake precision, or implement their actual semantics. Preserve all currently useful weather quantities and moving/keyframed influences.

### 8. Performance and debloating

Every update rebuilds each influence's polygon and H3 coverage, parses/sorts keyframes repeatedly, and checks every candidate cell against every influence. Map queries scan all stored cells and can rebuild geometry independently for each viewer. The browser already coalesces requests and pauses background map refresh while dragging, but refreshes on a two-second cadence against a five-second field update.

**Change:** compile/validate influences once; cache stationary coverage and cell geometry; invalidate by influence/field revision; spatially prefilter relevant influences. Cache bounded map projections per field revision/view bucket. Start with simple maps and bounded caches, not an R-tree/worker pool by default. Measure before adding a more elaborate index or threads.

Remove unused helpers (`weatherCellId`, the pass-through `deriveAtmosphere`, the test-only whole-data evolution path), unused parameters and duplicated colors/threshold formatting. Preserve the actual ground solver and test it directly.

Generic map code still interprets `weather-grid:`/`weather-cell:` ID prefixes and assumes other Pack areas are Weather influences. Replace this with minimal explicit presentation metadata—layer/category, outline/fill, pickability, symbol and animation—using the existing Pack feature protocol. Do not create a new rendering framework.

## H3: current version, useful functions and reuse

The package range is `^4.4.0`, but `bun.lock` resolves **h3-js 4.5.0**, the current upstream release. Version 4.5.0 adds reversed directed edges and fixes oversized neighbor calls affecting subsequent calls. No upgrade is presently needed. [Official releases](https://github.com/uber/h3-js/releases)

Useful features already available:

- Polygon holes and explicit containment choices. Standard coverage uses cell centers; the experimental API adds full/overlap modes. Evaluate it behind our wrapper, with boundary tests and budgets. It identifies intersecting cells; it does not calculate physical coverage fractions for us. [Region functions](https://h3geo.org/docs/api/regions/)
- Cell compaction and hierarchy for coverage/storage or map detail. Compaction must not merge heterogeneous ground values or temperatures into a fictitious uniform cell. [Hierarchy functions](https://h3geo.org/docs/api/hierarchy/)
- Directed edges, neighbors and per-cell geometry can support future spread or neighborhood calculations. Add wrapper functions only for actual consumers. H3 already has a reusable home in `core/spatial`; extracting another package/service adds no benefit today.

At resolution 8 the average hexagon is approximately **0.737 km²**, with an average edge length of **531 m**. That is regional environmental context, not lane-level road ice or a detailed fire front. Cell areas vary and some cells are pentagons. A physical transport model must use actual geometry, not assume six equal-area neighbors everywhere. [Official cell statistics](https://h3geo.org/docs/core-library/restable/)

H3 provides indexing, not atmospheric or fire physics. For future fire modeling, compare H3 with a local projected raster aligned to terrain/fuel inputs before choosing the solver grid. Packs can sample conditions geographically even when their numerical meshes differ; forcing every Pack onto one mesh would be unnecessary coupling.

## Proposed lean model and organization

Keep a single Weather runtime per Simulation Run, with many independently editable areas/probes. No new Workspace-level weather singleton, and no one-object-per-H3-cell expansion.

1. **Pack configuration:** explicit background atmosphere, initial ground state, simulation grid resolution, and a small set of documented model parameters. Server policy supplies hard work budgets; scenario input cannot increase them arbitrarily.
2. **Weather areas:** stable ID/name, geometry, priority, start time, changed atmospheric quantities, falloff and optional keyframes. A static area needs no one-element keyframe boilerplate in authored JSON. Normalize it during compilation.
3. **Initial ground/interventions:** explicit initial conditions or a scheduled action, not a surface target re-applied on every observation. Removing a rain area stops its forcing; existing wetness/ice remains and evolves. Reset is a separate intentional operation.
4. **Probes:** stable ID/name/location. Same typed sampler as UI, AI and other Packs. Probe deletion also removes its live subscriptions and recording selection, without erasing previously recorded history.
5. **Runtime mechanics:** deterministic atmospheric evaluation plus sparse persistent ground state. Atmosphere at a point is evaluated from baseline/influences; ground is sampled at the configured resolution. This distinction is explicit in every consumer, not three separate competing Weather algorithms.

Suggested files: retain `model.ts`, `scenario.ts`, `pack.ts`, `query.ts`, `projection.ts`; organize pure calculations as `influence.ts` and `surface.ts`, field ownership as `field.ts`, and lifecycle in `sim/adapter.ts` with persistence only where useful. Split the adapter when this clarifies responsibilities, not into a file for every function. A small field-description table can supply quantity names, units, ranges, UI labels and recording descriptors without duplicating an extensible type system.

Use `weather_area` and `weather_probe` consistently across authored and live creation. Retire the old `weather_condition` translation rather than keep aliases. Keep compiled runtime state distinct from authored input; eliminating that boundary would make restart and editing less safe.

## Editor, orchestration and AI

Reuse the existing Scenario Definition and Capability pathways:

- Discover areas/probes, parameters, defaults and constraints from Pack authoring metadata. Add small reusable Pack-settings and repeated-keyframe controls to the editor; do not build a Weather-only JSON editor.
- Support create, inspect, update/move, enable/disable and delete with revision checks. Use explicit typed ground interventions. Generic deletion remains generic; adding Weather must not change unrelated objects.
- Schedule the same real commands through the existing Timeline. Keyframes interpolate an influence continuously; the Timeline handles discrete start/update/stop/intervention actions. Do not add another timer/scripting language.
- Define edits to moving areas explicitly: keep the existing origin, or restart from an explicit new simulation start time. Never infer this from `quality.validAt`.
- Run `world.scenario-authoring.describe` and normal Workspace discovery to find supported authoring operations. Agents already have `workspace_catalog`, `workspace_capabilities` and `workspace_invoke`; no Weather-specific Agents demo tool or hardcoded run ID is needed.
- Extend Weather discovery with quantity meanings/units, supported geometry/resolution, model fidelity, input budgets, current conditions, influence IDs and operation descriptions. Distinguish a permitted operation from an existing Agent grant and from a physically valid action.
- Add a small run summary and optional bounded batch-point sampling. Keep route/area queries only with clear semantics and budgets. Avoid a huge field dump in Agent context.
- Add an optional Weather Historian profile for named probes and compact aggregate diagnostics. Default off; retain authored interventions in the meaningful event journal. Do not record every cell every tick. Persistence of current ground state is required even when historical recording is off.

Workspace/run isolation is already the right boundary. Two runs may select different Weather configurations; an Agent discovers and addresses the intended run. Do not create invisible global weather shared by unrelated Workspaces.

## Ground, roads and other Packs

Today Weather does **not** model road materials, friction, drainage, road salt, runoff or flooding depth. Map roads are rendered geographic context, not mutable road-condition entities. Ambulance motion already consumes canonical route `speedFactor` impacts, but no Weather policy currently supplies them. Grid's `weatherExposure` is descriptive metadata, not active weather-driven failure logic. Drone/Plant mechanics similarly do not consume Weather conditions.

Recommended first real integration: an **optional Ambulance-owned road-weather response policy**. It samples relevant route segments, translates explicit weather/ground quantities into a configured speed limit or stoppage, and publishes the resulting route impacts with cause and sample time. Weather must not know Ambulance IDs or directly mutate vehicles. No implicit rerouting; that remains an explicit command or selected policy.

Expose a narrow, read-only environmental sampling dependency at application assembly/Runtime Hub, backed by the same typed queries. Consumers declare the values they need, not Weather's internal H3 types. Bind explicitly in configuration; fail visibly if a required provider is absent. Keep samples on a coherent committed field revision and batch/cache overlapping routes. Do not add HTTP polling between in-process Packs, a generic expression-binding engine, or cyclic cross-runtime command calls.

Detailed road friction belongs in the consuming mobility/surface model and requires suitable data/calibration. A regional normalized ice value can drive a labeled scenario-grade response, but must not be presented as a validated coefficient of friction. Add terrain/material sampling only with an actual dataset and consumer; ordinary map pixels are not terrain physics.

Future Grid weather response belongs in Grid asset policies; future Plant response belongs in Plant boundary conditions. Weather publishes conditions, each system owns consequences. Deleting an influence removes forcing; deleting a provider or disabling an integration must clear that integration's route effects without clearing unrelated constraints. This deletion/restore behavior needs an integration test.

## Fire: alternatives and decision

| Approach | Benefit | Problem | Decision |
|---|---|---|---|
| Add fire fields/behavior to Weather | Quick visual demonstration | Weather becomes owner of fuel, fire state and firefighting; independent reuse becomes awkward | Reject |
| Generic environmental field engine first | Superficially uniform storage/stepping | Premature solver/plugin framework; weather forcing and combustion differ materially | Defer until a second implemented solver proves shared needs |
| Separate Fire Pack consuming Weather | Independent lifecycle, assets, controls and physics; reusable spatial helpers | Requires a small explicit input boundary and honest mesh/time handling | Recommend |

Fire may use constant authored ambient conditions without Weather, or explicitly bind to Weather. Later smoke/heat feedback must be explicit, bounded and stepped in a defined order—not a recursive call loop. A burning Plant component remains Plant-owned unless deliberately connected to a spatial fire; a map fire should not secretly rewrite Plant internals.

## Implementation sequence and acceptance gates

### 1. Lock down behavior before restructuring

Turn the audit reproductions into failing regression tests. Cover zero-time idempotence, wind-only changes, restore, paused commands, tiny areas, holes, resolution zero and query budgets. Add lifecycle tests for close/reopen, deletion, concurrent read/edit and a headless run. Establish bounded performance fixtures with representative area/cell counts and 1/10/50 readers.

### 2. Correct the state and time model

Unify the sampler, separate initial ground from forcing, introduce explicit influence start time, integrate by simulation time, and use existing runtime persistence. Use the existing ordered mutation/commit boundary; queries must not advance simulation. Surface integration must converge under different outer tick partitions. Report missing/incompatible checkpoints and timer failures visibly.

Acceptance: identical samples through point query/probe/asset inspection at the same location/time; pause/no-op leaves ground unchanged; resume preserves accumulated surface; deletion leaves appropriate residual conditions; all units and timestamps are correct.

### 3. Unify definition, live control and editor

One area/probe schema/constructor path, stricter keyframe validation, explicit baseline/grid settings and complete useful controls. Add the bounded update/enable/intervention commands and reuse them in Timeline. Remove old aliases, unused extensions, ineffective flags and duplicate construction helpers. Validate incompatible edits before mutating live state. Changing grid resolution on a running field is not a cheap property edit: initially require a new run/reset instead of silently resampling history.

Acceptance: save/edit/start/inspect/create/update/delete round trips preserve intended config; an Agent can discover the schema and perform the same operations without hardcoded IDs; invalid edits have no partial effects.

### 4. Bound spatial work and make rendering generic

Fix holes and coverage semantics in the existing H3 wrapper, enforce work budgets before allocation, bound queries, cache stationary geometry and viewport projections, and remove Weather ID-prefix interpretation from generic map code. Keep server state authoritative; changing zoom/layers cannot change physics. Hide or reject unsupported geographic edge cases until tested rather than silently misprojecting dateline/polar ellipses.

Acceptance: a pathological route/resolution cannot monopolize the server; tiny areas have explained behavior; many readers reuse computed projections; map motion/visibility/paused-time behavior remains correct. Record actual timings and maximum observed cell/response sizes instead of claiming unmeasured speedups.

### 5. Complete observation and demonstrate a real consumer

Add quantity descriptions, current summary/diagnostics and optional probe recording using the existing Historian. Implement the small explicit Ambulance road-weather response and a reusable editable example with rain, freezing and clearing. Exercise it through the Agents broker in tests with explicit grants, without a paid model dependency. Do not implement Fire, terrain hydrology or Grid weather failure models in this pass.

Acceptance: changing weather changes real vehicle movement through its configured policy, removing it clears only its effects, independent Packs still work alone, and a second viewer/Agent sees the same state and explanation. Restore and provider-deletion cases must pass as well as the happy path.

## Adversarial review of this proposal

- **Is this just another layer?** No new service/store/bus. Reuse current runtime persistence, typed capabilities and authoring. The sampler replaces competing computations; it is not a wrapper around all three.
- **Does persistence create a second truth?** Persist irreducible field mechanics, not a second editable scenario. Current read responses come from one revisioned field; canonical object summaries remain projections. Explicitly test alignment between restored objects, field checkpoint and simulation time. Do not claim crash atomicity the shared store does not provide.
- **Would an analytic-only model be simpler?** Yes, but it would erase wetness/ice when a weather area moves away. That would discard an important existing behavior. Retain sparse ground memory.
- **Would a fully gridded atmosphere be more uniform?** It would make tiny influences disappear or require high resolution everywhere. Analytic forcing plus gridded ground is a deliberate, documented modeling split, not separate consumer algorithms.
- **Are configuration options becoming a DSL?** Keep fixed typed weather quantities, ordinary keyframe arrays and existing Timeline actions. No arbitrary code, generic units algebra or user-defined solvers. Remove the unconsumed extension registry.
- **Does the integration overgeneralize?** Start with one narrow read-only dependency and one real mobility response. Do not build hypothetical Fire/Grid bindings now. Electrical connections remain a different physical relationship; do not stretch their port contract to carry weather samples.
- **Could optimization change correctness?** Cache only derived immutable geometry/evaluation keyed by actual inputs. Display coarsening cannot change ground state. Never compact different cell values together as if they were equal.
- **Does H3 solve detailed road/fire physics?** No. Keep fidelity claims explicit. Reuse geography without forcing a common numerical mesh.
- **Do we need separate Atmosphere/Ground Packs now?** No. Keep these as internal functional modules. Extract a separate surface model only when another implemented consumer needs independent ownership.
- **Can everything be hot-edited?** Not safely. Areas and policies can be edited through validated commands; solver resolution/topology-changing edits require explicit restart/reset until conservative resampling is implemented and tested.

The resulting design is more consistent and editable, with less duplicated construction, calculation and rendering logic. It adds necessary persistence/validation and a small real integration—not a promise of unlimited scale or physically validated meteorology. Those are the appropriate trade-offs for this stage.

## Verification of the completed removal

- Root type/boundary checks and all three production builds passed.
- Full suite: **2,024 passed, 2 skipped, 0 failed**; additional focused map tests passed after removing the dead Traffic-only area accumulator.
- Supplemental World Svelte check: **49 errors / 1 warning**, versus **50 / 1** before this work. Existing unrelated diagnostics remain; they are not represented as a clean check.
- GitHub CI for `bc3553b2`: successful.
- Production Host, World, Agents, Caddy, OSRM and public HTTPS health: healthy.
- Browser smoke: workspace overview loads, Aviation demo absent, editor lists exactly Ambulance, Drone, Electric Grid, Process Plant and Weather; map tiles visibly render.
- Public reference manifest advertises `grid-norway` only. Existing runs and non-Aviation rooms remain available.
