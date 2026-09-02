# Scenario authoring: audit and cleanup proposal

Date: 2026-09-02. Status: **scenario addition implemented; architectural changes proposed for approval**.

## Outcome and recommendation

The existing **Halden four-unit power complex** now includes Weather as its third ordinary Pack Selection: one local rain/freezing/clearing area, a power-complex ground probe, a northern background probe, and five-second probe recording. All four Plant items, the Grid item, and their four electrical connections are preserved. New runs contain eight Operational Objects. Existing runs retain their own compiled startup and current state.

Weather is observable at the Plants through the existing canonical sampler and asset inspection. There is deliberately **no Weather-to-Plant/Grid physical response** yet: adding environmental context must not secretly change electrical balance, cooling-water temperature, equipment availability or failure rates. Such responses need explicit consumer-owned models, not automatic coupling because Packs coexist.

Keep the current basic model. Clean up the authoring implementation and validation boundaries; do not introduce blueprints, a universal asset graph, a generic environmental runtime, an inheritance language or a second orchestration service.

## What was inspected

World Scenario schema/compiler, Pack authoring catalog, all five Pack contributions and eight item types, model/operating-point selections, editor and map, live creation interfaces, Timeline compilation/execution, revision persistence/seeding, preview/save/start/restore APIs, Host embedding, and the corresponding Agents Room Definition lifecycle. Local reproductions exercised invalid inputs, ordering and revision concurrency. Existing electrical integration tests now run with Weather as well as verifying standalone Plant/Grid operation.

### Inventory and useful boundaries

| Concept | Role | Decision |
|---|---|---|
| Scenario Definition | Reusable authored setup: metadata, initial time, Pack selections, connections, initial view and optional cues | Keep one source format |
| Pack Selection | Owns its configuration and authored items; selects a runtime | Keep; move its recording choice here rather than a parallel Pack-id list |
| Scenario Item | Pack-owned authored asset or influence; not necessarily one Operational Object | Keep; do not make containment imply runtime dependency |
| Model / Operating Point / Automation | Topology and parameters / initial operating values / ongoing behavior | Keep where meaningful, notably Plant/Grid; do not impose on Weather or Ambulance |
| Weather keyframes | Interpolation of one area's local atmospheric input and geometry | Keep Pack-owned; not duplicate discrete Timeline cues |
| Scenario Timeline | Discrete actions at simulation times | Keep, but remove precompiled full-object mutation actions |
| Electrical connection | Explicit continuous power-exchange relationship | Keep typed and explicit; not a universal connection type |
| Runtime query dependency | Consumer reads another Pack's current conditions | Keep distinct from an electrical connection; no fake conservation ports for weather |
| Starting View | Initial map framing and meaningful initial visibility preferences | Keep compact; derive screen composition and put rail width in client preferences |
| Compiled Scenario | Validated, resolved startup artifact retained for a Run | Keep separate from source and current runtime state |
| Revision store | Immutable definitions and optimistic concurrency | Keep existing store; correct ownership of its mutation queue |

The outline can remain a tree, **Scenario → Packs → Items → local records**, while electrical links and targets are explicit references across it. There is no need for a new tree document format, inherited settings, branch injection protocol or hidden sibling creation.

### Current editor coverage

Counts exclude common name/map placement controls. All eight item types currently use point placement; no production authoring contribution uses `linkedConfig`, route placement or polygon placement.

| Pack | Pack config fields | Item controls | Important omissions/mismatches |
|---|---:|---|---|
| Ambulance | 6 | Ambulance 0; Hospital 2; Incident 2 | Destination/at-object references, equipment and initial operational choices are not editable |
| Drone | 0 | Drone 3 | Configurable models, capacity/step settings and swarm data exist outside the form; altitude UI limits differ from schema |
| Electric Grid | 0, intentionally empty config | Grid 6 | Model choices are discovered, but compatible operating-point filtering is not applied; deep topology is not a form editor |
| Process Plant | 0, intentionally empty config | Plant 1 | Only loop count is editable; selected Model/Operating Point/Automation and their overrides are largely hidden |
| Weather | 15 | Area 14 + one repeated keyframe collection; Probe 0 | No ellipse footprint in editor; optional/inherited quantities cannot be cleared cleanly; repeated-record behavior assumes Weather interpolation |

