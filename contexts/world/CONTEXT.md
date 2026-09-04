# World

The World context owns simulated and live operational environments, their shared truth, and the mechanics that advance them.

## Language

**Scenario**:
A Workspace-owned reusable simulation setup that evolves through immutable Scenario Revisions.
_Avoid_: Simulation Run, Workspace Template

**Scenario Revision**:
An immutable validated Definition Revision that retains its exact authored Scenario Definition. Its Compiled Scenario is reproduced through the selected Pack implementations when needed.
_Avoid_: Scenario Draft, mutable startup state, current Scenario

**Scenario Definition**:
The authored reusable source of a Scenario: metadata, starting conditions, Starting View, Pack Selections, and optional Timeline. An unsaved editor value may be called a draft, but Draft is not a persisted domain type.
_Avoid_: Scenario Config, Compiled Scenario, mutable Simulation Run

**Compiled Scenario**:
The internal deterministic startup artifact produced from one Scenario Definition Revision by the selected World Packs.
_Avoid_: authored Scenario Definition, Scenario Template, live Simulation Run state

**Pack Selection**:
One selected World Pack and its Pack-owned authored items, runtime choice, configuration, and optional Recording Profile inside a Scenario Definition.
_Avoid_: Scenario Feature, Capability, or duplicated Pack ids across parallel configuration maps

**Starting View**:
Scenario Definition data describing the initial map frame and optional object-rail preferences a Client should show when it first opens a Simulation Run.
_Avoid_: persisted screen layout, Surface Definition, pane tree, or browser preference

**Scenario Item**:
A compact Pack-owned authored element such as an ambulance, weather area, or plant unit that is expanded into validated runtime startup state.
_Avoid_: assuming every Item is exactly one Operational Object

**Plant Model**:
A reusable Process Plant topology and its design parameters, expressed as a validated component graph.
_Avoid_: running Plant, Process System, graph assembly

**Operating Point**:
A reusable set of initial values applied to a compatible Model when an operational system starts, such as a Plant or Grid.
_Avoid_: Model parameters, transient, runtime snapshot

**Simulation Time**:
The time within one Simulation Run, shared by its scenario behavior and simulated systems. It advances at the Run's selected speed, stops when paused or unloaded, and resumes from saved progress.
_Avoid_: wall-clock observation time, a component's independent clock, relabeling current state as time travel

**Observation Time**:
The wall time at which operational state or an event was observed or accepted. It is separate from the Simulation Time represented by that state.
_Avoid_: scenario epoch, solver elapsed time

**Plant**:
A Process Plant Scenario Item that selects one Plant Model, Operating Point, automation, and location. A Plant becomes independently stateful only inside a Simulation Run.
_Avoid_: Unit and Process System as separate authored records

**Automation Definition**:
A reusable Pack-owned set of typed automatic behavior selected by an operational system. Examples include Process Plant I&C rules and Grid load, storage, and protection policies.
_Avoid_: Procedure, arbitrary script, hidden control path

**Grid Model**:
A reusable electrical topology containing stable Grid Assets, design parameters, source provenance, and typed connection points. Reference-map geometry remains separate.
_Avoid_: running Grid, reference dataset, Operational Object collection

**Grid**:
An Electric Grid Scenario Item that selects one Grid Model, Operating Point, Automation Definition, and location. One Grid is one Operational Object; it becomes independently stateful only inside a Simulation Run.
_Avoid_: Grid Model, regional runtime container, collection of top-level asset objects

**Grid Asset**:
A stable bus, branch, generator, load, or storage identity inside a Grid Model and Grid runtime. Grid Assets are discoverable and controllable through bounded Simulation Capabilities, but are not independent Operational Objects.
_Avoid_: Operational Object, map reference feature, anonymous solver variable

**Electrical Connection Point**:
A Grid-owned Electrical Port in a Grid Model that identifies where another operational system may exchange power with the Grid.
_Avoid_: hard-coded Plant link, arbitrary signal binding, Grid Asset synonym

**Electrical Port**:
A Pack-owned, named electrical boundary on an Operational Object. It declares whether it is a system or network port, voltage and exchange limits, and may publish current active power, voltage, frequency, energization, and connection state.
_Avoid_: arbitrary variable path, generic integration endpoint, duplicated remote asset

