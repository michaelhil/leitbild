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
A control-instance-local coordinator that connects multiple simulation providers, merges their provider snapshots, routes commands to providers that accept them, forwards provider emissions, and broadcasts committed domain events back to providers.
_Avoid_: putting multi-provider orchestration inside one domain provider

**Provider Private State**:
Simulation-internal state used for specialist mechanics, such as route following, sensor models, traffic queues, timers, or high-resolution internal entities. It is not the shared operational picture.
_Avoid_: exposing provider private state directly as canonical API/UI/AI state

**Provider Projection**:
A provider-local read model of committed control-instance state that helps a simulation provider continue its mechanics. It follows canonical events but is not itself canonical.
_Avoid_: calling this the object store or source of truth

**Client**:
One connected browser tab, API integration, AI process, or display surface connected to a control instance.
_Avoid_: Session when referring to a connected browser tab or API connection

**Actor**:
A human, AI agent, or system identity that can observe or act within a control instance.
_Avoid_: Participant, User when referring to operational identity inside a control instance

**Surface**:
A functional UI mode presented by a client.
_Avoid_: View when referring to a domain-level UI mode

**Object Context**:
Structured, perspective-bearing artificial situation awareness attached to an operational object. It records facts, activity, references, and summaries from an asset, operator, system, or AI perspective.
_Avoid_: using context as an untyped junk drawer, or using it for domain operational truth that belongs in `domainData`

**Scenario Definition**:
Initial setup for a control instance or simulation instance: world settings, initial objects, initial object contexts, and simulator configuration.
_Avoid_: Mission when referring only to initial world setup

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
- A **Control Instance** can have many **Actors**.
- A **Control Instance** can have many **Clients**.
- An **Actor** can have many **Clients**.
- A **Client** presents one primary **Surface** at a time.
- A future user account can map to one or more **Actors**.
- An **Operational Object** can have optional **Object Context**.
- A **Scenario Definition** can initialize **Operational Objects** and their **Object Context**.
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
- The **Durable Journal** stores meaningful accepted history, not every volatile movement update.
- The **Live Change Feed** keeps connected Clients current; stale Clients reload **Projected State** from a snapshot.

## Example dialogue

> **Dev:** "When I reload `/i/sandbox`, should I create a new Control Instance?"
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
