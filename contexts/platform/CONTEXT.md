# Platform

The Platform coordinates independently deployable applications without becoming their shared runtime or state store.

## Language

**Deployment**:
An installed and running application environment with its own code, infrastructure configuration, and installed Packs.
_Avoid_: Instance when referring to an installation or process

**Workspace**:
A durable container that gives related Samsinn, Leitbild, and future module data one shared identity while leaving each module responsible for its own state.
_Avoid_: using a process, account, Room, or Run as the cross-Module container

**Module**:
A major application that may be enabled in a Workspace, such as Samsinn or Leitbild.
_Avoid_: Pack, Service when referring to the product capability presented to a Workspace

**Module Binding**:
The discovery information needed to reach one Module for one Workspace.
_Avoid_: copying module URLs and credentials into individual Rooms or Agents

**Workspace Directory**:
The authoritative catalog of Workspace identity, display metadata, enabled Modules, and Module Bindings for one deployment mode.
_Avoid_: shared application database, orchestration bus, central runtime

**Pack**:
An application-scoped extension installed in a Deployment and made available within Workspaces.
_Avoid_: Module, Plugin, Capability

**Capability**:
An effective command, query, stream, or user-interface facility exposed by an active application runtime.
_Avoid_: Pack when referring to one callable or observable ability

## Relationships

- A Deployment can host many Workspaces.
- A Workspace can enable many Modules.
- A Module owns one application-specific data shard inside a Workspace.
- A Pack belongs to exactly one Module.
- A Workspace Directory owns metadata and Module Bindings, not module data.
- A standalone Module uses a local Workspace Directory.
- A combined deployment may use the suite Workspace Directory.
