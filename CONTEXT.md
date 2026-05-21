# Leitbild

Leitbild is a platform for shared, map-based control-center work over moving and spatial operational objects.

## Language

**Control Instance**:
A shared operational world in Leitbild, addressable by URL, where actors monitor objects, issue commands, receive events, and interact with one or more simulation instances.
_Avoid_: Study, StudySession, Session when referring to the shared world, Simulation Instance when referring to the Leitbild-managed shared world

**Simulation Definition**:
A simulator type or adapter configuration that can create simulation instances.
_Avoid_: Sim when referring to a Control Instance

**Simulation Instance**:
One running execution of a simulation definition connected to a control instance.
_Avoid_: Simulation Runtime, Sim Runtime

**Simulation Provider**:
The adapter-facing role of a simulation instance: it emits observations, object updates, telemetry, and interaction signals into a control instance, and observes committed control-instance events to update private mechanics or provider-local projections.
_Avoid_: treating a provider as the canonical owner of shared Leitbild object state

**Simulation Hub**:
A control-instance-local coordinator that connects multiple simulation providers, merges their provider snapshots, routes commands to providers that accept them, routes pack queries to the active provider for that pack, forwards provider emissions, and broadcasts committed domain events back to providers.
_Avoid_: putting multi-provider orchestration inside one domain provider

**Provider Private State**:
Simulation-internal state used for specialist mechanics, such as route following, sensor models, traffic queues, timers, or high-resolution internal entities. It is not the shared operational picture.
_Avoid_: exposing provider private state directly as canonical API/UI/AI state

**Provider Projection**:
A provider-local read model of committed control-instance state that helps a simulation provider continue its mechanics. It follows canonical events but is not itself canonical.
_Avoid_: calling this the object store or source of truth

**Pack Query**:
A read-only, pack-scoped request routed through the Control Instance API and Simulation Hub to the active provider for that pack. Pack queries expose provider-owned computations such as weather-at-point, weather map features, traffic conditions for a route, or ambulance dispatch state without teaching core or generic UI modules those domains.
_Avoid_: hardcoded weather/traffic/ambulance API routes, arbitrary RPC, or mutating state through query handlers

**Client**:
One connected browser tab, API integration, AI process, or display surface connected to a control instance.
_Avoid_: Session when referring to a connected browser tab or API connection

**Actor**:
A human, AI agent, or system identity that can observe or act within a control instance.
_Avoid_: Participant, User when referring to operational identity inside a control instance

**Surface**:
A functional UI mode presented by a client.
_Avoid_: View when referring to a domain-level UI mode

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
_Avoid_: using context as an untyped junk drawer, or using it for domain operational truth that belongs in `domainData`

**Scenario Definition**:
Validated startup definition for a new control instance: world settings, active packs, optional provider overrides/configuration, initial objects, and initial object contexts. Scenarios are top-level compositions, not pack-owned files, and are the only production startup format for new control instances.
_Avoid_: Mission when referring only to initial world setup

**Scenario Config**:
Compact JSON authoring format for built-in scenarios. It names active packs and pack-specific object/operation specs; pack scenario codecs expand it into a validated Scenario Definition before runtime.
_Avoid_: treating config specs as runtime truth or putting arbitrary executable code in scenario files

**Pack Scenario Codec**:
Pack-owned expansion surface that converts compact scenario object specs and scenario operations into validated operational objects. It is the correct place for pack-specific scenario defaults and `domainData` construction.
_Avoid_: scenario files hand-building full domain objects with reusable helper code

**Scenario Catalog**:
Validated registry of Scenario Definitions and Mission Definitions. Control Instance creation resolves its startup scenario through this catalog, then resolves each scenario pack to that pack's default or overridden simulation provider.
_Avoid_: hidden domain seed factories or hardcoded default simulator boot paths

**Scenario Script**:
A small declarative, time-based action list attached to a Scenario Definition. It can show guidance, highlight objects, upsert/delete objects, and evolve scenario facts by emitting ordered Domain Events into the Control Instance runtime.
_Avoid_: arbitrary script execution, browser-only tutorial state, or hidden simulator seed timers

**Scenario Guidance**:
Canonical scenario-owned UI instruction state for onboarding, tutorial prompts, and scripted scenario briefings. It is stored in Control Instance projected state so all clients and reloads see the same current guidance.
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
A scoped claim, observation, or interaction attempt emitted by a simulation instance, actor, AI agent, client, or system process inside a control instance. Signals are inputs to interaction handling; they are not canonical state changes by themselves.
_Avoid_: treating a signal payload as accepted truth, or letting one object directly mutate another object

**Interaction Handler**:
A deterministic, registered function contributed by core or an active pack that inspects an interaction signal plus the current control-instance snapshot and returns proposed effects. Handlers do not mutate state directly.
_Avoid_: callback-style object behavior, hidden side effects, or long-lived handler-local memory

**Interaction Effect**:
A constrained proposed result of handling a signal, such as upserting an object, deleting an object, or emitting an operational notification. Effects are committed by the control-instance runtime as ordered domain events.
_Avoid_: arbitrary imperative code paths that bypass event ordering, validation, audit, or replay

