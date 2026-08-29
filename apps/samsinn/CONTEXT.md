# Samsinn

Samsinn provides multi-agent collaboration inside Workspace-owned Rooms.

## Language

**Room**:
A durable shared conversation space with members, messages, delivery behavior, and Room-specific settings inside one Workspace.
_Avoid_: Channel, Thread, Simulation Run

**Agent**:
A human or AI collaboration identity that can join Rooms, receive messages, and act through its available tools.
_Avoid_: Actor when referring specifically to a Samsinn collaboration identity

**Workspace Settings**:
Samsinn-wide collaboration defaults and preferences that apply across Rooms in one Workspace.
_Avoid_: House Prompt, System Settings, Deployment Settings

**Room Pack Set**:
The complete allowlist of installed Samsinn Packs effective in one Room.
_Avoid_: treating every installed Pack as active or resolving Pack contributions outside this set

**Simulation Run Binding**:
A Room's reference to one Leitbild Simulation Run in the same Workspace.
_Avoid_: duplicated Leitbild base URLs on Rooms or Agents, or treating the binding as a second Workspace Module Binding

## Relationships

- A Workspace can have many Rooms and Agents.
- An Agent can belong to many Rooms in the same Workspace.
- A Room can activate many Samsinn Packs.
- A Room may bind to one Leitbild Simulation Run.
- Agents inherit their Room's Simulation Run Binding unless an explicit specialist override is required.