Sources: [authoring catalog](../../apps/world/src/core/scenarios/authoring.ts), [Pack protocol](../../apps/world/src/core/packs/protocol.ts), [editor](../../apps/world/src/ui/routes/ScenarioBuilderRoute.svelte), [map](../../apps/world/src/ui/ScenarioBuilderMap.svelte).

## Findings

### 1. Validation is split across save, start and eventual action execution

Reproductions against `compileScenarioSource` accepted all of these:

- A nonexistent selected runtime.
- A nonexistent recording profile.
- A nonexistent scheduled Capability.
- A Timeline-created Ambulance incident when only Weather is selected.
- An incident update at second 10 whose target is created at second 20, provided creation appears first in the authored array.

Create/update save calls use this compiler before persisting. Runtime selection/profile checks are deferred to the runtime resolver; command availability, input schemas and schedulability are checked when a cue fires. Thus “saved” does not consistently mean “structurally executable.” Runtime checks must remain for changing conditions, but known invalid configuration should fail before saving.

Core `context` is another mismatch: the outer Scenario Item schema accepts it, but a valid `{ schemaVersion: 1 }` context is rejected as an unknown key by the strict Plant item schema. The intended post-expansion attachment is never reached. Core-owned context should be validated and separated before the Pack parses its own fields; weakening Pack strictness is not the fix.

Sources: [compiler](../../apps/world/src/core/scenarios/config.ts), [runtime resolver](../../apps/world/src/core/scenarios/runtime-resolver.ts), [save/preview registry](../../apps/world/src/core/simulation-runs/registry.ts), [Capability API](../../apps/world/src/core/api/workspace-module-api.ts).

### 2. The old Timeline mutation path is a second write model

`create_object`/`update_object` expand at compile time into complete `upsert_object` snapshots. They use the compiler's object map, not the live object at execution time. An update can therefore overwrite unrelated progress, and creation has a special one-object restriction despite the normal Item codec permitting multiple objects.

Compilation follows authored cue-array order; catch-up execution sorts by time and ID, while timer registration follows array order. These need one defined ordering. Removing the old full-object mutation path is cleaner than patching each stale-field case.

Weather has a related metadata problem: every command is marked schedulable, including full replacement requiring an exact future `expectedRevision`. That is not a generally useful scheduled operation. Keep compare-and-set protection; do not add a privileged scheduler bypass or a future-revision expression language.

Use live validated commands for runtime mutations. Preserve discrete guidance/highlight actions and genuine interaction signals. Weather curves remain local interpolation, and process-plant transient profiles remain Pack-owned numerical behavior; neither should become hundreds of scheduled commands.

Sources: [compiler actions](../../apps/world/src/core/scenarios/config.ts), [Timeline runner](../../apps/world/src/core/simulation-runs/timeline-runner.ts), [runtime execution](../../apps/world/src/core/simulation-runs/runtime.ts), [Weather capabilities](../../apps/world/src/packs/weather/sim/adapter.ts).

### 3. A named Operating Point does not mean what its label says

`process-plant.pwr.full-power` currently supplies no initial overrides unless the author supplies them. Compiling its default selection yields core `initialPowerFraction = 0.85` and turbine `initialLoadFraction = 0.85`, inherited from the reference graph.

Halden explicitly writes both values as 1 for every Plant. **Those repetitions are presently functional, not removable noise.** Fix the named Operating Point's owned defaults first, test equivalent Halden initialization, then remove redundant scenario overrides. Keep sparse overrides for genuine per-unit differences. Expose model-specific parameter schemas and compatible selections from the Pack's existing definition catalog instead of duplicating them in UI hints and handwritten JSON Schema.

Sources: [Plant definition resolver](../../apps/world/src/packs/process-plant/plant-definitions.ts), [Plant compiler](../../apps/world/src/packs/process-plant/plant-compiler.ts), [reference graph](../../apps/world/src/packs/process-plant/specs/pwr-reference-template.graph.json).

### 4. Discovery works, but the editor still contains abandoned/generalized machinery

