# Leitbild Platform

The Leitbild Platform gives World and Agents one product identity without absorbing their domain state or behavior.

## Language

**Workspace**:
A durable, isolated work area with one identity, an optional display name, and independently owned World and Agents state. Packs are selected by Module-owned Definitions inside the Workspace; they are not installed into the Workspace itself.
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
_Avoid_: Module Membership, optional Module toggle, feature toggle

**Module Manifest**:
A Module's validated declaration of identity, Resources, Capabilities, lifecycle endpoints, and Workspace UI route.
_Avoid_: service-specific configuration guessed by the Host

**Resource**:
A Workspace-scoped domain entity that a Module makes discoverable by stable reference and type.
_Avoid_: copying the entity into the Host or using an untyped URL as identity

**Focused Subject**:
One of the few live Resources or exact immutable Definition Revisions currently visible in a Client and supplied transiently to an Agent turn. It conveys attention, not permission, durable association, or copied domain state.
_Avoid_: current mutable Definition, persisted Agent-to-Resource link, authorization scope

**Resource Summary**:
A small, current set of typed facts published with a Resource for discovery and overview surfaces, without replacing the Module's detailed state or read Capabilities.
_Avoid_: copied domain state, arbitrary JSON metadata, Host-owned interpretation of Module internals

**Inspection View**:
An on-demand, human-readable set of structured sections published by a Module for one exact Definition Revision or Resource. It exposes configuration, summaries, state, and provenance without moving ownership of that information into the Leitbild Host.
_Avoid_: bloated discovery catalogs, a raw persistence dump, Host-specific knowledge of Module internals

**Viewer Connection**:
One live client connection observing a Workspace or Resource. It is an ephemeral presence signal and is not necessarily one distinct person.
_Avoid_: User, participant, member, authenticated identity

**Capability**:
A typed command or query exposed by a Module for a Resource type or Workspace scope.
_Avoid_: tool name guessed by a caller, Pack, arbitrary RPC

**Definition**:
A durable reusable authored identity owned and validated by one Module. Its current revision may change.
_Avoid_: live state, universal configuration object, cross-Module schema

**Definition Revision**:
An immutable validated version of one Definition. Created Resources pin the exact revision that produced them.
_Avoid_: mutable current configuration, Resource state

**Pack**:
A Module-owned extension interpreted only by its owning Module.
World and Agents enforce their own Pack contracts and lifecycles; the shared architectural seam is the Platform Resource and Capability model, not a universal Pack runtime.
_Avoid_: Module, universal plugin, cross-Module runtime, forced shared Pack format

## Relationships

- A Leitbild Host can manage many Workspaces.
- Every Workspace provisions World and Agents.
- A Module owns its Workspace-scoped domain state.
- A Pack belongs to exactly one Module.
- Packs in different Modules interoperate through discovered Workspace Resources and Capabilities, never by importing each other's runtime internals.
- A Resource belongs to exactly one Module and one Workspace and may identify the Definition Revision that created it.
- A Capability is advertised by exactly one Module and may apply to a Definition type, Resource type, or Workspace.
