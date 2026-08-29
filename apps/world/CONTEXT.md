# Leitbild

Leitbild is a platform for shared, map-based control-center work over moving and spatial operational objects.

## Language

**World Module**:
The composable Workspace Module that owns Scenarios, Simulation Runs, operational state, and simulation mechanics.
_Avoid_: Leitbild instance, control instance, or treating the application Deployment as Workspace identity

**Simulation Run**:
A persistent execution of exactly one immutable Scenario Revision inside one Workspace, addressable by its own opaque id and URL.
_Avoid_: Scenario Run, Session, Simulation Instance, or encoding the Scenario id into the Run id

**Pack**:
A user-facing and architectural capability module that contributes pack-owned behavior, object types, runtimes, presentation, queries, interactions, and documentation to Leitbild.
_Avoid_: Domain, Plugin, Provider, Simulation Pack, Scenario Pack, UI Pack, Asset Pack

**Pack Descriptor**:
Versioned metadata that declares a Leitbild Pack's identity, compatibility, dependencies, and contribution kinds; typed Leitbild contribution implementations remain application-owned.
_Avoid_: treating the shared descriptor as a universal Pack runtime interface

**Pack Data**:
Pack-owned operational payload attached to an Operational Object.
_Avoid_: dense runtime internals, high-frequency traces, solver matrices, private mechanics, or perspective-bearing context

**Operational Object**:
A shared control-center entity with independent operational identity, state, visibility, or command relevance.
_Avoid_: automatically promoting internal engineering graph nodes, solver variables, matrix entries, measurements, or protection internals to objects

**Pack Runtime**:
The active implementation backing one pack inside a Simulation Run.
_Avoid_: Simulation Provider, Simulation Instance, Provider, Domain Runtime, Simulator as the canonical noun

**Composite Pack Runtime**:
A pack runtime that combines multiple internal sources or mechanics while remaining the single active runtime for its pack in a Simulation Run.
_Avoid_: activating multiple runtimes for one pack in the same Simulation Run

**Source**:
An external, reference, map, route, code, or live-feed input consumed by a pack runtime or UI surface.
_Avoid_: using source for pack ownership, canonical state, or runtime identity

**Runtime Hub**:
A simulation-run-local coordinator that connects multiple pack runtimes, merges their runtime snapshots, routes commands to runtimes that accept them, routes pack queries to the active runtime for that pack, forwards runtime emissions, and broadcasts committed Simulation Run events back to runtimes.
_Avoid_: Simulation Hub, or putting multi-runtime orchestration inside one pack runtime

**Runtime-Private State**:
Pack-runtime-internal state used for specialist mechanics, such as route following, sensor models, traffic queues, timers, process variables, or high-resolution internal entities.
_Avoid_: exposing runtime-private state directly as canonical API/UI/AI state

**Runtime Projection**:
A runtime-local read model of committed Simulation Run state that helps a pack runtime continue its mechanics.
_Avoid_: calling this the object store or source of truth

**Pack Query**:
A read-only, pack-scoped request routed through the Simulation Run API and Runtime Hub to the active runtime for that pack.
_Avoid_: hardcoded pack-specific HTTP routes, arbitrary RPC, mutating state through query handlers, or treating query results as a second canonical state store

**Client**:
One connected browser tab, API integration, AI process, or display surface connected to a simulation run.
_Avoid_: Session when referring to a connected browser tab or API connection

**Actor**:
A human, AI agent, or system identity that can observe or act within a simulation run.
_Avoid_: Participant, User when referring to operational identity inside a simulation run

**Surface**:
A functional UI mode presented by a client.
_Avoid_: View when referring to a pack-level UI mode

**Surface Definition**:
Scenario-owned UI assembly contract that declares which safe UI primitives a client should render, such as map, object rail, footer, and guidance overlay. It is validated data, not executable UI code.
_Avoid_: hardcoded background UI, browser-only layout defaults, or generated component code as scenario truth

