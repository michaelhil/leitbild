# Collaboration

The Collaboration context owns durable multi-participant communication and coordination inside a Workspace.

## Language

**Room**:
A durable shared conversation space with membership, messages, delivery behavior, and Room-specific settings.
_Avoid_: Workspace, channel, Simulation Run

**Membership**:
The relationship that permits an Actor to participate in one Room.
_Avoid_: Workspace access policy, Module Membership

**Message**:
A durable contribution by an Actor to a Room.
_Avoid_: simulation event, capability invocation

**Collaboration Script**:
A declarative coordination sequence executed through Rooms and their members.
_Avoid_: Workspace Template, cross-Module workflow engine
