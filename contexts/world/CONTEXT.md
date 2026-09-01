# World

The World context owns simulated and live operational environments, their shared truth, and the mechanics that advance them.

## Language

**Scenario**:
A Workspace-owned reusable simulation setup that evolves through immutable Scenario Revisions.
_Avoid_: Simulation Run, Workspace Template

**Scenario Revision**:
An immutable validated Definition Revision that retains its exact authored Scenario Definition and Compiled Scenario for one or more Simulation Runs.
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
Optional Scenario Definition data describing the initial map frame and Pack-owned layer preferences a Client should show when it first opens a Simulation Run.
_Avoid_: persisted screen layout, Surface Definition, pane tree, or browser preference

**Scenario Item**:
A compact Pack-owned authored element such as an ambulance, weather area, or plant unit that is expanded into validated runtime startup state.
_Avoid_: assuming every Item is exactly one Operational Object

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
Its descriptor names `world` as its sole owning Module.
_Avoid_: Simulation Pack, Leitbild Pack, universal Pack, Experience