**Surface Primitive**:
A built-in, reviewed UI capability that a Surface Definition may instantiate with configuration. V1 primitives are `map`, `objectRail`, `systemFooter`, and `guidanceOverlay`.
_Avoid_: Plugin when referring to a built-in UI primitive

**Surface Region**:
One configured instance of a Surface Primitive inside a Surface Definition. V1 permits at most one visible region per primitive.
_Avoid_: Pane or Widget when referring to scenario-level assembly configuration

**Object Context**:
Structured, perspective-bearing artificial situation awareness attached to an operational object. It records facts, activity, references, and summaries from an asset, operator, system, or AI perspective.
_Avoid_: using context as an untyped junk drawer, or using it for pack-owned operational truth that belongs in `packData`

**Scenario**:
A reusable Workspace-owned identity whose simulation setup evolves through immutable Scenario Revisions.
_Avoid_: Simulation Run, built-in Scenario Config, or mutating a Revision in place

**Scenario Revision**:
An immutable, validated startup definition containing world settings, selected Packs, runtime configuration, initial objects, contexts, surfaces, and optional scripts.
_Avoid_: mutable Scenario Definition, resolving a restored Run from the current catalog

**Scenario Config**:
Compact deployment-owned JSON authoring format for a built-in Scenario template. Pack scenario codecs expand it into a candidate Scenario Revision before it enters a Workspace.
_Avoid_: treating config specs as Run truth or putting arbitrary executable code in scenario files

**Pack Scenario Codec**:
Pack-owned expansion surface that converts compact scenario object specs and scenario operations into validated operational objects.
_Avoid_: scenario files hand-building full pack objects with reusable helper code

**Scenario Library**:
The Workspace-owned collection of Scenarios and immutable Scenario Revisions available for new Simulation Runs.
_Avoid_: global mutable Scenario Catalog, hidden pack seed factories, or hardcoded default runtime boot paths

**Scenario Script**:
A small declarative, time-based action list attached to a Scenario Revision.
_Avoid_: arbitrary script execution, browser-only tutorial state, or hidden runtime seed timers

**Scenario Guidance**:
Canonical scenario-owned UI instruction state for onboarding, tutorial prompts, and scripted scenario briefings. It is stored in Simulation Run projected state so all clients and reloads see the same current guidance.
_Avoid_: local-only popovers for scenario-critical information

**Mission Definition**:
Operational intent layered on top of a scenario: goals, objectives, tasks, stages, triggers, actions, and evaluation metrics.
_Avoid_: Scenario when referring to objective/task progression

**Mission Progress State**:
Runtime execution state for a mission definition, including active stages, objective/task statuses, fired triggers, and timestamps.
_Avoid_: storing runtime progress inside the reusable Mission Definition

**Agent Context View**:
A bounded, derived, LLM-friendly view assembled from object state, object context, mission/task state, and relevant nearby objects.
_Avoid_: persisting generated prompt text or full event logs as canonical object state

**Interaction Signal**:
A scoped claim, observation, or interaction attempt emitted by a pack runtime, actor, AI agent, client, or system process inside a simulation run.
_Avoid_: treating a signal payload as accepted truth, or letting one object directly mutate another object

**Interaction Handler**:
A deterministic, registered function contributed by core or an active pack that inspects an interaction signal plus the current simulation-run snapshot and returns proposed effects. Handlers do not mutate state directly.
_Avoid_: callback-style object behavior, hidden side effects, or long-lived handler-local memory

**Interaction Effect**:
A constrained proposed result of handling a signal, such as upserting an object, deleting an object, or emitting an operational notification.
_Avoid_: arbitrary imperative code paths that bypass event ordering, validation, audit, or replay

**Simulation Run Event**:
An accepted event emitted through the Simulation Run runtime for ordering, projection, live feed delivery, and optional durable retention.
_Avoid_: using event to imply every live update must be durable history

