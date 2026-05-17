# ADR 0009: Composite Simulation Providers and Traffic Conditions

## Decision

Leitbild will support multiple simulation providers inside one Control Instance through a small Simulation Hub.

The Simulation Hub connects provider adapters, merges their initial snapshots, forwards provider emissions into the Control Instance runtime, routes commands to providers that declare support for the command kind, broadcasts committed Domain Events back to every provider, and closes providers together.

The Control Instance event log and projected state remain the canonical Leitbild truth. Providers may keep private state and provider-local projections, but provider-to-provider interaction must flow through committed Domain Events and Interaction Signals.

The first second provider is a traffic provider. V1 traffic is modeled as aggregate **Traffic Conditions** such as congestion zones, blocked road segments, slow corridors, and access-restricted areas. Individual traffic vehicles are deferred.

## Rationale

Traffic belongs in its own provider because road state, closures, congestion, and access constraints are not ambulance-specific. Keeping traffic outside the ambulance provider proves that Leitbild can combine domains without turning any provider into the center of the world.

Aggregate traffic conditions are the right v1 model because they are operator-legible, cheap to render, easy for AI agents to summarize, and enough to affect ambulance ETA and route-awareness workflows. Individual cars are useful later for dense traffic, robotaxi, or street-level interaction studies, but they would force Leitbild to solve spawning, road following, queues, culling, and performance before the provider composition model is proven.

Route changes caused by traffic are decisionful. V1 records route impact and emits operator-visible notifications; it does not silently reroute ambulances. Human approval, AI recommendation, and automatic rerouting are separate policies to introduce after route-impact detection is stable.

## Consequences

- A Control Instance can connect more than one provider.
- Restored snapshots are split by provider domain when creating provider-local projections.
- Committed Domain Events are still observed by all providers so cross-provider awareness can develop.
- Provider emissions are ordered by arrival at the Control Instance; event `at` timestamps preserve provider-observed time.
- Provider command routing is explicit through declared command kinds.
- Traffic conditions are canonical Operational Objects with spatial geometry and traffic domain data.
- Traffic route impact is canonical state on the affected object, not private ambulance-provider truth.
- Automatic rerouting is deferred. V1 can warn, estimate penalty, and prepare the shape for future recommendations.

## Rejected Alternatives

### Add traffic to the ambulance provider

Rejected because it would make the ambulance provider own non-ambulance world state and would hide the cross-provider composition problem.

### Model individual cars first

Rejected for v1 because it adds high object counts, movement logic, road-following, culling, and rendering pressure before Leitbild has a real need for per-vehicle traffic behavior.

### Automatically reroute ambulances on new traffic

Rejected for v1 because rerouting changes operator authority and can cause route thrashing. The initial behavior should make route impact visible and auditable.

### Modify OSRM or routing graph costs immediately

Rejected for v1 because dynamic route-cost integration is routing-engine-specific. Leitbild should first model traffic effects in its canonical domain layer and use routing-engine integration later where justified.
