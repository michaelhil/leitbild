# Leitbild Platform

The Leitbild Platform gives World and Agents one product identity without absorbing their domain state or behavior.

## Language

**Workspace**:
A durable product container with one identity, optional display name, and a set of Module Memberships.
_Avoid_: Instance, Suite, account, Room, or Simulation Run

**Leitbild Host**:
The sole public entry point and authority for Workspace identity, core Module lifecycle, navigation, and Workspace-scoped routing.
_Avoid_: Workspace Host, Suite, coordinator, shared domain runtime

**Module**:
A technical bounded context that owns domain state and behavior and can participate in a Workspace.
_Avoid_: Experience, Pack, process

**Core Module**:
World or Agents: a Module provisioned for every Workspace while its expensive runtime activity remains lazy.
_Avoid_: optional Experience, user-installed Module

**Module Provisioning State**:
The lifecycle status of one core Module inside one Workspace, excluding the Module's domain state.
_Avoid_: Module Membership, Module Binding, feature toggle

**Module Manifest**:
A Module's validated declaration of identity, Resources, Capabilities, lifecycle endpoints, and Workspace UI route.
_Avoid_: service-specific configuration guessed by the Host

**Resource**:
A Workspace-scoped domain entity that a Module makes discoverable by stable reference and type.
_Avoid_: copying the entity into the Host or using an untyped URL as identity

**Capability**:
A typed command, query, or event stream exposed by a Module for a Resource type or Workspace scope.
_Avoid_: tool name guessed by a caller, Pack, arbitrary RPC

**Definition**:
An immutable, reusable declaration that one Module validates and can instantiate as Resources.
_Avoid_: live state, universal configuration object, cross-Module schema

**Binding**:
A durable, explicitly configured relationship that maintains continuous system behavior between Resources.
_Avoid_: Agent preference, one-time tool call, hard-coded Agent-to-Resource link

**Pack**:
A Module-owned extension interpreted only by its owning Module.
_Avoid_: Module, universal plugin, cross-Module runtime

**Preset**:
An apply-once cross-Module composition of pinned Module-owned Definition Revisions. Launching a Preset creates ordinary independent Resources and optional typed Bindings.
_Avoid_: Workspace Template, Blueprint, workflow, controller, reconciliation

## Relationships

- A Leitbild Host can manage many Workspaces.
- Every Workspace provisions World and Agents.
- A Module owns its Workspace-scoped domain state.
- A Pack belongs to exactly one Module.
- A Resource belongs to exactly one Module and one Workspace.
- A Capability is advertised by exactly one Module and may apply to a Resource type or an entire Workspace.
- A Preset may create Resources in several Modules but never controls them afterward.