**Operational Notification**:
A durable attention item emitted from interaction handling or system logic for operators, AI agents, replay, and debugging. A notification is not a substitute for canonical object state.
_Avoid_: UI-only toasts for information that should be visible to AI agents, event history, or replay

**Operational Demand Signal**:
A generic interaction signal declaring that some capability is needed at a location, such as `medical.transport`. It carries demand id, capability, source object, point location, quantity, severity, title, and description. Responder packs decide whether they can satisfy the demand; V1 ambulance handles `medical.transport` by creating an incident target idempotently.
_Avoid_: hardcoding cross-pack requests from one pack directly into another pack, or making every requesting object pretend to be an ambulance incident

**Traffic Condition**:
An aggregate traffic object describing congestion, closure, slowdown, or access restriction over a road segment or area.
_Avoid_: modeling every traffic need as individual cars before aggregate traffic effects are proven insufficient

**Route Impact**:
Canonical route-awareness state describing how another object or condition affects a moving object's planned route, ETA, or movement assumptions.
_Avoid_: hiding route impact only inside runtime-private state

**Vector Map Artifact**:
The self-hosted PMTiles archive containing MVT vector tiles used as Leitbild's base map context.
_Avoid_: Raster Tile, OSM PNG Tile, or treating the map artifact as operational truth

**Map Capability Manifest**:
The machine-readable contract describing available vector tile layers, fields, geometry, intended use, and schema version.
_Avoid_: relying on prose docs or hard-coded tile assumptions inside pack runtimes

**Spatial Field Index**:
A generic, globally stable cell index used by packs that need field-like spatial state, such as weather, wildfire, radiation, or population exposure. V1 wraps H3 in `src/core/spatial/*`; pack code uses the wrapper and never imports `h3-js` directly. The wrapper exposes branded cell ids, validated resolutions, point-to-cell lookup, polygon coverage, cell boundaries, centers, parents, and neighbor rings.
_Avoid_: pack-specific grid implementations in UI modules, direct H3 imports outside the wrapper, or treating visual cells as operational objects

**Weather Sparse Field**:
The weather pack's materialized subset of the global H3 spatial field.
_Avoid_: computing weather truth only for the viewport, making weather cells canonical Leitbild operational objects, or exposing weather internals through generic UI code

**Process Plant Runtime**:
The process-plant pack's Pack Runtime for compiled process systems.
_Avoid_: modeling continuous process physics as object-to-object events, process-specific HTTP endpoint families, or treating process variables as operational objects

**Process Plant Operational Projection**:
The small Leitbild-facing object projection for one process system. It is an operational facility object with map position, rail category, status tone, summary, and selected fields derived from the process-plant runtime and I&C lifecycle state. The process runtime and variable table remain the source of truth; the projection is a shared operational facade for map/rail awareness.
_Avoid_: exposing every process variable as an operational object, or treating the projection as a second process state store

**Process Variable Table**:
The single authoritative in-memory store for compiled process variables inside one process plant runtime. Component and process-link behavior modules read and write through this table; they do not maintain duplicate state maps.
_Avoid_: shadow variable stores in solver behavior, command handling outside writability/type validation, or copying plant state into operational objects

**Process Variable**:
A stable, unit-bearing value path inside a compiled process system, such as `core.powerMw` or `sgA.pressureMPa`.
_Avoid_: free-text units, ad hoc telemetry object fields, or mutable untyped variable bags

**Process Signal Binding**:
Graph-owned metadata that makes a process variable discoverable and usable by operators, procedures, AI agents, and control-room surfaces. A binding may declare `tagId`, `equipmentId`, `description`, `externalRefs`, capability overrides, and limits, but the authoritative identity remains `{simulationRunId, systemId, variablePath}`.
_Avoid_: separate runtime binding catalogs, duplicate sensor/actuator ids, or tag lookup without an explicit process system id

