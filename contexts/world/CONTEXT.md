# World

The World context owns simulated and live operational environments, their shared truth, and the mechanics that advance them.

## Language

**Scenario**:
A Workspace-owned reusable simulation setup that evolves through immutable Scenario Revisions.
_Avoid_: Simulation Run, Workspace Template

**Scenario Revision**:
An immutable validated Definition Revision that retains its editable Scenario Draft and exact compiled startup Definition for one or more Simulation Runs.
_Avoid_: mutable startup state, current Scenario

**Scenario Draft**:
The editable source of a Scenario: identity, selected Packs, compact Pack-owned Items, process systems, initial presentation, and Timeline.
_Avoid_: Scenario Config, compiled startup Definition, mutable Simulation Run

**Scenario Feature**:
A World Pack selected in a Scenario Draft. “Feature” is the author-facing view; the Pack remains the technical owner of its behavior and data.
_Avoid_: Capability, plugin, universal module

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