- `linkedConfig`, reference-id allocation and linked-record deletion have **no current Pack consumer**. Remove them, then remove the redundant field `target` discriminator; fields are already scoped by the selected config/item/record.
- Defaults are repeated in Pack schema defaults, `defaultItem`, and every control. Numeric ranges and select options are also partially duplicated. Server validation currently checks that copies match rather than removing copies.
- Repeated records are nominally generic but UI labels say “Change,” values inherit previous siblings and the parent, and a new row starts from the parent with a constant 300-second default. A second new row can duplicate the first time; a row appended after second 600 can be earlier than its predecessor. Preserve sparse keyframes with explicit inheritance/reset semantics; do not apply Weather inheritance to every future array.
- The browser manually shadows the Scenario and preview types and trusts cast response bodies. Source schema, metadata schema and draft-editing concerns should be separate, browser-safe modules with validated API boundaries. A temporarily incomplete draft is legitimate; it should not require inventing a second persisted domain model.

Keep a small explicit field renderer with a single seed document and presentation hints. Derive straightforward types/limits/enums from the owning schema; resolve actual selected-reference defaults server-side. Do not attempt a general JSON-Schema-to-application generator for every union or component graph.

### 5. Starting View still expands into obsolete screen composition

The source has a compact `view`, but compilation creates four fixed `SurfaceDefinition` regions, followed by another set of types, validators and UI selectors. There is no actual choice of composition here. The code also calls the compiled artifact `ScenarioDefinition` and the real Definition `ScenarioSource`, contradicting the glossary.

Map layer names are hardcoded in both source/compiled schemas and the empty-draft factory. Adding Weather to an existing scenario requires also adding `weather` to its saved layer list. The editor updates rail sections when adding a Pack but does not add its map layer. Rail updates reset existing visibility/collapse/field preferences wholesale. Prefer discovered defaults with sparse explicit overrides, so an omitted new layer/category becomes visible without overriding an explicitly hidden one.

The editor renders everything as a point—even an atmospheric ellipse—and its unused route/polygon branches do not provide a real geometry editor. Reuse Pack-owned static geometry projection for a bounded GeoJSON draft preview; show Weather's actual footprint and existing Plant/Grid anchors. Do not run physics to preview geometry or build a new rendering framework.

Sources: [source/view compiler](../../apps/world/src/core/scenarios/config.ts), [compiled model](../../apps/world/src/core/model/scenario.ts), [surface selectors](../../apps/world/src/ui/surface.ts), [draft factory](../../apps/world/src/ui/scenario-builder-model.ts).

### 6. Editor behavior and preview costs need targeted work, not a worker farm

The entire draft is serialized and fully recompiled after a 250 ms debounce, including title, description and map framing edits. Plant compilation already has a bounded compiled-graph cache; do not add another cache blindly. In a local warm Bun run, twelve four-Plant/Grid/Weather compiles took roughly **12–20 ms each**; the complete five-Pack authoring catalog was **41,743 JSON characters**. This is not currently a catastrophic bottleneck. It is unnecessary repeated work and can involve routing I/O for other scenarios.

Key preview requests by structural inputs, keep one in-flight request plus the newest pending draft, ignore obsolete responses, and avoid triggering topology compilation for header/view edits. Use bounded caching only where measurement justifies it. Save still performs authoritative validation. Bound item/cue/geometry work before expensive expansion; no universal asset-count limit should pretend to fit both a Drone and a Plant.

Also fix:

- Old preview errors can temporarily block saving a newly corrected draft.
- Pending placement cancellation leaves an unplaced item; this should be an explicit incomplete item or cancellation should remove the newly created draft item.
- Save hides the editor behind a success page. If “Save & start” then fails, the saved state hides the failure/retry path. Keep editing, show saved revision, and expose a separate retryable launch action.
- Closing the embedded editor discards unsaved work without a dirty-state warning.
- Removing an item/Pack cleans electrical links but not Timeline references, Ambulance targets or other references. Report exact dangling references; do not silently delete behavior.
- There is no Timeline editor or general reference picker. Add a basic cue list and typed asset/reference selectors, not drag-and-drop workflow design.

### 7. Revision ownership is sound in World, inconsistent in Agents