**Process Variable Capability**:
Compiled metadata that states whether a variable is readable, writable, trendable, alarmable, operator-facing, AI-visible, or procedure-relevant. Defaults are derived from `writable`, `publish`, and `tagId`; graph metadata may only override them when there is an operational reason.
_Avoid_: decorative capability flags with no consumer, hidden procedure tags, or separate capability catalogs

**Process Variable Limits**:
Optional descriptor metadata for normal, operating, hard, and alarm ranges. `hardRange` is enforcement data and rejects invalid runtime writes; normal, operating, and alarm limits are interpretation data for UI, AI agents, procedures, and future alarm/protection logic.
_Avoid_: arbitrary hard limits on generic flow or inventory variables where the component design does not define a real bound

**Process Tag Id**:
A procedure-facing identifier such as `PT-455` or `SG-A-LVL-NR` attached to exactly one process variable inside one compiled process system. Tags are allowed to repeat across different process systems because every query and command includes `systemId`.
_Avoid_: fleet-wide tag assumptions, implicit current-unit lookup, or treating tags as separate runtime variables

**Process Control/Protection Rule**:
A typed, declarative, deterministic rule owned by the `process-plant` pack. It reads process signal values, applies comparison/logical/voting/delay/latch logic, and emits alarm/trip signals or queues validated variable writes at solver phase boundaries.
_Avoid_: arbitrary expression languages, generated code, mid-solver mutation, or continuous physics over the interaction event bus

**Process I&C Substrate**:
The pack-owned instrumentation-and-control layer that sits above continuous physics. It reads the authoritative variable table through signal bindings, evaluates normal controllers, protection functions, alarms, permissives, and interlocks, and emits validated actions. It is not a second solver and not an emergency procedure engine.
_Avoid_: hiding physics inside alarms, embedding procedure logic inside process-plant, or letting I&C code mutate variables outside the validated write path

**Annunciator Metadata**:
Structured metadata attached to alarm/trip lifecycle state: system, equipment, group, first-out group, priority, and role. It helps UI surfaces and AI agents group and explain I&C state without parsing human alarm text.
_Avoid_: prose-only grouping, UI-local alarm catalogs, or duplicating alarm truth outside the pack lifecycle state

**Mode Condition**:
An optional I&C rule qualifier expressed with the same typed condition language as the main rule condition. It lets a rule apply only in a process state such as power operation or post-trip state without creating a separate global mode store.
_Avoid_: hidden plant-mode variables, fleet-wide mode assumptions, or rule branches implemented as arbitrary scripts

**Instrumentation Signal**:
A process signal used as an indication, control input, alarm input, procedure input, or AI-visible observation. Signals resolve to variables; they do not own state separate from the variable table.
_Avoid_: separate sensor stores, duplicate tag mappings, or treating tags as globally unique

**Normal Controller**:
Automatic routine control logic such as pressure control, level control, pump speed control, or valve positioning. Controllers may write only through the validated queued-write mechanism and should be overrideable/observable where the graph exposes the relevant writable signals.
_Avoid_: mixing normal control with protection trips, mid-solver writes, or hidden actuator state

**Protection Function**:
Safety-like automatic logic that detects a protective condition and requests constrained actions such as trip, isolation, relief, or safeguard actuation. Protection functions may latch and may be harder to reset than normal controllers, but they still use the same signal references and validated write path.
_Avoid_: arbitrary scripts, fleet-wide assumptions, or direct variable mutation

**Alarm State**:
Persistent operator/AI-facing state derived from a condition. Alarm events record transitions, while alarm state records current truth such as active, acknowledged, cleared, latched, suppressed, shelved, phase, severity, first-active time, first-out state, and source rule.
_Avoid_: representing alarms only as transient events, clearing alarms by acknowledgement alone, or duplicating alarm truth in UI-local state

**Alarm Clear Condition**:
Optional typed I&C condition that explicitly defines when an alarm may clear. It can be paired with `clearDelayMs` so noisy values do not chatter around a threshold. If absent, non-latched alarms clear when their set condition is no longer true.
_Avoid_: using acknowledgement as a clear condition, clearing alarms from UI state, or hardcoding alarm hysteresis outside the rule definition

