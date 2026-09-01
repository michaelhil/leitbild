# World Packs

A World **Pack** is one namespaced operational capability. Ambulance, weather,
traffic, drone, aviation, electric grid, and process plant are Packs. A Pack is
not a simulator and does not need a runtime: presentation-only, knowledge-only,
or scenario-only Packs are valid.

Packs are statically assembled in `src/app-assembly.ts`. Runtime installation or
remote Pack distribution is not part of the current architecture.

## Ownership

World core owns:

- Simulation Run identity, clocks, ordered events, snapshots, and recorded history
- actor-attributed command envelopes
- the canonical operational-object projection
- generic query, realtime-input, interaction, and UI routing

Each Pack owns:

- its schemas and private runtime state
- any scenario expansion and authoring metadata
- runtime adapters and their declared operations
- object presentation, creation, targeting, and contextual enrichment
- reference data, knowledge links, and interaction handlers

An operational object has exactly one owning `packId`. Cross-Pack behavior uses
committed events or interaction signals; it must not import and mutate another
Pack's private runtime state.

## Contributions

`WorldPack` contains optional, orthogonal contributions:

- `runtime`: available runtime implementations and a default
- `recording`: named, bounded observation profiles implemented by the Pack runtime
- `scenario`: compile Pack-owned source items and operations
- `authoring`: editable item metadata for the generic Scenario editor
- `presentation`: categories, object views, contextual fields, map areas, and layers
- `creation`: generic object-creation choices and command builders
- `targeting`: controller/target rules and command builders
- `interactions`: handlers activated only when the Pack is active
- `referenceData`: Pack-owned datasets
- `knowledge`: discoverable documentation

There is no composite or synthetic Pack. `ActivePackViews` is a read-only view
over the exact active Pack set. It routes object presentation and targeting to
the owning Pack and aggregates explicitly composable presentation and creation
metadata.

## Runtime lifecycle

1. Application assembly registers Packs and available runtime adapters.
2. Startup validation checks Pack/runtime ownership, versions, clocks,
   contributions, operation routes, categories, creation types, and handlers.
3. A Scenario Revision selects Packs and at most one runtime per active Pack.
   A Pack with no runtime remains active without inventing a no-op adapter.
4. Creating a Simulation Run compiles the exact Scenario Revision once and stores
   that resolved definition beside the immutable run manifest.
5. The Runtime Hub connects only selected adapters and closes already-connected
   adapters if startup is only partially successful.
6. Adapters emit Pack runtime events and, when selected, batches of described
   observations. The hub validates runtime and Pack identity; core orders,
   validates, commits, projects, publishes, and persists them.
7. Every committed batch is offered to every active runtime observer. Observer
   failures are isolated and reported rather than breaking the committed batch.
8. Closing the Run unsubscribes and closes every active adapter.

## Runtime contract

Every runtime declares:

- a globally unique dotted runtime id, Pack id, and semantic version
- `clock`: `simulation`, `live`, or `none`
- discoverable command, query, and realtime-input operation descriptors
- an explicit history policy for command lifecycle events when it differs from
  the default `record` policy

Runtime-origin state events always declare `history`:

- `record`: retain the meaningful event in the ordered journal
- `snapshot-only`: update current truth and snapshots without turning dense
  projections into journal noise

Core may still classify core-origin events as recorded or projected internally.
Pack runtimes must not depend on that internal persistence vocabulary.

Queries are read-only. Commands may mutate runtime state. Realtime inputs are
ephemeral control input. Each route has one active owner; ambiguous routes are a
startup error, never first-match dispatch.

The generic capabilities endpoint exposes the active Packs, runtimes and clock
modes, operations, and knowledge links. This is the primary discovery surface for
operators and agents inspecting a running World.

## UI boundary

Generic UI code consumes `ActivePackViews`; it does not import Pack models or
runtime algorithms. Pack-specific UI may import its Pack's presentation helpers,
but browser code never imports server adapters.

`presentObject` handles the owning Pack's object. `contextualFields` may enrich
another Pack's detail view, but must use indexed objects or a bounded query rather
than repeatedly scanning the entire Run. Runtime-owned spatial truth is exposed
through read-only map-feature queries and validated at the generic boundary.

## Adding a Pack

Keep one module under `src/packs/<pack-id>/` and add only the facets it needs.

1. Define and validate Pack-owned data.
2. Export one `WorldPack` with truthful contribution metadata.
3. If execution is needed, implement an adapter with clock and operation metadata.
4. Register the Pack and adapter in application assembly.
5. Add scenario authoring metadata only for editable source fields.
6. Test the Pack alone, in an active multi-Pack set, and across restore/close.

Do not add a no-op runtime, synthetic Pack, browser-owned truth, implicit route,
or fallback behavior merely to satisfy a generic interface.

## Historian boundary

Recording is optional and selected in the Scenario by Pack and Recording Profile.
The Pack owns the mapping from that stable profile name to its real runtime signals;
core never reaches into Pack-private state. The runtime emits typed series
descriptors and batched samples beside its normal events. The Run Historian stores
those observations in one Run-local SQLite database and exposes bounded discovery
and query operations.

The ordered JSONL journal remains the record of meaningful committed events.
Historian samples are analytical observations, not canonical current state and not
a second event stream. Runtime checkpoints contain only restart state, never time
series. There is deliberately no generic recording-rule language, automatic
capture of every private variable, or Workspace-wide database.
