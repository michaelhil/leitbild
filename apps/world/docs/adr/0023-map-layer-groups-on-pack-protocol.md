# ADR 0023: Map Layer Groups On The Pack Protocol

## Status

Accepted.

## Context

Phase A's airspace UI rendered a free-floating `MapLayersPanel` overlay top-right of the map. The panel offered one toggle per airspace category (17 categories: FIR, UIR, CTA, TMA, …). Two problems:

1. The panel lives outside the pack rail, breaking the established UX where every domain renders its controls inside the rail and activates on scenario opt-in.
2. The panel has no mechanism by which a pack contributes its layer-toggle UI to the rail.

The control rail today is built around object-grouped categories: each rail section corresponds to a category of operational objects (Ambulances, Hospitals, Weather conditions). The rail renders one row per object plus an "eye" icon per visible-field. This model fits domains where the user clicks individual objects but does not fit a domain where the user wants to toggle whole groups of map layers (e.g., "show or hide all airspace").

## Decision

Packs may contribute one additional rail control surface: a list of map-layer groups. The rail renders these as a small section, separate from the object-grouped sections, with a single toggle per group.

### Protocol change

```ts
// src/core/packs/protocol.ts

export interface PackMapLayerGroup {
  /** Stable id used in storage keys and command payloads. */
  readonly id: string
  /** Operator-facing label rendered in the rail. */
  readonly label: string
  /** Initial visibility state. The rail and persistent storage may override. */
  readonly defaultVisible: boolean
  /**
   * MapLibre layer-id pattern. Glob style: '*' matches a single ':'-separated
   * segment. Example: 'reference:aero-norway:*:*' matches all four-segment
   * reference-data layers belonging to the aero-norway dataset.
   */
  readonly layerIdPattern: string
}

export interface WorldPack {
  // ...existing fields...
  readonly mapLayerGroups?: ReadonlyArray<PackMapLayerGroup>
}
```

### Rail rendering

When the control rail builds its content for an active Scenario, it iterates the active Packs. For each Pack with `mapLayerGroups?.length > 0`, the rail appends a section beneath that Pack's object-grouped sections. Each group renders as a checkbox row labelled by `label`, with persistent visibility state keyed by Simulation Run (`leitbild:layers:<datasetOrPackId>:<simulationRunId>`).

### Wiring to the map

A pack-driven visibility controller subscribes to rail toggle events. On toggle, it expands `layerIdPattern` against the currently-registered MapLibre layer ids and calls `map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')` for each match.

The controller is constructed once when the map style finishes loading, the same lifecycle hook that previously created the standalone `MapLayersPanel` controller. It is destroyed when the map is torn down.

### Source picker (separate but adjacent)

The aviation pack's source picker (OpenSky vs VATSIM) is a *different* surface — it dispatches a command (`aviation.set_source`), not a visibility toggle. It does not pass through this protocol. The aviation pack contributes it via its own rail-section renderer alongside the `mapLayerGroups` toggles. Future packs that don't have a source picker do not see one.

### Scenario-side overrides

A scenario may pin or override the default visibility of any group by writing:

```json
{
  "surface": {
    "regions": [
      {
        "id": "left-rail",
        "primitive": "objectRail",
        "config": {
          "packLayerGroupVisibility": {
            "aviation:airspace": false,
            "aviation:airports": true
          }
        }
      }
    ]
  }
}
```

The rail seeds initial state from `packLayerGroupVisibility` if present, otherwise from `defaultVisible` on each group. User toggles overwrite the seed and persist in `localStorage` per Simulation Run.

## Consequences

- **Strict optional contribution.** Packs either declare a valid `mapLayerGroups` contribution or omit it; malformed declarations fail validation.
- **No DOM event coupling.** The presenter / state module is pure TypeScript and unit-testable (matches existing presenter pattern in `control-rail-presenter.ts`).
- **Layer-id pattern matching** uses a small glob matcher (`*` matches one segment between colons). 6–8 LOC + 5 tests. Avoids pulling in a glob library.
- **Per-category granularity below a group** (e.g., toggle just CTA inside Airspace) is *not* exposed in the rail in v1. Scenario authors can pre-configure per-category visibility through the reference-data style module's `categories` array. Rail UI for per-category granularity is a future enhancement only if operators ask for it.
- **The standalone `MapLayersPanel` was removed.** Visibility flows through Pack-owned layer groups.

## Test plan

- Unit tests for the glob matcher (`reference:aero-norway:*:*` matches `reference:aero-norway:tma:fill` but not `reference:other:tma:fill`).
- Presenter tests for rail-section state (initial → toggle → bulk apply → persist).
- Integration test: a fake pack with `mapLayerGroups` plus a fake `MapLibreMap` shows expected `setLayoutProperty` calls.
- Existing `svelte-lifecycle-policy` test must continue to pass — no new `$effect` patterns that violate it.