**I&C Lifecycle History**:
A bounded pack-owned transition history for alarm/trip lifecycle changes such as entered, cleared, acknowledged, shelved, unshelved, reset, and first-out. Entries may carry actor, client, and reason provenance and back the alarm query/API surface.
_Avoid_: treating history as continuous process telemetry, a procedure log, or a second source of alarm truth

**I&C Lifecycle Action**:
An explicit command-side action on alarm/trip lifecycle state: acknowledge, reset, suppress, unsuppress, shelve, or unshelve. Lifecycle actions affect operator/AI-facing lifecycle state only; they do not change process variables, execute procedures, or bypass I&C rule evaluation.
_Avoid_: using lifecycle actions as procedure steps, physics commands, or hidden alarm-condition overrides

**Permissive**:
A condition that must be true before a command or automatic action is allowed to proceed. A failed permissive blocks the action and should explain why.
_Avoid_: silent command rejection or burying command preconditions inside component behavior

**Interlock**:
A condition that prevents, forces, or constrains an equipment state to protect the modeled system or preserve operating logic. Interlocks are part of I&C semantics, not component physics.
_Avoid_: making interlocks invisible side effects inside pump, valve, or breaker components

**Process Link**:
A typed connection between process plant components. A process link may be a simple topology link, or it may own optional physical metadata and link-local process variables such as flow, pressure, radiation, or leak area.
_Avoid_: making every simple sensor or leak into a separate component when it only modifies or observes one connection; use `processValve` or `steamValve` when the graph needs valve position, stroke timing, automatic opening, controller behavior, or valve diagnostics

**Process Link Solver Model**:
The validated fluid-link contract declared by `solverModel`, `nominalFluid`, and `designPhase`. It tells the process-plant compiler which state surfaces the link must expose before runtime starts, such as flow, temperature, pressure, pressure drop, or leak variables.
_Avoid_: treating `solverModel` as a prose label, adding silent fallback variables, or introducing a new solver model without graph validation and tests

**Canonical RCS Pressure**:
In the current built-in PWR graph, `pressurizer.pressureMPa` is the canonical reactor coolant system pressure. Reactor-vessel primary inventory can bias this pressure, and primary-coolant links can publish propagated `pressureMPa`, but those link pressures are read-outs, not independent pressure truths.
_Avoid_: adding a second canonical primary pressure variable without an explicit ADR

**Solver Phase**:
One ordered pass in a continuous process simulation tick, such as applying commands, solving electrical behavior, solving component/link fluid flow, solving heat transfer, or updating component and link state.
_Avoid_: hidden update ordering inside component callbacks or continuous physics over the interaction event bus

**Process Plant Behavior Context**:
The constrained execution surface given to one process-plant component or process-link behavior during one solver phase. Behavior definitions declare audit-facing read dependencies and write outputs. The context can read declared process variables and write only the behavior's declared output variables.
_Avoid_: giving behavior modules unrestricted variable-table mutation access, hidden shadow state, or arbitrary scenario-authored equations in V1

**Process Plant Acceptance Trace**:
A headless evidence run that compiles the real process-plant graphRef, applies representative scheduled transients, records selected telemetry, and fails on high-level trend regressions. It is an engineering guardrail for physics changes, not a second simulator or a UI demo.
_Avoid_: physics changes that only pass isolated variable assertions, diagnostic traces that bypass the real runtime, or acceptance plots with untested expectations

**Map Context Layer**:
A vector tile layer that provides environmental or infrastructure context such as roads, POIs, water, buildings, land use, or boundaries.
_Avoid_: Operational Object when the feature is static OSM-derived context

**Projected State**:
The current canonical operational picture for a simulation run, held by the Simulation Run runtime and persisted in snapshots for fast reload.
_Avoid_: treating the durable journal or runtime-private projections as the current source for UI/API/AI reads

