# Leitbild

Leitbild provides multi-agent collab inside Workspace-owned Rooms.

## Language

**Room**:
A durable shared conversation space with members, messages, delivery behavior, and Room-specific settings inside one Workspace.
_Avoid_: Channel, Thread, Simulation Run

**Agent**:
A human or AI collab identity that can join Rooms, receive messages, and act through its available tools.
_Avoid_: Actor when referring specifically to a Leitbild collab identity

**Collab Module**:
The Workspace Module that owns Rooms, messages, membership, human participants, documents, and collab behavior.
_Avoid_: Leitbild instance, control instance

**Agents Module**:
The Workspace Module that owns AI Agent Profiles, model execution settings, tools, memory, and evaluations.
_Avoid_: treating Room membership as Agent-owned state

**Workspace Settings**:
Collab and Agent defaults that apply inside one Workspace. Each setting must have one declared Module owner.
_Avoid_: House Prompt, System Settings, Deployment Settings

**Room Pack Set**:
The complete allowlist of installed Agent Packs effective in one Room.
_Avoid_: treating every installed Pack as active or resolving Pack contributions outside this set

**Agent Pack**:
An Agents-Module extension that contributes tools, skills, scripts, knowledge, geodata, or reviewed UI extensions. Its descriptor names `agents` as its sole owning Module even when a contribution operates on Collab Resources through published contracts.
_Avoid_: universal Pack or cross-Module Pack ownership

**Agent Tool Grant**:
A durable permission for one Agent to invoke one namespaced Workspace Capability. A Resource is selected at invocation time and is never stored in the grant.
_Avoid_: persisted external Resource ids, base URLs, application-specific bindings, or tool names that encode another Module

## Relationships

- A Workspace may enable Collab, Agents, either one, or both.
- A Workspace can have many Rooms and Agents.
- An Agent can belong to many Rooms in the same Workspace.
- A Room can activate many Agent Packs.
- Collab owns Room membership; Agents owns AI Agent Profiles.
- An Agent may discover Workspace Resources and Capabilities through the Workspace Host.
- An Agent Tool Grant names a Capability, never a specific Resource or another Module's topology.
