# ADR 0029: Weather truth and read-only Pack dependencies

## Status

Accepted, 2026-09-02.

## Decision

Weather owns one sampler combining prescribed atmospheric influences with persistent H3 ground state. Atmospheric areas are ordinary Scenario items and reuse the same schema for live creation and replacement. A probe is an observation, not an influence.

Ground integrates in fixed one-second simulation steps. Reading, projecting and observing echoed events never advances it. Dry/background ground remains implicit; only differences are materialized. Removing an area stops forcing but does not erase accumulated water, snow or ice. The existing private runtime store checkpoints irreducible ground mechanics; operational objects remain shared projections. This is not a crash-atomic transaction across the journal, projected snapshot and private checkpoint.

Queries carry simulation time, field revision, model fidelity and ground resolution. UI inspection, probes, Agents and Pack consumers read the same sampler. Geometry/evaluated frames/map responses may be cached by their actual inputs; caches are bounded and are not persisted.

Runtime Hub exposes only schema-validated, run-local queries to consumers. There is no cross-Pack mutation interface. Ambulance optionally reads Weather and owns its road-speed response, publishes canonical route impacts, and preserves unrelated constraints. Enabled integration without an active provider fails explicitly. The first policy samples the vehicle's current position: local traction/visibility affects current movement. Whole-route risk prediction and rerouting are separate future functions, not implicit behavior.

Clock validation runs before changing any runtime or the shared clock. Weather rejects rewinds and excessive forward work; it does not silently reset or fabricate history. Timer/checkpoint failures appear in runtime health; degraded Weather does not serve stale samples as healthy observations.

## Alternatives rejected

- Purely analytic ground: simpler, but loses accumulated conditions when an area moves.
- Gridded atmosphere: small areas disappear or require a much finer mesh. Atmospheric point sampling remains analytic; unresolved ground detail is reported.
- Weather modifying vehicles: violates ownership and forces dependency on every future consumer.
- Electrical-style ports for weather sampling: a different relationship; no conservation exchange or physical network is being solved here.
- A shared environmental solver or arbitrary extensions: no second implemented solver needs them.

## Consequences and limits

Scenario configuration controls background conditions and H3 resolution; runtime edits control area/probe definitions and explicit one-shot ground interventions. Resolution changes require a new run/reset. Editor additions are only Pack config fields and one-level repeated records, discovered from Pack contributions—not a recursive form DSL.

Areas are bounded ellipses, ordered by priority then ID, with linear or uniform falloff. Keyframes use explicit starting values, increasing times and inherited quantities. Ground is a training heuristic, not calibrated hydrology or road friction. Quantities and units are described; no fake confidence estimates or forecast provenance are supplied.

H3 stays behind core spatial functions, with hole-preserving coverage and pre-allocation work budgets. Dateline-crossing coverage is explicitly unsupported. There is no Fire or terrain-material model in this change. Future consumers may use the shared geographic index without adopting Weather's numerical mesh or state owner.