**Durable Journal**:
Meaningful accepted simulation-run history, such as commands, command results, object creation/deletion, interaction signals/effects, notifications, and semantic state changes.
_Avoid_: using the durable journal as a full high-frequency motion trace

**Live Change Feed**:
Realtime simulation-run updates broadcast to connected clients, including volatile updates that are not written to the durable journal.
_Avoid_: expecting the live feed to be a permanent replay store

## Relationships

- A Workspace may enable the **World Module** independently or compose it with other Modules.
- The Workspace Host owns Workspace identity and Module membership; the **World Module** owns all World state beneath that identity.
- A **Simulation Run** has one or more **Pack Runtimes**.
- A **Pack** may declare one or more **Pack Runtimes**.
- An **Operational Object** may carry **Pack Data** owned by its **Pack**.
- **Pack Data** is canonical object-level truth; **Runtime-Private State** is not.
- **Runtime-Private State** may be authoritative for internal mechanics only; operator, AI, command, or cross-pack facts must surface through **Projected State**, **Pack Data**, **Simulation Run Events**, or **Pack Queries**.
- Internal graph elements become **Operational Objects** only when promoted to the shared operational picture.
- A **Simulation Run** has exactly one active **Pack Runtime** for each active **Pack**.
- A **Composite Pack Runtime** may combine many **Sources** inside one active **Pack Runtime**.
- A **Runtime Hub** may connect several **Pack Runtimes** to one **Simulation Run**.
- A **Pack Runtime** emits candidate updates and signals into a **Simulation Run**.
- A **Pack Runtime** may observe committed **Simulation Run Events** to update **Runtime-Private State** or a **Runtime Projection**.
- A **Pack Query** is routed to the active **Pack Runtime** for that pack and must be read-only.
- **Pack Query** results are derived runtime-owned read views unless explicitly committed into **Projected State**.
- A **Simulation Run** can have many **Actors**.
- A **Simulation Run** can have many **Clients**.
- A **Simulation Run** belongs to one Workspace and references exactly one immutable **Scenario Revision**.
- A **Simulation Run** has an opaque id that is independent of its Scenario and is URL-addressable as `/w/{workspaceId}/runs/{runId}`.
- An **Actor** can have many **Clients**.
- A **Client** presents one primary **Surface** at a time.
- A future user account can map to one or more **Actors**.
- An **Operational Object** can have optional **Object Context**.
- A **Scenario Revision** can initialize **Operational Objects** and their **Object Context**.
- A **Scenario Revision** can include a **Scenario Script** for timed object updates, highlights, and **Scenario Guidance**.
- Restored **Simulation Runs** use pinned manifests, snapshots, and history instead of replaying or re-resolving Scenario Revisions.
- A **Mission Definition** can reference objects, roles, stages, objectives, and tasks initialized by a **Scenario Revision**.
- **Mission Progress State** belongs to a running **Simulation Run**, not to the reusable **Mission Definition**.
- **Interaction Signals** are scoped to one **Simulation Run** and may reference objects, actors, clients, pack runtimes, roles, areas, or broadcast targets.
- **Interaction Handlers** are registered through core or active packs and run inside the **Simulation Run** runtime.
- **Interaction Effects** become ordered **Simulation Run Events** only after validation and runtime commit.
- **Simulation Run Events** share one accepted event pipeline; the **Durable Journal** decides which events are retained as meaningful history.
- **AI agents** are **Actors** and **Clients** that may issue commands or emit interaction signals, but their outputs are not canonical truth until accepted by handlers and committed as events.
- **Projected State** is the canonical current Leitbild truth for UI, API, AI agents, metrics, and interaction handlers.
- The **Durable Journal** is meaningful accepted history for audit, debugging, replay of decisions, and later research instrumentation.
- **Traffic Conditions** may create **Route Impacts** for ambulances or future mobile assets, but rerouting remains an explicit command or future policy decision.
- A **Vector Map Artifact** provides **Map Context Layers** for orientation and contextual reasoning, but not canonical operational state.
- The **Map Capability Manifest** is the contract for discovering which **Map Context Layers** and properties exist.
- A **Spatial Field Index** can be reused by multiple packs, but each pack owns its own field semantics and computation.
- A **Weather Sparse Field** belongs to the weather pack runtime; the map receives projected features through `weather.mapFeatures`, not the field store itself.
- H3 is a shared indexing vocabulary, not shared operational truth. Weather, wildfire, radiation, or exposure packs may all use the same cell ids while keeping separate pack-owned state and update loops.
- A **Process Plant Runtime** belongs to the `process-plant` pack and consumes a compiled process system from a Scenario Revision.
- **Process Plant Runtime** is a pack-specific specialization of **Pack Runtime**.
- A **Process Variable Table** is the authoritative runtime store for one compiled process system.
- **Process Variables** are not **Operational Objects**; selected variables are exposed through generic pack queries and future process surfaces.
- A **Process Link** can contribute **Process Variables** to the same registry as component variables; sensors and actuators are metadata on variables, not separate node types by default.
- **Solver Phases** update continuous plant state; **Simulation Run Events** remain for discrete accepted history and operational transitions.
- A **Process Plant Behavior Context** is created inside one **Solver Phase** and enforces write discipline against the **Process Variable Table**.
- **Runtime-Private State** restores runtime-owned mechanics after reload without contaminating **Projected State**.
- The **Durable Journal** stores meaningful accepted history, not every volatile movement update.
- The **Live Change Feed** keeps connected Clients current; stale Clients reload **Projected State** from a snapshot.

