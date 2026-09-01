# ADR 0028: Typed electrical connections between Pack runtimes

## Status

Accepted.

## Context

Process Plants and Electric Grids must exchange power continuously while remaining usable as independent Packs. The Grid owns dense network topology and balancing; the Plant owns generation, station-service demand, protection, and process physics. Existing Grid connection points were descriptive load wrappers, and neither Pack exposed a live electrical boundary.

A Grid-specific Plant generator, a Plant-specific Grid adapter, or an integration Pack would duplicate ownership and hard-wire this first coupling. A generic binding language, external-interface registry, or central co-simulation engine would add extensibility machinery before a second proven interaction type exists. Making the Grid instantiate Plants would also hide Scenario composition and make standalone Plant use ambiguous.

## Decision

A Scenario Definition may contain a small list of **Electrical Connections**. Each connection joins one named system **Electrical Port** to one named network Electrical Port. Scenario compilation resolves both ports from Pack-owned Operational Object projections, rejects missing or multiply connected ports and voltage mismatches, and derives effective exchange limits. There are no arbitrary paths, expressions, payloads, plug-in registries, or implicit object creation.

Each Pack owns the meaning and dynamics of its ports. Process Plant computes gross generation, auxiliary demand, net exchange, and station-service availability. Electric Grid applies the resulting injection to its network solver and publishes voltage, frequency, and energization at the connection point. The two runtimes exchange only the shared, timestamped electrical-port state through canonical current Operational Object projections. Durable events remain reserved for meaningful discrete changes.

The Runtime Hub gives every active Pack runtime one combined initial snapshot after all runtimes connect, then continues to fan out committed projected-object updates. It does not solve physics, order Pack-specific calculations, or become a general co-simulation scheduler. Existing Pack cadences remain authoritative until measured accuracy requires a more explicit scheduler.

An unconnected Plant uses its explicitly configured ideal electrical boundary. In a connected Scenario, observed Grid state is authoritative; stale or disconnected state must become unavailable rather than silently falling back to the ideal boundary.

## Consequences

- Process Plant and Electric Grid remain standalone, separately testable Packs.
- A Scenario explicitly composes four Plants and one Grid rather than asking one Pack to spawn another Pack's objects.
- Network topology and connection-point limits stay in the Grid Model; Plant design and station-service behavior stay in the Plant Model.
- Cross-Pack code shares only electrical schemas. Neither Pack imports the other.
- Current-state exchange is inspectable by users and agents through Operational Object projections.
- Tight sub-cycle protection or electromagnetic transient studies are outside this aggregate coupling's fidelity. A scheduler may be introduced only from demonstrated timing requirements.
- Adding a second physical interaction does not automatically extend this electrical schema; its domain model must earn its own concrete connection type.

## Guardrails

- Do not add arbitrary variable paths, expressions, scripts, or untyped payloads to Electrical Connections.
- Do not create a universal port registry or integration Pack from this one interaction type.
- Do not let Grid Models instantiate Process Plant Operational Objects.
- Do not duplicate a Plant generator inside the Grid Model when a connected Plant runtime owns it.
- Do not use committed signals for dense continuous values or silently substitute standalone boundary state after a connected peer becomes stale.
