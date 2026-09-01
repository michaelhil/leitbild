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
One selected World Pack and its Pack-owned authored items, runtime choice, and configuration inside a Scenario Definition.
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
A stable bus, branch, generator, load, or storage identity inside a Grid Model and Grid runtime. Grid Assets are discoverable and controllable through bounded Pack queries and commands, but are not independent Operational Objects.
_Avoid_: Operational Object, map reference feature, anonymous solver variable

**Electrical Connection Point**:
A Grid-owned Electrical Port in a Grid Model that identifies where another operational system may exchange power with the Grid.
_Avoid_: hard-coded Plant link, arbitrary signal binding, Grid Asset synonym

**Electrical Port**:
A Pack-owned, named electrical boundary on an Operational Object. It declares voltage and exchange limits and may publish current active power, voltage, frequency, energization, and connection state.
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

**Recording Profile**:
A Pack-owned named choice of operational signals and allowed sampling cadence that may be selected by a Scenario.
_Avoid_: Recording Policy, hand-authored signal list, universal logging rule

**Scenario Timeline**:
An ordered collection of declarative Cues evaluated against Simulation Run time or committed World events.
_Avoid_: Scenario Script, arbitrary code, simulator-private timer

**Cue**:
A typed trigger and ordered Capability invocations within a Scenario Timeline.
_Avoid_: generic workflow step, arbitrary expression

**Simulation Run**:
A persistent execution of exactly one Scenario Revision inside one Workspace.
_Avoid_: Instance, session, Scenario

**Operational Object**:
A World entity with independent operational identity, state, visibility, or command relevance. It is discoverable inside Simulation Context before deeper object reads or commands.
_Avoid_: internal solver variable, runtime-private state, Platform Resource as a synonym

**Simulation Context**:
An agent-safe current view of a Simulation Run: Scenario identity and objectives, current clock and guidance, operational-object summaries, and available operations. It excludes unrevealed Scenario Timeline content.
_Avoid_: full snapshot dump, future-event leak, copied solver state

**World Pack**:
A World-owned Pack that contributes scenario material, mechanics, Resources, Capabilities, or presentation.
Its descriptor names `world` as its sole owning Module. Its strict Scenario configuration schema validates Pack-owned settings and is published for discovery.
_Avoid_: Simulation Pack, Leitbild Pack, universal Pack, Experience
