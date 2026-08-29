# World

The World context owns simulated and live operational environments, their shared truth, and the mechanics that advance them.

## Language

**Scenario**:
A Workspace-owned reusable simulation setup that evolves through immutable Scenario Revisions.
_Avoid_: Simulation Run, Workspace Template

**Scenario Revision**:
An immutable validated definition used to create one or more Simulation Runs.
_Avoid_: mutable startup state, current Scenario

**Simulation Run**:
A persistent execution of exactly one Scenario Revision inside one Workspace.
_Avoid_: Instance, session, Scenario

**Operational Resource**:
A discoverable World entity with operational identity, state, visibility, or command relevance.
_Avoid_: internal solver variable, runtime-private state

**World Pack**:
A World-owned Pack that contributes scenario material, mechanics, Resources, Capabilities, or presentation.
Its descriptor names `world` as its sole owning Module.
_Avoid_: Simulation Pack, Leitbild Pack, universal Pack, Experience
