# Workspace Platform

The Workspace Platform gives composable Modules one shared product identity without absorbing their domain state or behavior.

## Language

**Workspace**:
A durable product container with one identity, optional display name, and a set of Module Memberships.
_Avoid_: Instance, Suite, account, Room, or Simulation Run

**Workspace Host**:
The sole public entry point and authority for Workspace identity, Module Membership, navigation, and Workspace-scoped routing.
_Avoid_: Suite, coordinator, shared domain runtime

**Experience**:
A coherent user-facing surface composed from one or more Modules, such as Leitbild or Samsinn.
_Avoid_: using Experience as a state owner or deployment boundary

**Module**:
A technical bounded context that owns domain state and behavior and can participate in a Workspace.
_Avoid_: Experience, Pack, process

**Module Membership**:
The durable fact that a Module participates in one Workspace, including its lifecycle status but not its domain state.
_Avoid_: Module Binding, installation, copied service URL

**Module Manifest**:
A Module's validated declaration of identity, Experiences, Resources, Capabilities, lifecycle endpoints, and UI contribution.
_Avoid_: service-specific configuration guessed by the Host

**Resource**:
A Workspace-scoped domain entity that a Module makes discoverable by stable reference and type.
_Avoid_: copying the entity into the Host or using an untyped URL as identity

**Capability**:
A typed command, query, or event stream exposed by a Module for a Resource type or Workspace scope.
_Avoid_: tool name guessed by a caller, Pack, arbitrary RPC

**Binding**:
A durable, explicitly configured relationship that maintains continuous system behavior between Resources.
_Avoid_: Agent preference, one-time tool call, hard-coded Agent-to-Resource link

**Pack**:
A Module-owned extension interpreted only by its owning Module.
_Avoid_: Module, universal plugin, cross-Module runtime

**Demo Definition**:
An optional experience-owned prompt, persona, tool recommendation, and capability requirement used to start a demonstration.
_Avoid_: environment provisioning, concrete Resource ids, workflow

**Workspace Template**:
An optional apply-once recipe that creates Module Membership and Module-owned seed Resources, after which the Workspace is ordinary and independent.
_Avoid_: Blueprint, controller, reconciliation, Agent configuration

**Distribution**:
An installable selection of the Workspace Host, Modules, Packs, and Experiences.
_Avoid_: giving single-Experience installations a different architecture

## Relationships

- A Workspace Host can manage many Workspaces.
- A Workspace can enable many Modules.
- A Module owns its Workspace-scoped domain state.
- An Experience can compose several Modules without owning their state.
- A Pack belongs to exactly one Module.
- A Resource belongs to exactly one Module and one Workspace.
- A Capability is advertised by exactly one Module and may apply to a Resource type or an entire Workspace.
- A Workspace Template may create a Workspace but never controls it afterward.
