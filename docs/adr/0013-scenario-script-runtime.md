# ADR 0013: Scenario Script Runtime

## Decision

Leitbild implements Scenario Script V1 as a Control Instance runtime capability.

A Scenario Script is an optional declarative timeline on a Scenario Definition. It is not a browser tutorial script and not a simulator-private timer system. The Control Instance runtime schedules script steps, converts actions into ordered Domain Events, applies them to projected state, broadcasts them to clients, persists durable history, and forwards committed events to simulation providers.

V1 supports only `after_scenario_start` timing. The action vocabulary is intentionally small: show/hide guidance, highlight/clear object highlights, upsert an operational object, and delete an operational object.

Built-in scenarios may be authored as compact JSON Scenario Config files. Pack-owned scenario codecs expand pack-specific object specs and update operations into full validated `ScenarioDefinition` data before a Control Instance starts. The runtime still consumes only the expanded definition and never executes arbitrary scenario code.

## Rationale

Scenario timing affects shared operational truth and must be visible to all clients, API consumers, AI agents, simulations, snapshots, and replay tooling. Keeping it in the Control Instance runtime avoids hidden browser-local state and avoids putting scenario orchestration inside one domain provider.

The script model stays declarative because Leitbild needs scenarios to be inspectable, validated, and testable. General scripting, conditions, loops, and mission engines are deferred until concrete scenarios need them.

The compact config layer exists because full `OperationalObject` JSON is too verbose for scenario authors and LLM-assisted editing. Keeping expansion in pack-owned codecs avoids putting ambulance or traffic construction code in each scenario and avoids a second production seed path.

## Consequences

- New control instances can start with non-empty, evolving scenarios.
- Reloaded clients receive current scenario guidance/highlights from the snapshot.
- Restored runtimes use fired step ids to avoid refiring completed script steps.
- Overdue script steps may fire when a restored runtime starts.
- Domain-specific mechanics still live in packs and interaction handlers.
- Scenario scripts can create or update objects across active packs, but object schemas must remain valid at the pack boundary.
- Scenario configs can demonstrate multi-pack scenarios by activating several packs, for example ambulance plus traffic, while keeping scenario URLs simple such as `?scenario=oslo-ambulance`.
- Future trigger-based mission logic should build on the same event-commit discipline rather than bypass it.