**Operational Notification**:
A durable attention item emitted from interaction handling or system logic for operators, AI agents, replay, and debugging. A notification is not a substitute for canonical object state.
_Avoid_: UI-only toasts for information that should be visible to AI agents, event history, or replay

**Traffic Condition**:
An aggregate traffic object describing congestion, closure, slowdown, or access restriction over a road segment or area.
_Avoid_: modeling every traffic need as individual cars before aggregate traffic effects are proven insufficient

**Route Impact**:
Canonical route-awareness state describing how another object or condition affects a moving object's planned route, ETA, or movement assumptions.
_Avoid_: hiding route impact only inside a simulation provider's private state

**Vector Map Artifact**:
The self-hosted PMTiles archive containing MVT vector tiles used as Leitbild's base map context.
_Avoid_: Raster Tile, OSM PNG Tile, or treating the map artifact as operational truth

**Map Capability Manifest**:
The machine-readable contract describing available vector tile layers, fields, geometry, intended use, and schema version.
_Avoid_: relying on prose docs or hard-coded tile assumptions inside simulation providers

**Spatial Field Index**:
A generic, globally stable cell index used by packs that need field-like spatial state, such as weather, wildfire, radiation, or population exposure. V1 wraps H3 in `src/core/spatial/*`; pack code uses the wrapper and never imports `h3-js` directly. The wrapper exposes branded cell ids, validated resolutions, point-to-cell lookup, polygon coverage, cell boundaries, centers, parents, and neighbor rings.
_Avoid_: pack-specific grid implementations in UI modules, direct H3 imports outside the wrapper, or treating visual cells as operational objects

**Weather Sparse Field**:
The weather pack's materialized subset of the global H3 spatial field. It stores H3 cells currently under a weather influence, cells evolving after prior influence, and stable non-default cells that remain queryable. Default global weather is implicit and does not require materializing every cell on earth. Map rendering receives provider-projected features for base grid outlines, affected cells, and influence shapes through a pack query; it does not own weather computation.
_Avoid_: computing weather truth only for the viewport, making weather cells canonical Leitbild operational objects, or exposing weather internals through generic UI code

**Process Plant Runtime**:
The `process-plant` pack's fixed-step, headless runtime for compiled process systems. It owns process variables, applies accepted commands at phase boundaries, runs deterministic solver phases, and produces snapshots for tests and future provider integration.
_Avoid_: modeling continuous process physics as object-to-object events, HTTP endpoint behavior before a real runtime lifecycle exists, or treating process variables as operational objects

**Process Variable Table**:
The single authoritative in-memory store for compiled process variables inside one process plant runtime. Component and process-link behavior modules read and write through this table; they do not maintain duplicate state maps.
_Avoid_: shadow variable stores in solver behavior, command handling outside writability/type validation, or copying plant state into operational objects

**Process Variable**:
A stable, unit-bearing value path inside a compiled process system, such as `core.powerMw` or `sgA.pressureMPa`. Process variables declare quantity, unit, writability, kind, domain, and publish policy.
_Avoid_: free-text units, ad hoc telemetry object fields, or mutable untyped variable bags

**Process Link**:
A typed connection between process plant components. A process link may be a simple topology link, or it may own optional physical metadata and link-local process variables such as flow, pressure, radiation, valve position, or leak area.
_Avoid_: making every simple sensor, valve, or leak into a separate component when it only modifies or observes one connection

**Solver Phase**:
One ordered pass in a continuous process simulation tick, such as applying commands, solving electrical behavior, solving fluid flow, solving heat transfer, or publishing outputs.
_Avoid_: hidden update ordering inside component callbacks or continuous physics over the interaction event bus

**Map Context Layer**:
A vector tile layer that provides environmental or infrastructure context such as roads, POIs, water, buildings, land use, or boundaries.
_Avoid_: Operational Object when the feature is static OSM-derived context

**Projected State**:
The current canonical operational picture for a control instance, held by the Control Instance runtime and persisted in snapshots for fast reload.
_Avoid_: treating the durable journal or provider-private projections as the current source for UI/API/AI reads

**Durable Journal**:
Meaningful accepted control-instance history, such as commands, command results, object creation/deletion, interaction signals/effects, notifications, and semantic state changes.
_Avoid_: using the durable journal as a full high-frequency motion trace

**Live Change Feed**:
Realtime control-instance updates broadcast to connected clients, including volatile updates that are not written to the durable journal.
_Avoid_: expecting the live feed to be a permanent replay store

## Relationships

