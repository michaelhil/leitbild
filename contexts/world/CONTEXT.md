# World

The World context owns simulated and live operational environments, their shared truth, and the mechanics that advance them.

## Language

**Scenario**:
A Workspace-owned reusable simulation setup that evolves through immutable Scenario Revisions.
_Avoid_: Simulation Run, Workspace Template

**Scenario Revision**:
An immutable validated definition used to create one or more Simulation Runs.
_Avoid_: mutable startup state, current Scenario

**Scenario Fragment**:
Reusable World-owned authoring material included with explicit parameters and a local namespace when compiling a Scenario Revision.
_Avoid_: Scenario inheritance, runtime subtree, cross-Module fragment

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
A World entity with independent operational identity, state, visibility, or command relevance. A Module may publish it as a discoverable Resource without changing ownership.
_Avoid_: internal solver variable, runtime-private state, Platform Resource as a synonym

**World Pack**:
A World-owned Pack that contributes scenario material, mechanics, Resources, Capabilities, or presentation.
Its descriptor names `world` as its sole owning Module.
_Avoid_: Simulation Pack, Leitbild Pack, universal Pack, Experience
