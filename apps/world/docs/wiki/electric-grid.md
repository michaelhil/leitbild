# Electric Grid Pack

The Electric Grid Pack models electrical networks inside World. It keeps the shared World state compact while exposing the detailed network for operator UI, AI discovery, control, recording, and later cross-Pack coupling.

## Domain shape

A Scenario contains a `grid` item. The item selects exactly three reusable definitions:

- a **Grid Model**: topology, stable Grid Assets, electrical parameters, provenance, and connection points;
- an **Operating Point**: initial load, generation, and storage conditions;
- an **Automation Definition**: automatic load profiles, storage frequency response, and load shedding.

Compilation produces one Grid Operational Object. Buses, branches, generators, loads, and storage are private **Grid Assets**, not hundreds of top-level World objects. They retain stable ids and remain discoverable through Pack queries and controllable through Pack commands.

This is deliberately similar to Process Plant at the lifecycle boundary—Model, Operating Point, Automation, one operational system—but the Pack does not force electrical and process internals into a universal component graph.

## Scenario example

```json
{
  "id": "electric-grid",
  "config": {},
  "items": [{
    "type": "grid",
    "id": "grid:norway",
    "label": "Norway transmission grid",
    "location": [15.5, 64.7],
    "model": {
      "ref": "electric-grid.norway.transmission"
    },
    "operatingPoint": {
      "ref": "electric-grid.norway.normal"
    },
    "automation": {
      "ref": "electric-grid.norway.standard"
    }
  }]
}
```

Pack config is intentionally empty. Model choices belong to each Grid item, so a Scenario can contain multiple independently configured Grids.

## Lifecycle

1. Scenario compilation validates the item and creates one initializing Grid object.
2. Runtime connection lazily loads the selected Grid Model and compiles indexed private state.
3. The Operating Point initializes load schedules, generator targets, storage charge, and switching state.
4. The solver advances on Simulation Run time and updates private Grid Assets.
5. A thresholded health projection updates the Grid object; detailed state stays behind queries.
6. Commands address exactly one Grid object and one explicit Grid Asset id.
7. Private authoritative state is checkpointed by Grid id and an exact digest of the resolved Model, Operating Point, and Automation.
8. Optional recording profiles publish selected historian series.

Topology islands and their linear power-flow factors are cached. They are rebuilt only when branch topology changes. Normal ticks reuse the factorization and update injections, dispatch, frequency, voltage, load service, branch flow, and storage energy.

## Discovery API

The runtime publishes self-describing operation descriptors with input and output schemas derived from the same validation schemas used at execution time.

Queries:

- `electric-grid.catalog.list` — available definitions and running Grids;
- `electric-grid.grid.summary` — bounded system health, counts, and leading operational concerns;
- `electric-grid.assets.search` — paginated search with live status, concise summaries, map targets, and currently applicable operations;
- `electric-grid.asset.get` — one asset’s definition, provenance, location, and state;
- `electric-grid.power-flow.snapshot` — paginated branch state;
- `electric-grid.connection-points.list` — typed coupling boundaries.

Every asset query except the catalog requires a `gridId`. Commands target exactly one Grid Operational Object and include an `assetId` in their payload. The runtime rejects unknown Grids, assets, command kinds, and malformed payloads instead of choosing an implicit first match.

Commands cover generator dispatch, trip, availability and explicit return-to-service; branch open, close, and availability derating; controllable load shed/restore; and EV charging demand. Availability changes do not silently reset generator lifecycle state, and branch derating is independent of open/closed topology state.

## Shared projection

The Grid object publishes only operator-level health:

- frequency and nominal frequency;
- generation, demand, served and unserved load;
- reserve margin;
- highest branch loading and lowest voltage;
- island and alarm counts;
- status, summary, tick, and update time.

The Norway Scenario therefore projects one small object instead of hundreds of frequently changing asset objects. The lazily loaded Grid operations panel obtains bounded detail through the query API. Its Assets view groups substations/buses, lines and transformers, generation, consumers, and storage; it polls only the visible page and selected detail.

## Reference map versus operational model

The `grid-norway` reference dataset owns detailed map geometry and map provenance. The operational Grid Model owns the reduced electrical graph and parameters. They are intentionally separate:

- map geometry can remain visually detailed without increasing solver cost;
- solver topology can be reduced or parameterized without duplicating line paths in runtime state;
- a map-data rebuild does not silently redefine a running electrical model.

The browser presentation Pack does not import the operational Norway Model. The server loads that Model only when an active Simulation Run actually contains a Grid.

## Norway Model source build

The checked-in generated source artifact contains the reduced transmission Model inputs. It omits line paths and unused repeated metadata because those belong to the reference dataset.

Regenerate it from an explicit reference GeoJSON input:

```sh
bun run scripts/electric-grid/build-norway-grid-model.ts \
  data/reference-local/builds/grid-norway/<build>/grid-norway.features.geojson \
  src/packs/electric-grid/models/norway-source-data.generated.ts
```

The builder fetches both required NVE generation datasets and fails if either request fails. It never reads a previous generated output as a hidden fallback.

## Recording

The `operations` profile records bounded Grid-level frequency, balance, reserve, voltage, loading, supply, and alarm series. The opt-in `engineering` profile adds per-bus, branch, generator, load, and storage series at a slower minimum cadence. This uses the shared Historian contract; the Pack does not implement a separate logging subsystem.

## Cross-Pack readiness

Grid Models may expose typed electrical connection points with a bus, direction, voltage, and MW limit. Runtime discovery adds current exchange, available capacity, voltage, and energized state. This is enough to discover possible Plant or future Pack connections without hard-coding another Pack into Electric Grid.

The Pack does not yet implement a generic binding engine or co-simulation scheduler. Those should be introduced only from a concrete Grid–Plant coupling, after its timing, ownership, failure, and unit-conversion requirements are known.

## Current numerical boundary

The solver is an operational DC-style network model with simplified voltage and aggregate frequency dynamics. Each Grid Model publishes this fidelity and a recommended bus-count ceiling. Strict Model compilation validates identity, references, ranges, connection points, and topology diagnostics, then builds immutable indexes reused by queries, commands, and the solver. It is suitable for Leitbild operational scenarios, not protection-grade transient or commercial load-flow studies.