- A **Control Instance** has one or more **Simulation Instances**.
- A **Simulation Definition** can create many **Simulation Instances**.
- A **Simulation Instance** belongs to one **Control Instance** unless an explicit bridge is introduced later.
- A **Simulation Hub** may connect several **Simulation Providers** to one **Control Instance**.
- A **Simulation Provider** emits candidate updates and signals into a **Control Instance**.
- A **Simulation Provider** may observe committed **Domain Events** to update **Provider Private State** or a **Provider Projection**.
- A **Pack Query** is routed to the active **Simulation Provider** for that pack and must be read-only.
- A **Control Instance** can have many **Actors**.
- A **Control Instance** can have many **Clients**.
- A **Scenario Run** is a URL-addressable run of one **Scenario Definition** inside a **Control Instance**, for example `/i/halden/sandbox`; its internal Control Instance id is `halden:sandbox`.
- An **Actor** can have many **Clients**.
- A **Client** presents one primary **Surface** at a time.
- A future user account can map to one or more **Actors**.
- An **Operational Object** can have optional **Object Context**.
- A **Scenario Definition** can initialize **Operational Objects** and their **Object Context**.
- A **Scenario Definition** can include a **Scenario Script** for timed object updates, highlights, and **Scenario Guidance**.
- Restored **Control Instances** use snapshots/history instead of replaying Scenario Definitions.
- A **Mission Definition** can reference objects, roles, stages, objectives, and tasks initialized by a **Scenario Definition**.
- **Mission Progress State** belongs to a running **Control Instance**, not to the reusable **Mission Definition**.
- **Interaction Signals** are scoped to one **Control Instance** and may reference objects, actors, clients, simulation instances, roles, areas, or broadcast targets.
- **Interaction Handlers** are registered through core or active packs and run inside the **Control Instance** runtime.
- **Interaction Effects** become ordered **Domain Events** only after validation and runtime commit.
- **AI agents** are **Actors** and **Clients** that may issue commands or emit interaction signals, but their outputs are not canonical truth until accepted by handlers and committed as events.
- **Projected State** is the canonical current Leitbild truth for UI, API, AI agents, metrics, and interaction handlers.
- The **Durable Journal** is meaningful accepted history for audit, debugging, replay of decisions, and later research instrumentation.
- **Traffic Conditions** may create **Route Impacts** for ambulances or future mobile assets, but rerouting remains an explicit command or future policy decision.
- A **Vector Map Artifact** provides **Map Context Layers** for orientation and contextual reasoning, but not canonical operational state.
- The **Map Capability Manifest** is the contract for discovering which **Map Context Layers** and properties exist.
- A **Spatial Field Index** can be reused by multiple packs, but each pack owns its own field semantics and computation.
- A **Weather Sparse Field** belongs to the weather simulation provider; the map receives projected features through `weather.mapFeatures`, not the field store itself.
- H3 is a shared indexing vocabulary, not shared domain truth. Weather, wildfire, radiation, or exposure packs may all use the same cell ids while keeping separate pack-owned state and update loops.
- A **Process Plant Runtime** belongs to the `process-plant` pack and consumes a compiled process system from a Scenario Definition.
- A **Process Variable Table** is the authoritative runtime store for one compiled process system.
- **Process Variables** are not **Operational Objects**; selected variables may be published through future pack queries or surfaces.
- A **Process Link** can contribute **Process Variables** to the same registry as component variables; sensors and actuators are metadata on variables, not separate node types by default.
- **Solver Phases** update continuous plant state; **Domain Events** remain for discrete accepted history and operational transitions.
- The **Durable Journal** stores meaningful accepted history, not every volatile movement update.
- The **Live Change Feed** keeps connected Clients current; stale Clients reload **Projected State** from a snapshot.

## Example dialogue

> **Dev:** "When I reload `/i/halden/sandbox`, should I create a new Control Instance?"
> **Domain expert:** "No — reloading should rejoin the existing Control Instance."
>
> **Dev:** "Can the server run several ambulance sims at the same time?"
> **Domain expert:** "Yes — those are separate Simulation Instances, each connected to a Control Instance."
>
> **Dev:** "If Anna opens the map and an alarm list in two browser tabs, is that one Client?"
> **Domain expert:** "No — Anna is one Actor with two Clients."
>
> **Dev:** "What are Anna's map and alert-list tabs called?"
> **Domain expert:** "They are two Clients presenting different Surfaces."

## Flagged ambiguities

- "session" was used to mean the shared world; resolved: the shared world is a **Control Instance**.
- "instance" can mean too many things in software; resolved: technical contexts must qualify the noun as **Control Instance** or **Simulation Instance**.
- "participant" sounded too research-specific; resolved: use **Actor** for operational identity inside a Control Instance.
- "state" can mean canonical truth, domain state, runtime progress, or perspective. Use **domainData** for domain operational truth, **Object Context** for perspective-bearing awareness, and **Mission Progress State** for mission runtime status.
- "event" can mean input signal, accepted state change, or UI attention. Use **Interaction Signal** for claims/observations/attempts, **Domain Event** for accepted canonical history, and **Operational Notification** for attention items.
- "sim state" can mean provider-private mechanics or shared Leitbild truth. Use **Provider Private State** or **Provider Projection** for simulation-side state, and **Control Instance projected state** for canonical Leitbild state.
- "traffic" can mean aggregate road conditions or individual traffic vehicles. Use **Traffic Condition** for aggregate route-affecting areas/segments; use future traffic-vehicle terminology only when individual vehicles are actually modeled.