**Electrical Connection**:
A Scenario-authored continuous relationship between one system Electrical Port and one network Electrical Port. Compilation resolves compatible ports and effective limits; each Pack retains its own physics.
_Avoid_: generic Binding language, Integration Pack, implicit Pack or object creation

**Action Preset**:
A discoverable parameterized Process Plant operation that resolves to validated commands, such as a turbine trip or a developing leak.
_Avoid_: Demo Transient, runtime-private schedule, executable scenario code

**Process Display**:
A validated Process Plant visualization definition whose widgets bind to signals in a compatible Plant Model.
_Avoid_: Process Surface, Starting View, generated UI code

**Historian**:
An optional Simulation Run service that stores explicitly selected observation series. The Durable Journal separately retains meaningful committed events; together they support historical inspection without making dense samples canonical World state.
_Avoid_: Durable Journal, runtime snapshot, automatic capture of every private variable

**Weather Influence**:
A Weather-owned spatial and time-varying input to environmental conditions. It is not a measurement or an asset's response to those conditions.
_Avoid_: Weather Probe, road-speed policy, reference-map layer

**Weather Probe**:
A named point that samples Weather conditions in a Simulation Run without changing them.
_Avoid_: Weather Influence, physical sensor feed unless a real source supplies it

**Situation Monitor**:
An optional World Pack for collecting, inspecting, and discussing externally reported situations across user-selected regions or the world. External reports remain distinct from simulated conditions and actions.
_Avoid_: World Monitor integration, regional demo, simulation engine, treating an external report as verified physical truth

**Situation Source**:
A named, configurable external input selected by Situation Monitor, with an explicit provider or format and collection scope.
_Avoid_: Pack, Operational Object, browser layer, separate Subscription entity

**External Record**:
A sourced report, event, measurement or media reference collected by Situation Monitor, retaining its provenance and time meaning independently of simulated state.

**Source Snapshot**:
The latest complete, successfully collected provider window, including an empty window. Its cache lifetime is renewed by successful provider validation, not by failed requests; it is not a historical archive.

**Observation Subject**:
The provider-identified station or location to which observations or forecast samples refer. Series group by subject and quantity, never by source alone.
_Avoid_: verified fact, simulated asset, historian sample as a universal content container

**Ground Conditions**:
Accumulated environmental surface state that can remain after a Weather Influence moves or stops, including wetness, standing water, snow, ice and frost.
_Avoid_: atmospheric target, road friction coefficient, reference-map appearance

**Road-weather Policy**:
An optional mobility-owned rule that translates sampled conditions into an explained movement constraint. It changes the asset's response, not the weather.
_Avoid_: Weather Influence, hidden rerouting, calibrated tire model

**Response Unit**:
A medical transport asset—currently a road ambulance or rotary-wing helicopter—with explicit mobility, patient capacity, care capabilities, crew readiness and a current operational assignment.
_Avoid_: separate custody workflows per vehicle type, assuming every mobile asset can transport patients

**Incident**:
A reported operational event at a fixed occurrence location, optionally associated with an existing asset. Dispatch urgency describes the response request, not a diagnosis or an individual patient's assessed priority.
_Avoid_: converting the associated asset into an incident, moving the occurrence when its associated asset moves

**Patient**:
An individually tracked case with assessed care needs, disposition and exactly one current holder: an incident, response unit or care site.
_Avoid_: an interchangeable casualty counter, invented physiology

**Incident Observation**:
A timestamped, source-attributed summary recorded when a validated reconnaissance sensor observes an Incident. It reports only facts represented by the simulation, while the observing Pack remains independent of the Incident's domain model.
_Avoid_: invented sensor findings, Drone-owned patient state, generic cross-Pack mutation

**Care Site**:
A receiving or stabilization service at an established location with explicit acceptance criteria and handover capacity. A building or map label alone does not establish that service.
_Avoid_: hospital bed count as ambulance handover capacity, implicit clinical capability

**Handover**:
The transfer of a patient's care from a response unit to a care site. Arrival, waiting for a handover slot, transfer completion and unit release are distinct operational moments.
_Avoid_: instant unloading, treating hospital arrival as unit availability

**Procedure Source**:
A read-only procedure corpus discovered through one validated Manifest whose revision identifies the immutable document set.
_Avoid_: hard-coded procedure list, human-readable index scraping, eagerly loaded procedure bundle

