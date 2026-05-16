# Leitbild Packs

A **Leitbild Pack** is a namespaced bundle of operational-domain capability.

Leitbild itself owns control instances, actors, roles, command envelopes, event ordering, state projection, map rendering, persistence, audit logs, metrics, and AI integration boundaries. Packs contribute domain-specific behavior behind those core seams.

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
- simulation adapters or local simulation engines
- scenario definitions, mission definitions, and run configurations
- object icons, map symbols, and style rules
- object categories, summaries, hover details, and inspectors
- command/action builders for UI controls
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
  scenarios/
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
  "description": "Ambulance dispatch domain, local simulator, scenarios, and UI.",
  "contributes": {
    "domains": ["ambulance_dispatch"],
    "objectTypes": ["ambulance", "hospital", "incident", "patient"],
    "commands": [
      "ambulance.create_object",
      "ambulance.set_destination",
      "ambulance.cancel_destination"
    ],
    "simulationAdapters": ["ambulance.local"],
    "scenarios": ["oslo-basic"],
    "missions": ["oslo-response-basic"],
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
- scenario: `ambulance/oslo-basic`
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
- Packs publish events through Leitbild seams.
- Packs issue changes to other domains only through declared commands/events.

Multi-pack simulation orchestration is deferred until there are at least two real domain packs.

## Scenario, Mission, and Context Contributions

Packs may contribute reusable data and schemas:

- **Scenario Definitions** initialize world settings, operational objects, initial object contexts, and simulator configuration.
- **Mission Definitions** describe goals, objectives, tasks, stages, triggers, actions, and evaluation metrics.
- **Object Context contributions** may seed perspective-bearing awareness or provide pack-specific renderers for agent context views.

Packs must keep boundaries clear:

- `domainData` is pack-owned domain operational truth.
- `context` is perspective-bearing awareness.
- mission progress is runtime state owned by Leitbild, not static pack data.

## Trust Model

Code packs are trusted executable code. Installing one is equivalent to adding code to the Leitbild runtime.

Future installer work must make this explicit and validate:

- manifest schema
- namespace
- Leitbild version compatibility
- declared command kinds
- declared scenarios
- declared UI contributions
- dependency and conflict metadata

Data-only packs may be introduced later for lower-risk distribution of scenarios, layouts, icons, and static map data.
