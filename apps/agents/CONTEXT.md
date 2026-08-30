# Agents

The Agents Module provides durable multi-participant Rooms and configurable AI actors inside a Workspace.

## Language

**Room**:
A durable shared conversation space with members, messages, delivery behavior, and Room-specific settings inside one Workspace.
_Avoid_: Channel, Thread, Simulation Run

**Room Definition**:
A durable authored identity whose immutable revision creates a Room, its initial members, selected Packs, Agent Profiles, semantic Tool Grants, and Prompt Deck.
_Avoid_: live Room state, Composition Definition, browser launch procedure

**Prompt Deck**:
A curated set of optional messages or Agent Script actions stored in a Room Definition Revision and resolved through a Room's pinned source revision.
_Avoid_: workflow, Agent Script, hard-coded browser action

**Agent**:
An AI actor with a model configuration, instructions, skills, tools, and bounded context assembly policy.
_Avoid_: hard-coded controller for a particular Resource

**Human Participant**:
A person represented in Room membership and message attribution.
_Avoid_: AI Agent Profile

**Workspace Settings**:
Room and Agent defaults that apply inside one Workspace.
_Avoid_: House Prompt, Deployment Settings

**Room Pack Set**:
The complete allowlist of installed Agent Packs effective in one Room.
_Avoid_: treating every installed Pack as active

**Agent Pack**:
An Agents extension that contributes tools, skills, scripts, knowledge, geodata, or reviewed UI extensions.
_Avoid_: universal Pack or cross-Module Pack ownership

**Agent Tool Grant**:
A durable permission for one Agent to invoke one namespaced Workspace Capability. A Resource is selected at invocation time and is never stored in the grant.
_Avoid_: persisted external Resource ids, base URLs, application-specific bindings

**Agent Schedule**:
A recurring wall-clock action owned by an Agent Profile.
_Avoid_: Trigger, Scenario Cue, simulation-time event

## Relationships

- Every Workspace has one Agents Module.
- A Workspace can have many Rooms and Agents.
- An Agent or Human Participant can belong to many Rooms in the same Workspace.
- A Room can activate many Agent Packs.
- The Agents Module owns Room membership and Agent Profiles.
- An Agent may discover Workspace Resources and Capabilities through the Leitbild Host.
- An Agent Tool Grant names a Capability, never a specific Resource or another Module's topology.