Both Modules already share the immutable definition store and the correct separation of definitions from running resources. World retains an exact compiled startup artifact and verifies its digest when restoring a Run; **do not remove this** or recompile source on restore. Recompiling a source for a new Run still depends on current Pack/reference/routing inputs; an immutable source is not a promise of immutable external dependencies.

World keeps one Scenario Library per Workspace. Agents constructs fresh Room Definition libraries in API handlers. Each underlying revision store owns a different in-memory mutation queue for the same files. An isolated two-store reproduction with two writes against the same expected revision returned **success for both**, with only one title current afterward. This defeats intended compare-and-set behavior and repeats seeding work.

Give each Agents Workspace one owned Room Definition library and use it from every handler. Test two simultaneous edits through actual APIs. No database, distributed lock service or generic new repository layer is warranted for the present one-process owner.

Agents create/update validates document shape, but Pack/tool checks happen at launch and script references can fail only on deck activation. Apply the same early semantic validation principle; published write output schemas should describe actual results, not merely `{ type: 'object' }`. Keep Room Definitions, prompt decks and scripts domain-specific. The Host's existing Edit button already follows a Definition's `uiPath`; its creation card, iframe label and saved message are World-specific and can become descriptor-driven when an Agents editor is actually added, not before.

Sources: [revision store](../../packages/module-runtime/src/revision-store.ts), [World registry](../../apps/world/src/core/simulation-runs/registry.ts), [Agents library](../../apps/agents/src/core/definitions/room-definition-library.ts), [Agents API](../../apps/agents/src/api/workspace-module-api.ts), [Room startup](../../apps/agents/src/core/definitions/room-definition-service.ts).

### 8. Live verification exposed inconsistent clock meanings

In the same running Halden scenario, Weather objects reported `timestamps.updatedAt` in the authored simulation epoch (2026-01-01), while Plant/Grid objects reported wall time (2026-09-02). Weather also uses simulation time for spatial `observedAt`. The shared Object timestamp schema does not distinguish these meanings. This risks misleading cross-Pack recency comparisons and Agent interpretation; it does not establish that the solvers themselves are using different elapsed times.

Define one meaning for shared observation/update timestamps and keep simulation time explicit in samples, cues and physical state. Weather recording already separates `observedAt` and `simulationTime`; reuse that convention instead of inventing another clock abstraction. Test an authored epoch far from wall time, pause, speed changes and restore. Audit event timestamps alongside object projections before changing either, so ordering and history remain coherent.

Sources: [Weather projection](../../apps/world/src/packs/weather/sim/adapter.ts), [Plant projection calls](../../apps/world/src/packs/process-plant/sim/adapter.ts), [Grid projection](../../apps/world/src/packs/electric-grid/sim/object-projection.ts), [shared Object timestamps](../../apps/world/src/core/model/object.ts).

## Integrated implementation plan for approval

1. **Fix semantic validation, clock meanings and concurrent writes.** One reusable validation path for preview/save/start, including selected runtimes, recordings, available/schedulable commands, core context and known references. Retain live readiness checks. Return field/item/cue paths with input errors. Standardize shared observation/update timestamps while keeping simulation time explicit. Give Agents one library per Workspace; test real concurrent revision conflicts.
2. **Delete unused authoring layers and clarify names.** Remove `linkedConfig` and redundant targets; remove unused route/polygon editor branches without deleting Pack geometry types; centralize defaults; split browser-safe authored schemas from compilation; rename authored `ScenarioSource` to `ScenarioDefinition` and the current compiled type to `CompiledScenario`. Keep small draft helpers for deliberately incomplete edits. No compatibility aliases.
3. **Simplify configuration ownership and initial presentation.** Move recording under Pack Selection; keep connections at Scenario level. Remove fixed Surface-region scaffolding and rail-width persistence. Discover layer/category defaults and preserve only deliberate starting-visibility overrides. Do not force Pack-specific placement names or internal solver configuration into a universal asset schema.
4. **Unify discrete action execution.** Replace old compile-time create/update snapshots and Pack mutation codecs with supported live Capability commands; mark safe operations schedulable explicitly. Use one cue ordering and no stale-state overwrite. Where an existing live creation schema differs from authored items, reuse a Pack-owned constructor/codec rather than creating another mutation engine. Add missing real narrow operations before removing behavior that tests still cover.
5. **Make existing content honestly editable.** Correct the Full-power Operating Point and then simplify Halden's overrides. Expose selected Model/Operating Point/Automation and compatible controls, important Ambulance references, useful Drone config, optional/reset Weather values and valid keyframe append behavior. Add duplicate-item and basic Timeline editing. Provide lossless advanced editing of unsupported document sections with schema validation; do not claim every graph has a bespoke form.
6. **Tighten the editor lifecycle and preview.** Structural preview scheduling, clear validation freshness, save-and-continue, explicit launch retry, dirty-close guard, incomplete-placement handling, reference diagnostics and static Pack-owned geometry previews. Extract testable draft operations and request-state logic from the 636-line route; avoid arbitrary component fragmentation.
7. **Verification and cleanup.** Round-trip both bundled scenarios and every Pack item; preserve sections not touched by form edits; test alternate Grid models, custom Drone models, context, unknown dependencies, removal, Timeline order/live edits, stale preview responses, failed launch after successful save, concurrent writers, fresh/restore runs, Agents discovery and real Plant/Grid/Weather operation. Measure preview and query costs again. Delete superseded schemas/helpers/tests and update guardrails/glossary references, then deploy.

