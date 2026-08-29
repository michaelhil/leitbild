# Microworld

The Microworld context owns shared simulated worlds, their operational truth, and the mechanics that advance them.

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
A discoverable Microworld entity with operational identity, state, visibility, or command relevance.
_Avoid_: internal solver variable, runtime-private state

**Simulation Pack**:
A Microworld-owned Pack that contributes scenario material, mechanics, Resources, Capabilities, or presentation.
_Avoid_: universal Pack, Experience
