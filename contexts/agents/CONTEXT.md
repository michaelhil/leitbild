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
_Avoid_: Composition Definition, cross-Module workflow engine

**Room Definition**:
An Agents-owned Definition whose immutable revision creates a Room, its initial Memberships, Agent Profiles, semantic Tool Grants, selected Packs, prompt, delivery mode, and Prompt Deck.
_Avoid_: live Room state, Composition Definition, browser launch procedure

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
_Avoid_: Composition Definition, persistent cross-Module Resource link

**Tool Grant**:
Permission for an Agent to invoke a named Capability under an explicit scope.
_Avoid_: implicit tool availability, Agent-to-Resource connection

**Workspace Capability Broker**:
The generic `workspace_catalog`, `workspace_capabilities`, and `workspace_invoke` tool surface derived at runtime whenever an Agent has one or more Tool Grants. It discovers current Resources and operations and enforces grants without becoming authored Agent behavior.
_Avoid_: repeating broker tool names in Agent Tool Selection, Module-specific client code, persisted Resource ids

**Room Pack Set**:
The complete set of installed Agent Packs whose contributions are available in one Room.
_Avoid_: treating every installed Pack as active, or treating Pack activation as an Agent tool grant

**Agent Tool Selection**:
The exact authored set of Agents tools one Agent may use. Pack activation makes a tool available to the Room but never adds it to an Agent Tool Selection; the Workspace Capability Broker is derived separately from Tool Grants.
_Avoid_: implicit Pack-wide grants, required-tools preflight lists, or conflating Agents tools with Workspace Capabilities

**Context View**:
A bounded, derived representation of relevant Workspace and Resource state supplied to an Agent for one decision.
_Avoid_: copied domain state, persisted generated prompt

**Evaluation**:
A repeatable assessment of Agent decisions and outcomes under declared conditions.
_Avoid_: production workflow or runtime controller

**Agent Pack**:
An extension owned by the Agents Module that contributes Agent-facing tools, skills, scripts, knowledge, geodata, or reviewed UI extensions.
_Avoid_: universal Pack or cross-Module ownership