## Adversarial review and limits

- **Are we over-unifying?** A Pack item, a Plant model component, a Grid bus and an Agents message are not interchangeable assets. Shared orchestration contracts and a small form renderer are enough. Keep runtime ownership and physics separate.
- **Is every layer redundant?** No: authored definition, compiled startup and current live state serve different purposes. Remove the fixed screen-region wrapper and duplicate authoring metadata, not the compilation/persistence boundaries.
- **Would a universal form generator be cleaner?** It would turn unions, references, inheritance and geometry into a new language. Keep primitive fields, ordinary records and explicit reference controls; allow validated advanced editing where necessary.
- **Could changing defaults alter physics?** Yes. The 85% “Full power” mismatch proves it. Compare resulting Plant initial states before removing overrides; retain the existing Halden behavior as an acceptance test.
- **Should Weather automatically affect Plants/Grid?** No. Sampling is not an equipment-response model. No hidden electrical failures or copied weather state in each Plant.
- **Should we merge Weather curves and Timeline?** No. Interpolation and discrete state transitions are different. They share simulation time and validated actions, not one universal scheduler/solver.
- **Will one validator remove all runtime errors?** No. Assets can be deleted, revisions change and providers fail after saving. Validate static consistency early and current preconditions at execution; report both clearly.
- **Do we need caching, threads or a database now?** Not based on measured preview costs. Remove repeated work and enforce ownership/budgets first; preserve existing caches and persistence where useful.
- **Is independence preserved?** Yes. Plant/Grid work without Weather; Weather works without Plant/Grid; Agents sees only discovered and granted Module capabilities. The UI outline is not a dependency tree.
- **Breaking changes?** The proposed schema/action cleanup is intentionally breaking, with no aliases or automatic conversion. Existing saved runs/definitions may require recreation if their retained shapes are removed. Do not silently rewrite or delete them. This turn's additive scenario change does not require that break.

Approval is requested for these seven phases, not for a new platform architecture. The scenario addition itself is complete.

## Verification of the deployed scenario addition

- Release `20260902T195834Z-188b5ee159-2714e31cce`, application commit `188b5ee1`; public health check passed.
- Release test suites: **2,034 passed, 2 skipped, 0 failed**. Checks and production builds passed. [GitHub CI](https://github.com/michaelhil/leitbild/actions/runs/33676404156) passed.
- Production browser: existing Halden card has the updated description; its editor discovers four Plants, one Grid, three Weather items, both Weather keyframes, and all four electrical connections. The editor was closed without changes.
- Read-only inspection of a live updated Halden Run confirmed eight objects and all three runtimes ready with zero recorded runtime failures. Existing runs were not changed or deleted during verification.
- Integration tests cover Weather sampling alongside the real electrical connection, Plant trip/deletion behavior, unchanged initial Plant/Grid configuration, and operation without Weather.

The architectural findings above are documented and reproduced, not silently implemented by this release.
