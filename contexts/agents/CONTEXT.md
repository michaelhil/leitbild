# Agents

The Agents context owns multi-participant Rooms, configurable AI actors, and the runtime that lets people and AI agents coordinate and act through permitted Workspace Capabilities.

## Language

**Room**:
A durable shared conversation space with membership, messages, delivery behavior, and Room-specific settings.
_Avoid_: Workspace, channel, Simulation Run

**Membership**:
The relationship that permits an Actor to participate in one Room.
_Avoid_: Workspace access policy, Module provisioning state

**Assistance Room**:
An explicitly created Room whose Scope identifies the Workspace or Resources the conversation is about. The Room may remain useful when a selected Resource is later removed; creating or copying a Simulation Run does not create a Room.
_Avoid_: Companion Room, default Room, Binding, hard-coded simulation controller

**Room Scope**:
The Workspace, exact Resource, or Resource collection available to a Room's Agents. Collection membership may include future copies or select explicit members; current browser attention never expands this boundary.
_Avoid_: Tool Grant, Subject Selection, copied Resource state

**Leitbild Assistant**:
An ordinary Agent that handles product questions, exploration and authoring within its Room Scope using configured skills and tools.
_Avoid_: Assistant service, scenario generator, privileged code agent, Assistant Pack

**Message**:
A durable contribution by an Actor to a Room.
_Avoid_: simulation event, Capability invocation

**Agent Script**:
A declarative coordination sequence executed through Rooms and their members.
_Avoid_: Composition Definition, cross-Module workflow engine

**Room Definition**:
An Agents-owned Definition whose immutable revision creates a Room, its initial Memberships, Agent Profiles, selected Packs, prompt, delivery mode, and Prompt Deck.
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

**Progressive Discovery**:
Agent-directed acquisition of proportionate Workspace evidence through compact catalogs, searchable Capability descriptions, exact schemas, and bounded reads. The Agent decides what to inspect and when it has enough evidence; it is guidance, not a mandatory retrieval sequence.
_Avoid_: eager state dump, rigid lookup workflow, universal situation-report service

**Room Pack Set**:
The complete set of installed Agent Packs whose contributions are available in one Room.
_Avoid_: treating every installed Pack as active, or treating Pack activation as an Agent tool grant

**Agent Tool Selection**:
The exact authored set of Agents tools one Agent may use. Pack activation makes a tool available to the Room but never selects it for an Agent; generic Workspace discovery, invocation and Room evidence retrieval remain available to every Agent.
_Avoid_: implicit Pack-wide grants, required-tools preflight lists, or conflating Agents tools with Workspace Capabilities

**Agent Skill Selection**:
The exact authored set of behavioral Skills included in one Agent Profile. A Room name never selects Skills; Room Pack activation only makes Pack-owned selected Skills available.
_Avoid_: name-based Skill scope, global Skill injection, permission policy

**Context View**:
A bounded, derived representation of relevant Workspace and Resource state supplied to an Agent for one decision.
World context presents transparent attention items and a representative operational-object cross-section; an Agent narrows it with searchable Capabilities and reads details only when needed.
Focused subjects identify the Client's visible live Resources or exact Definition Revisions, but are transient and grant no authority.
_Avoid_: copied domain state, persisted generated prompt, current mutable Definition inference

**Generation Metadata**:
Structured facts about one generated response, including provider, model, duration, token use, prompt-cache use, model-call count, and tool-call count. Clients may render it with the response, but it is not conversational content and is not returned to the model as history.
_Avoid_: model-authored telemetry footer, hidden provider log

**Model Request**:
The exact input prepared for one model call. It can include earlier tool exchanges but does not establish what happened after that call.
_Avoid_: complete execution history, reconstructed prompt

**Execution Evidence**:
Recorded tool attempts and their actual outcomes during an Agent turn, including turns that never produce an answer. A missing outcome means uncertain, not failed or safe to retry.
_Avoid_: model request, discovery memory, inferred action success

**Evaluation**:
A repeatable assessment of Agent decisions and outcomes under declared conditions.
_Avoid_: production workflow or runtime controller

**Agent Pack**:
An extension owned by the Agents Module that contributes Agent-facing tools, skills, scripts, knowledge, geodata, or reviewed UI extensions.
Its descriptor is self-describing, belongs only to `agents`, and its exact selected id makes contributions available to a Room without granting them to every Agent.
_Avoid_: universal Pack or cross-Module ownership

**Agent Pack Catalog**:
The deployment-scoped inventory of bundled and installed Agent Packs and their discovered contributions.
_Avoid_: repeated filesystem discovery through Agent tools, universal Pack catalog

**Wiki Source**:
A read-only Agent Pack knowledge source whose documents and metadata are discovered through one validated, revisioned manifest.
_Avoid_: guessed document paths, scraped human index, tool-specific source clients

**Agent Pack Manager**:
The deployment-scoped service that installs, updates, uninstalls, and reloads Agent Packs while keeping contribution catalogs and Room Pack Sets consistent.
_Avoid_: Pack lifecycle logic embedded in REST routes or Agent tools
