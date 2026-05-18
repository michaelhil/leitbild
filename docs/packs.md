# Leitbild Packs

A **Leitbild Pack** is a namespaced bundle of operational-domain capability.

Leitbild itself owns control instances, actors, roles, command envelopes, event ordering, state projection, map rendering, persistence, audit logs, metrics, and AI integration boundaries. Packs contribute domain-specific behavior behind those core seams.

Concrete pack implementations live in `src/packs/*`. The generic pack protocol, registry, and composition helpers live in `src/core/packs/*`.

## User-Facing Model

There is one installable unit: the pack.

Do not expose separate user-facing package types such as domain pack, simulation pack, scenario pack, UI pack, and asset pack. Those are contribution sections inside one pack.

Example repositories:

- `leitbild-pack-ambulance`
- `leitbild-pack-drone`
- `leitbild-pack-police`
- `leitbild-pack-robotaxi`

## Pack Contents

A pack may contain:

- domain schemas and domain object data validators
- object context schemas, context seed data, and agent-context renderers
- command kinds and payload validators
- simulation adapters or local simulation engines, including providers that compose with other active providers through the Simulation Hub
- provider metadata, including the pack's default simulation provider
- object icons, map symbols, and style rules
- object categories, summaries, visible fields, hover details, noteworthy-update policy, and inspectors
- command/action builders for UI controls
- interaction signal schemas and interaction handlers
- operational notification renderers and severity rules
- dashboard widgets and adaptive UI primitives
- research metrics, replay analyzers, and export helpers
- AI-agent prompts, role definitions, and tool descriptions

## Static V1

V1 uses static built-in packs only. A static pack is imported by Leitbild at build time and registered by code.

This is intentional. It lets the pack interface mature before Leitbild supports remote GitHub installation.

The first static pack is the ambulance dispatch pack.

## Future GitHub Distribution

Future pack repositories should use this layout:

```text
leitbild-pack-ambulance/
  leitbild.pack.json
  src/
    pack.ts
    model.ts
    commands.ts
    sim/
    ui/
    metrics/
  assets/
    icons/
  tests/
```

Installation should mirror the Samsinn pack model:

- bare name resolved through a configured registry
- `owner/repo` shorthand
- full Git URL
- clone into a temporary directory
- read `leitbild.pack.json`
- validate namespace and compatibility
- move into the final pack directory
- register contributions
- notify active UIs and control instances

Suggested environment variable:

```text
LEITBILD_PACK_SOURCES=leitbild-packs,michaelhil/leitbild-pack-ambulance
```

Suggested installed location:

```text
~/.leitbild/packs/<namespace>/
```

Server deployments may use:

```text
/opt/leitbild/packs/<namespace>/
```

## Manifest

Future external packs should include `leitbild.pack.json`.

```json
{
  "id": "ambulance",
  "name": "Ambulance Dispatch",
  "version": "0.1.0",
  "leitbild": ">=0.1.0",
  "description": "Ambulance dispatch domain, local simulator, and UI.",
  "contributes": {
    "domains": ["ambulance_dispatch"],
    "objectTypes": ["ambulance", "hospital", "incident", "patient"],
    "commands": [
      "ambulance.create_object",
      "ambulance.set_destination",
      "ambulance.cancel_destination"
    ],
    "simulationProviders": ["ambulance-local"],
    "interactionSignals": [
      "asset.arrived_at_target",
      "facility.capacity_changed"
    ],
    "interactionHandlers": [
      "ambulance.arrival-handler",
      "ambulance.capacity-handler"
    ],
    "contextSchemas": ["ambulance.context.v1"],
    "ui": ["objectDisplay", "inspector", "actions"],
    "map": ["icons", "plannedRoutes"],
    "metrics": ["response_time", "time_to_scene"]
  },
  "dependencies": [],
  "compatibleWith": [],
  "conflicts": []
}
```

## Namespacing

Pack contribution identifiers must be namespaced.

Examples:

- command kind: `ambulance.set_destination`
- provider id: `ambulance-local`
- UI contribution: `ambulance.object-inspector`
- metric: `ambulance.response-time`

