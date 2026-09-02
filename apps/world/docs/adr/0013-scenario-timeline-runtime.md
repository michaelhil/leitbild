# ADR 0013: Scenario Timeline Runtime

## Decision

Leitbild implements a Scenario Timeline as a Simulation Run runtime capability.

A Scenario Timeline is an optional declarative sequence of Cues on a Scenario Definition. It is not an Agent Script, browser tutorial, or simulator-private timer system. The Simulation Run runtime schedules Cues, converts actions into ordered Domain Events, applies them to projected state, broadcasts them to clients, persists durable history, and forwards committed events to simulation providers.

V1 supports only `after_scenario_start` timing. The action vocabulary is intentionally small: show/hide guidance, highlight/clear object highlights, upsert or delete an operational object, emit a typed interaction signal, and invoke a Simulation Capability explicitly marked schedulable.

Built-in scenarios may be authored as compact JSON Scenario Definitions. Pack-owned scenario codecs validate and expand Pack-specific Items and mutations into full runtime startup state before a Simulation Run starts. The runtime still consumes only the Compiled Scenario and never executes arbitrary scenario code.

## Rationale

Scenario timing affects shared operational truth and must be visible to all clients, API consumers, AI agents, simulations, snapshots, and replay tooling. Keeping it in the Simulation Run runtime avoids hidden browser-local state and avoids putting scenario orchestration inside one domain provider.

The Timeline stays declarative because Leitbild needs scenarios to be inspectable, validated, and testable. General scripting, conditions, loops, and workflow engines are excluded until concrete requirements justify specific additions.

The compact config layer exists because full `OperationalObject` JSON is too verbose for scenario authors and LLM-assisted editing. Keeping expansion in pack-owned codecs avoids putting ambulance or traffic construction code in each scenario and avoids a second production seed path.

## Consequences

- New simulation runs can start with non-empty, evolving scenarios.
- Reloaded clients receive current scenario guidance/highlights from the snapshot.
- Restored runtimes use fired Cue ids to avoid refiring completed Cues.
- Overdue Cues may fire when a restored runtime starts.
- Domain-specific mechanics still live in packs and interaction handlers.
- Scenario Timelines can create or mutate objects across active Packs, but Pack-owned schemas validate those authored actions before a Run starts.
- Scheduled commands use the same Simulation Capability contract, validation, targeting, and event path as UI and Agent invocations.
- Scenario configs can demonstrate multi-pack scenarios by activating several packs, for example ambulance plus traffic, while keeping scenario URLs explicit and scenario-first, such as `/i/oslo-ambulance/sandbox`.
- Future trigger kinds should build on the same event-commit discipline rather than bypass it.
