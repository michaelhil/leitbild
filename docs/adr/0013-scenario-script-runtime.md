# ADR 0013: Scenario Script Runtime

## Decision

Leitbild implements Scenario Script V1 as a Control Instance runtime capability.

A Scenario Script is an optional declarative timeline on a Scenario Definition. It is not a browser tutorial script and not a simulator-private timer system. The Control Instance runtime schedules script steps, converts actions into ordered Domain Events, applies them to projected state, broadcasts them to clients, persists durable history, and forwards committed events to simulation providers.

V1 supports only `after_scenario_start` timing. The action vocabulary is intentionally small: show/hide guidance, highlight/clear object highlights, upsert an operational object, and delete an operational object.

## Rationale

Scenario timing affects shared operational truth and must be visible to all clients, API consumers, AI agents, simulations, snapshots, and replay tooling. Keeping it in the Control Instance runtime avoids hidden browser-local state and avoids putting scenario orchestration inside one domain provider.

The script model stays declarative because Leitbild needs scenarios to be inspectable, validated, and testable. General scripting, conditions, loops, and mission engines are deferred until concrete scenarios need them.

## Consequences

- New control instances can start with non-empty, evolving scenarios.
- Reloaded clients receive current scenario guidance/highlights from the snapshot.
- Restored runtimes use fired step ids to avoid refiring completed script steps.
- Overdue script steps may fire when a restored runtime starts.
- Domain-specific mechanics still live in packs and interaction handlers.
- Scenario scripts can create or update objects across active packs, but object schemas must remain valid at the pack boundary.
- Future trigger-based mission logic should build on the same event-commit discipline rather than bypass it.