**Procedure Run**:
The operational progress state for one procedure in one Plant scope, pinned to the exact Procedure Source Revision from which it began.
_Avoid_: reading a mutable latest procedure during an active Run, Procedure Document

**Recording Profile**:
A Pack-owned named choice of operational signals and allowed sampling cadence that may be selected by a Scenario.
_Avoid_: Recording Policy, hand-authored signal list, universal logging rule

**Scenario Timeline**:
An ordered collection of declarative Cues evaluated against Simulation Run time. Cues may change guidance/highlights, emit interaction signals or invoke a Capability explicitly marked schedulable. Object changes use live commands, not precompiled object snapshots. Equal-time cues retain authored order.
_Avoid_: Scenario Script, arbitrary code, simulator-private timer

**Cue**:
A simulation-time trigger with ordered declarative actions and Capability invocations.
_Avoid_: generic workflow step, arbitrary expression

**Simulation Run**:
A persistent execution of exactly one Scenario Revision inside one Workspace, with an optional independent display name. Editing or deleting the reusable Scenario does not rename or delete its Runs.
_Avoid_: Instance, session, Scenario

**Run Copy**:
An ordinary independent Simulation Run created from another Run at one coherent simulation-time boundary. Its stable Run Family and lineage identify related Runs, the immediate source, and the checkpoint without prescribing how any member executes.
_Avoid_: Run Fork, Accelerated Copy, duplicate Scenario, linked live mirror

**Execution Mode**:
The current way one Simulation Run advances: Paused, Realtime, or Fast-forward. It is independent of Run copying and viewer presence.
_Avoid_: separate Run type, browser playback state, arbitrary clock multiplier

**Fast-forward**:
Unpaced execution of a compatible Simulation Run using the same shared Simulation Time and Pack boundaries as Realtime execution. It may run continuously until stopped or for a fixed duration, reports its measured multiplier, and ends Paused or Realtime as explicitly selected.
_Avoid_: Acceleration Job, fixed clock speed, background simulation type

**Background Execution**:
Explicit ownership that keeps a loaded Simulation Run available without viewers. It is distinct from whether its clock is paused, and ends when the Run is unloaded or the service stops.
_Avoid_: viewer presence as execution policy, automatic restart policy

**Operational Object**:
A World entity with independent operational identity, state, visibility, or command relevance. It is discoverable inside Simulation Context before deeper object reads or commands.
_Avoid_: internal solver variable, runtime-private state, Platform Resource as a synonym

**Simulation Context**:
An agent-safe current view of a Simulation Run: Scenario identity and objectives, current clock, runtime health, guidance, procedure state, operational-object summaries, and available Capabilities. It excludes unrevealed Scenario Timeline content.
_Avoid_: full snapshot dump, future-event leak, copied solver state

**Simulation Capability**:
A self-describing command or query with one stable id, risk and idempotency metadata, strict input/output schemas, and—when appropriate—explicit timeline schedulability. World-core behavior and Pack Runtime behavior use this same invocation model.
_Avoid_: generic command/query tunnel, untyped operation list, UI-only action

**Pack Runtime Health**:
A compact account of an active Pack Runtime's execution availability and operation failures. A stopped solver is failed, even when its last snapshot remains readable; a paused simulation is not a failed provider.
_Avoid_: separate monitoring store, swallowed runtime failure, fabricated heartbeat

**History Retention**:
The bounded observation history a Run keeps for inspection, expressed independently of which signals are discoverable or selected for recording. Removing old observations does not remove current operational state or authored Scenarios.
_Avoid_: deleting a Run, hiding a signal, restart checkpoint

**World Pack**:
A World-owned Pack that contributes scenario material, mechanics, Resources, Capabilities, or presentation.
Its descriptor names `world` as its sole owning Module. Its strict Scenario configuration schema validates Pack-owned settings and is published for discovery. A selected Pack is compiled into startup state, creates one explicit runtime, and exposes operations only as typed Simulation Capabilities. Browser code consumes an honest presentation view rather than a partial fake runtime Pack.
_Avoid_: Simulation Pack, Leitbild Pack, universal Pack, Experience

**World Pack Catalog**:
The deterministic inventory of complete server-side World Packs. It validates descriptor, capability, scenario-authoring, runtime, and contribution consistency before any Scenario can use a Pack.
_Avoid_: discovering browser modules from the filesystem, accepting structurally incomplete Packs, universal Pack catalog
