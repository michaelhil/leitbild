# Leitbild

Leitbild is a platform for shared, map-based control-center work over moving and spatial operational objects.

## Language

**Control Instance**:
A shared operational world in Leitbild, addressable by URL, where actors monitor objects, issue commands, receive events, and interact with one or more simulation instances.
_Avoid_: Study, StudySession, Session when referring to the shared world, Simulation Instance when referring to the Leitbild-managed shared world

**Simulation Definition**:
A simulator type or adapter configuration that can create simulation instances.
_Avoid_: Sim when referring to a Control Instance

**Simulation Instance**:
One running execution of a simulation definition connected to a control instance.
_Avoid_: Simulation Runtime, Sim Runtime

**Client**:
One connected browser tab, API integration, AI process, or display surface connected to a control instance.
_Avoid_: Session when referring to a connected browser tab or API connection

**Actor**:
A human, AI agent, or system identity that can observe or act within a control instance.
_Avoid_: Participant, User when referring to operational identity inside a control instance

**Surface**:
A functional UI mode presented by a client.
_Avoid_: View when referring to a domain-level UI mode

**Object Context**:
Structured, perspective-bearing artificial situation awareness attached to an operational object. It records facts, activity, references, and summaries from an asset, operator, system, or AI perspective.
_Avoid_: using context as an untyped junk drawer, or using it for domain operational truth that belongs in `domainData`

**Scenario Definition**:
Initial setup for a control instance or simulation instance: world settings, initial objects, initial object contexts, and simulator configuration.
_Avoid_: Mission when referring only to initial world setup

**Mission Definition**:
Operational intent layered on top of a scenario: goals, objectives, tasks, stages, triggers, actions, and evaluation metrics.
_Avoid_: Scenario when referring to objective/task progression

**Mission Progress State**:
Runtime execution state for a mission definition, including active stages, objective/task statuses, fired triggers, and timestamps.
_Avoid_: storing runtime progress inside the reusable Mission Definition

**Agent Context View**:
A bounded, derived, LLM-friendly view assembled from object state, object context, mission/task state, and relevant nearby objects.
_Avoid_: persisting generated prompt text or full event logs as canonical object state

## Relationships

- A **Control Instance** has one or more **Simulation Instances**.
- A **Simulation Definition** can create many **Simulation Instances**.
- A **Simulation Instance** belongs to one **Control Instance** unless an explicit bridge is introduced later.
- A **Control Instance** can have many **Actors**.
- A **Control Instance** can have many **Clients**.
- An **Actor** can have many **Clients**.
- A **Client** presents one primary **Surface** at a time.
- A future user account can map to one or more **Actors**.
- An **Operational Object** can have optional **Object Context**.
- A **Scenario Definition** can initialize **Operational Objects** and their **Object Context**.
- A **Mission Definition** can reference objects, roles, stages, objectives, and tasks initialized by a **Scenario Definition**.
- **Mission Progress State** belongs to a running **Control Instance**, not to the reusable **Mission Definition**.

## Example dialogue

> **Dev:** "When I reload `/i/sandbox`, should I create a new Control Instance?"
> **Domain expert:** "No — reloading should rejoin the existing Control Instance."
>
> **Dev:** "Can the server run several ambulance sims at the same time?"
> **Domain expert:** "Yes — those are separate Simulation Instances, each connected to a Control Instance."
>
> **Dev:** "If Anna opens the map and an alarm list in two browser tabs, is that one Client?"
> **Domain expert:** "No — Anna is one Actor with two Clients."
>
> **Dev:** "What are Anna's map and alert-list tabs called?"
> **Domain expert:** "They are two Clients presenting different Surfaces."

## Flagged ambiguities

- "session" was used to mean the shared world; resolved: the shared world is a **Control Instance**.
- "instance" can mean too many things in software; resolved: technical contexts must qualify the noun as **Control Instance** or **Simulation Instance**.
- "participant" sounded too research-specific; resolved: use **Actor** for operational identity inside a Control Instance.
- "state" can mean canonical truth, domain state, runtime progress, or perspective. Use **domainData** for domain operational truth, **Object Context** for perspective-bearing awareness, and **Mission Progress State** for mission runtime status.