## Example dialogue

> **Dev:** "When I reload `/w/example/runs/run-1`, should I create a new Simulation Run?"
> **Domain expert:** "No — reloading should rejoin the existing Simulation Run."
>
> **Dev:** "Can the server run several ambulance runtimes at the same time?"
> **Domain expert:** "Yes — each Simulation Run connects its own Pack Runtime."
>
> **Dev:** "If Anna opens the map and an alarm list in two browser tabs, is that one Client?"
> **Domain expert:** "No — Anna is one Actor with two Clients."
>
> **Dev:** "What are Anna's map and alert-list tabs called?"
> **Domain expert:** "They are two Clients presenting different Surfaces."

## Flagged ambiguities

- "session" was used to mean the shared world; resolved: the shared world is a **Simulation Run**.
- "plugin" was considered for installable capabilities; resolved: use **Pack** in product language, code, docs, APIs, and manifests.
- "instance" can mean too many things in software; resolved: use **Workspace** for the durable cross-application container, **Simulation Run** for one Leitbild execution, and **Pack Runtime** for active pack backing.
- "simulator" may describe an implementation style, but the canonical noun is **Pack Runtime**; user-facing labels should say "runtime" unless explicitly describing simulation behavior.
- "participant" sounded too research-specific; resolved: use **Actor** for operational identity inside a Simulation Run.
- "state" can mean canonical truth, pack-owned payload, runtime progress, or perspective. Use **Pack Data** for pack-owned operational truth, **Object Context** for perspective-bearing awareness, and **Mission Progress State** for mission runtime status.
- "event" can mean input signal, accepted state change, or UI attention. Use **Interaction Signal** for claims/observations/attempts, **Simulation Run Event** for accepted canonical history, and **Operational Notification** for attention items.
- "sim state" can mean runtime-private mechanics or shared Leitbild truth. Use **Runtime-Private State** or **Runtime Projection** for pack-runtime-local state, and **Projected State** for canonical Leitbild state.
- "traffic" can mean aggregate road conditions or individual traffic vehicles. Use **Traffic Condition** for aggregate route-affecting areas/segments; use future traffic-vehicle terminology only when individual vehicles are actually modeled.
