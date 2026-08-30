# Agents

The Agents context owns multi-participant Rooms, configurable AI actors, and the runtime that lets people and AI agents coordinate and act through permitted Workspace Capabilities.

## Language

**Room**:
A durable shared conversation space with membership, messages, delivery behavior, and Room-specific settings.
_Avoid_: Workspace, channel, Simulation Run

**Membership**:
The relationship that permits an Actor to participate in one Room.
_Avoid_: Workspace access policy, Module provisioning state

**Message**:
A durable contribution by an Actor to a Room.
_Avoid_: simulation event, Capability invocation

**Agent Script**:
A declarative coordination sequence executed through Rooms and their members.
_Avoid_: Preset, cross-Module workflow engine

**Room Definition**:
An Agents-owned declaration used to create a Room, its initial Memberships, Agent Profiles, selected Packs, prompt, and delivery mode.
_Avoid_: live Room state, Preset, browser launch procedure

**Prompt Deck**:
A curated set of optional, explicitly invoked message or Agent Script actions, usually presented as demonstration or training choices.
_Avoid_: workflow, Agent Script, hard-coded browser action

**Agent Trigger**:
A recurring wall-clock action owned by an Agent Profile.
_Avoid_: Scenario Cue, simulation-time event, general workflow

**Agent**:
An AI actor with a model configuration, instructions, skills, tools, and bounded context assembly policy.
_Avoid_: hard-coded controller for a particular Resource

**Agent Profile**:
The durable behavior and runtime configuration of an Agent, excluding concrete Module Resource ids.
_Avoid_: Preset, persistent cross-Module Resource link

**Tool Grant**:
Permission for an Agent to invoke a named Capability under an explicit scope.
_Avoid_: implicit tool availability, Agent-to-Resource connection

**Context View**:
A bounded, derived representation of relevant Workspace and Resource state supplied to an Agent for one decision.
_Avoid_: copied domain state, persisted generated prompt

**Evaluation**:
A repeatable assessment of Agent decisions and outcomes under declared conditions.
_Avoid_: production workflow or runtime controller

**Agent Pack**:
An extension owned by the Agents Module that contributes Agent-facing tools, skills, scripts, knowledge, geodata, or reviewed UI extensions.
_Avoid_: universal Pack or cross-Module ownership
