# Object Context, Scenarios, and Missions

This document defines Leitbild's extended object data model and the first scenario/mission vocabulary.

## Goals

- Keep `OperationalObject` as the canonical envelope for map-based control-center work.
- Keep `domainData` as domain-specific operational truth validated by the active domain pack.
- Add `context` as a perspective-bearing awareness layer for assets, operators, system processes, and AI agents.
- Separate scenario initialization from mission intent, objectives, tasking, and progression.
- Keep the v1 model JSON-friendly, Zod-validated, and suitable for later LLM-derived views without making LLM prompts canonical state.

## Rationale

Leitbild needs objects that are useful to humans, simulators, and AI agents. A hospital, ambulance, drone, ship, robotaxi, or incident all need current operational state, but agents also need a concise representation of what the object knows, has observed, has been told, and may need to remember.

This must not become one untyped blob. Simulation truth, operational domain state, and object perspective have different lifecycles and failure modes:

- **Operational truth** must remain replayable, validated, and suitable for UI/map rendering.
- **Perspective** may be incomplete, stale, uncertain, or actor-specific.
- **Agent views** should be derived from canonical state and context, not persisted as another source of truth.

## Sources Considered

- **MSDL / C2SIM-style separation**: military simulation standards separate initial scenario state from orders, reports, and ongoing tasking. Leitbild follows that split: scenario initializes the world; mission describes operational intent and progression. Reference: [NETN MSDL initialization](https://netn.mscoe.org/netn-modules/msdl).
- **Miltech Mission Hub**: uses mission settings, map objects, routes, objectives, triggers, activities, activation, and connections. Its activation discipline is important: later-stage objectives and triggers should not all be active from the start. References: [objectives, triggers, and activities](https://docs.miltechsimulations.com/miltech-mission-hub/guides/building-detailed-missions-objectives-triggers-and-activities), [map objects](https://docs.miltechsimulations.com/miltech-mission-hub/detailed-documentation/map-objects).
- **Microsoft Flight Simulator mission XML**: uses mission definitions, objectives, flow states, event triggers, and actions. This supports the staged mission-flow idea but also warns against overfitting to a flight-specific XML model. References: [mission definitions](https://docs.flightsimulator.com/html/Content_Configuration/Flights_And_Missions/Mission_Definitions.htm), [flow states](https://docs.flightsimulator.com/html/Content_Configuration/Flights_And_Missions/Mission_Elements/FlowStateAction.htm), [event triggers](https://docs.flightsimulator.com/html/Content_Configuration/Flights_And_Missions/Event_Trigger_Definitions.htm).
- **DCS-style mission editors**: trigger/action systems are powerful but can become brittle, hard to inspect, and difficult to test when many triggers are globally active. Leitbild v1 should use a small declarative trigger/action vocabulary, not a general scripting engine. Reference: [DCS trigger basics](https://wiki.hoggit.us/view/DCS_editor_triggerBasics).

## Terminology

**Operational Object**:
The canonical Leitbild object envelope. It contains identity, kind, domain, spatial state, operational state, tasking, telemetry, alerts, provenance, timestamps, optional domain data, and optional context.

**Domain Data**:
Domain-specific operational truth for an object. Domain packs own the schema and validation. Examples: ambulance crew/capabilities, incident victims/hazards, hospital emergency capacity.

**Object Context**:
Perspective-bearing artificial situation awareness attached to an operational object. Context captures what an asset, operator, system, or AI perspective knows, remembers, observed, or was told.

**Scenario Definition**:
Validated startup definition for a new control instance: world settings, required packs/providers, initial objects, initial contexts, and provider-specific simulator configuration.

**Mission Definition**:
Operational intent layered on top of a scenario: goals, objectives, tasks, stages, triggers, actions, and evaluation metrics.

**Mission Progress State**:
Runtime execution state for a mission definition: active stages, objective/task statuses, fired triggers, and timing. It is not the mission definition itself.

**Agent Context View**:
A bounded, derived, LLM-friendly view assembled from object state, context, mission/task state, and relevant nearby objects. It is not persisted as canonical state.

## Data Model Boundaries

### `domainData` vs `context`

`domainData` answers: "What is true enough for this domain's operational model?"

`context` answers: "What does this perspective know or remember about itself and the situation?"

Examples:

- Ambulance `domainData`: ALS capability, crew level, available seats.
- Ambulance `context`: recent dispatch radio call, last route deviation note, knowledge that Incident 77 may have two victims.
- Hospital `domainData`: current ambulance bay availability and diversion status.
- Hospital `context`: note that the ER charge nurse reported a possible capacity reduction five minutes ago.

### Truth vs Perspective

Leitbild supports both:

- Truth/reference state lives in canonical object fields and pack-validated `domainData`.
- Perspective-bearing awareness lives in `context`.
- Every context fact/activity must carry source, perspective, and time.

This allows uncertainty, stale information, asymmetric knowledge, simulated communication delay, and AI-agent reasoning without corrupting the canonical operational state.

## Object Context V1

`ObjectContext` is intentionally small:

- `schemaVersion`: currently `1`.
- `facts`: structured knowledge entries.
- `activity`: bounded recent memory/log entries.
- `references`: ids of relevant objects, tasks, messages, or external resources.
- `summaries`: compact summaries of older or grouped activity.

Context facts reuse the existing `KnowledgeFact<T>` semantics instead of inventing a second certainty system. The context wrapper adds `id`, `key`, `perspective`, and optional related object/task ids.

Context activity entries are short, timestamped memory records. They are not a replacement for the event log. They are an object-local perspective summary of relevant activity.

## Scenario Definition V1

A scenario initializes the world. It may include:

- metadata: id, title, description, schema version
- contribution and dependency identifiers: contributing pack id, required pack ids, and required simulation provider ids
- world setup: time, map center/viewport, environment values
- initial objects
- initial object contexts
- provider-specific simulator configuration keyed by provider id
- optional mission id/reference

Scenarios should be shareable as JSON and validated before use. A scenario may be pack-contributed, built-in, or later distributed through a pack repository.

New control instances start from a validated Scenario Definition. Restored control instances start from persisted snapshots and durable history. Domain-specific seed factories are not a production startup mechanism; if a pack needs helper functions, they must produce full validated `OperationalObject`s inside a Scenario Definition rather than a parallel seed format.

Scenario startup is multi-provider. A scenario may require several simulation providers, for example ambulance plus traffic. The Simulation Hub validates required provider ids and passes each provider only the initial objects and config relevant to that provider. This keeps scenario authoring centralized while preserving provider boundaries.

## Mission Definition V1

A mission describes what should happen operationally. It may include:

- metadata: id, title, description, schema version
- briefing text
- goals: broad desired outcomes
- objectives: measurable conditions with success/failure/abort status
- tasks: assignable work for actors, objects, or roles
- stages: ordered or conditional mission phases
- triggers: small declarative conditions
- actions: limited declarative results of triggers/objective changes
- evaluation metrics: response time, time on scene, objective completion, workload-relevant measures

V1 should not support arbitrary script execution. Mission logic should be inspectable, validated, and testable.

## Trigger and Action Vocabulary

Start with a small set:

- object reaches target
- object enters zone
- task assigned
- task completed
- fact/context changed
- timer elapsed
- resource threshold crossed

Start with small actions:

- activate stage
- complete objective
- fail objective
- abort objective
- assign task
- append context activity
- raise alert

More can be added only when concrete scenarios need them.

## Mission Progress State

Mission progress is runtime state, separate from the mission definition. It tracks:

- active stages
- objective statuses
- task statuses
- fired triggers
- timestamps
- emitted mission events

Keeping progress separate makes mission definitions reusable and makes replay/debugging cleaner.

## Domain Interaction Rules

Some domain behavior is not a user command and not a generic Leitbild-core concern. Examples include an ambulance loading patients at an incident, a hospital accepting patients, a drone draining battery, or a ship loading cargo.

These behaviors should live inside the simulation/domain pack. Leitbild core should not know ambulance-specific transfer rules, hospital admission rules, drone battery logic, or maritime cargo rules.

V1 rule pattern:

- objects carry data: capabilities, resources, load, capacity, status, context
- the simulation detects operational conditions such as arrival, proximity, timeout, threshold crossing, or assignment changes
- domain-local rule functions interpret object data and return explicit object upserts/deletes or other simulation events
- the simulation instance applies the results and emits ordered `SimulationEvent`s through the adapter

Objects should not contain executable behavior. An ambulance object should not directly mutate an incident, and a hospital object should not directly mutate an ambulance. Instead, the ambulance pack can define deterministic interaction helpers such as "empty ambulance arrived at incident" or "loaded ambulance arrived at hospital".

Any object type can be the source or subject of a domain event. For example, a hospital can report that no emergency beds are available, or an incident can report updated victim information. The object does not emit directly onto Leitbild's event stream; the simulation instance emits the event with provenance that identifies the simulator, object, and cause. This keeps event ordering, replay, persistence, and remote simulator integration coherent.

Generalization to a core rule engine is deferred until at least two real domain packs need the same abstraction.

## Agent Context View

An agent context view is derived on demand. It should contain:

- object identity and current operational state
- current mission/task assignment
- important context facts
- recent relevant activity
- concise summaries
- relevant nearby or linked objects by summary/reference
- allowed command/action affordances

The view should be bounded. Do not pass entire event logs, entire object graphs, or unfiltered raw context to LLMs.

## Options Considered

### Put everything into `domainData`

Rejected. Domain data should remain domain operational truth. Mixing perspective and memory into it would make replay, validation, and UI behavior ambiguous.

### Rename `domainData` to `domainState`

Deferred. The name may be clearer eventually, but current code and tests already use `domainData`. Renaming while adding context would make this change larger and riskier.

### Use `SituationModel` as the field name

Rejected for the concrete object field. It is conceptually accurate but too abstract. `context` is shorter and more natural for LLM handoff.

### Store agent prompts or full LLM context in objects

Rejected. Agent context views must be derived, bounded, and disposable. Persisted object context should remain structured data, not prompt text.

### Build a general mission scripting engine

Rejected for v1. It would be powerful but hard to validate, inspect, and test. Leitbild should start with a small declarative trigger/action vocabulary.

## Architectural Rules

- `domainData` and `context` must not be blurred.
- Context must be structured, not a generic junk drawer.
- Context is optional; existing snapshots remain valid.
- Mission definitions are reusable data; mission progress is runtime state.
- Agent context views are derived and must not become canonical state.
- Scenario and mission definitions must validate at file/API boundaries before execution.
- Domain interaction rules live in simulation/domain packs and must produce explicit events or object changes.
- Operational objects are data, not active executable actors.
