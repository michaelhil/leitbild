# Agents

The Agents context owns configurable AI actors and the runtime that lets them reason and act through permitted Workspace Capabilities.

## Language

**Agent**:
An AI actor with a model configuration, instructions, skills, tools, and bounded context assembly policy.
_Avoid_: hard-coded controller for a particular Resource

**Agent Profile**:
The durable behavior and runtime configuration of an Agent, excluding concrete Module Resource ids.
_Avoid_: Workspace Template, Resource Binding

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
_Avoid_: Samsinn Pack, universal Pack, or cross-Module ownership