Packs must not shadow core contribution names.

## Composition

Multiple packs should eventually be active in one control instance, for example ambulance + police + drone.

Composition rules:

- Leitbild owns the control instance clock.
- Leitbild owns event ordering.
- Leitbild owns command envelopes and actor identity.
- Leitbild owns permissions and ownership rules.
- Leitbild owns object IDs and canonical state.
- Leitbild owns interaction signal ordering and effect commit.
- Packs publish events through Leitbild seams.
- Packs issue changes to other operational domains only through declared commands, interaction signals, and committed events.
- Pack interaction handlers inspect signals plus current control-instance state and return constrained effects. They must not mutate shared state directly.

Multi-pack simulation orchestration uses the Simulation Hub once more than one provider is active in a Control Instance.

## Interaction Contributions

Packs may contribute interaction capability for cross-object and cross-simulation behavior.

An **Interaction Signal** is a scoped claim, observation, or interaction attempt. Examples:

- `asset.arrived_at_target`
- `facility.capacity_changed`
- `incident.patient_count_updated`
- `observation.detected`
- `ai.recommendation.created`

An **Interaction Handler** validates signal payloads it understands, inspects the current control-instance snapshot, and returns constrained effects such as object upserts, object deletes, or operational notifications.

Packs must keep the distinction clear:

- Signals are input claims or observations.
- Handler effects are proposals.
- Domain events are accepted canonical history after Leitbild validates, orders, persists, and broadcasts the effects.

Unknown signal payloads may be stored for audit, but must not mutate canonical state unless a registered handler validates and accepts them.

## Traffic Conditions

Traffic packs should model route-affecting road state first as aggregate traffic conditions: congestion zones, blocked segments, slow corridors, and access restrictions.

Individual traffic vehicles may be added later as a detail layer, but aggregate traffic conditions are the preferred first operational object because they are cheaper to render, easier for operators to understand, and easier for AI agents to reason over.

Traffic conditions may create route impacts for mobile assets. They should not silently reroute assets unless a future control-instance policy explicitly enables automatic rerouting.

## Scenario, Mission, and Context Use

Packs may contribute reusable data and schemas used by scenarios:

- **Object Context contributions** may seed perspective-bearing awareness or provide pack-specific renderers for agent context views.
- **Provider metadata** declares which runtime providers a pack offers and which one is the default for ordinary scenarios.
- **Scenario support codecs** may expand compact scenario object specs and operations into full validated `OperationalObject`s. These codecs belong to packs because packs own their `domainData`, object defaults, and domain vocabulary.

Packs must keep boundaries clear:

- `domainData` is pack-owned domain operational truth.
- `context` is perspective-bearing awareness.
- mission progress is runtime state owned by Leitbild, not static pack data.
- scenarios are top-level compositions that list active packs; they are not owned by one pack.
- provider ids are internal runtime wiring. Scenario APIs should expose `packs`, not low-level provider ids, unless a debug/runtime-detail endpoint explicitly asks for them.
- restored control instances use snapshots/history, not scenarios.
- object presentation decides whether revision changes are noteworthy for operator attention. Frequent motion updates should not become rail `new` badges; packs should enable noteworthy updates only for object types where a changed field is operationally meaningful.
- pack helpers may construct full `OperationalObject`s, but packs must not introduce a second production seed-object model beside Scenario Definitions.
- compact scenario files may name pack object specs, but the expanded Scenario Definition is still the runtime contract.
- multi-pack scenarios may override a pack's default provider and may provide provider config keyed by pack id. The Scenario Catalog resolves those pack-level choices into provider ids before the Simulation Hub starts providers.

## Trust Model

Code packs are trusted executable code. Installing one is equivalent to adding code to the Leitbild runtime.

Future installer work must make this explicit and validate:

- manifest schema
- namespace
- Leitbild version compatibility
- declared command kinds
- declared simulation providers
- declared UI contributions
- dependency and conflict metadata

Data-only scenario bundles may be introduced later for lower-risk distribution of scenarios, layouts, icons, and static map data.
