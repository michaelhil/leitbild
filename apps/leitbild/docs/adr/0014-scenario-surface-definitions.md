# ADR 0014: Scenario Surface Definitions

## Status

Accepted.

## Context

Leitbild is moving toward control instances that are assembled from scenario definitions rather than hardcoded domain defaults. During startup, the client previously rendered an Oslo-centered map and ambulance/traffic rail before the scenario was fully loaded. That made the product look initialized even when the actual scenario surface had not been resolved, and it would fail badly for scenarios that do not want a map, want a different initial viewport, or want different rail categories.

We need the scenario to own initial UI assembly without turning scenario files into executable UI code.

## Decision

`ScenarioDefinition` includes a required `surface` field. A `SurfaceDefinition` is validated data with a schema version and a list of configured safe primitives.

V1 primitives:

- `map`: MapLibre surface with explicit center, zoom, and enabled layer groups.
- `objectRail`: left rail with explicit category order, visibility, collapsed state, and visible field keys.
- `systemFooter`: Leitbild status/version/theme/reset footer.
- `guidanceOverlay`: scenario-owned onboarding or instruction overlay.

The client starts from a neutral boot shell. It fetches the scenario definition after joining the control instance and renders only the surface primitives declared by that scenario. A visible map primitive must provide an explicit center and zoom; hidden default viewports are rejected. Object rail sections must reference categories provided by active packs.

Surface definitions are not component registries for arbitrary scenario code. They configure reviewed primitives only.

## Consequences

- Scenarios can start from a true blank slate and assemble map/rail/guidance/footer intentionally.
- Non-map scenarios or specialized surfaces become possible without carrying a hidden map dependency.
- Invalid scenario UI configuration fails at startup instead of silently producing partial UI.
- Pack category vocabulary remains pack-owned, but scenario composition owns which categories appear on a surface.
- Future adaptive UI work can build on this safe primitive layer instead of jumping straight to generated Svelte code.

## Rejected Alternatives

- **Keep hardcoded UI defaults in the client**: easy now, but it hides scenario errors and bakes the current ambulance demo into the platform.
- **Let packs own whole UI surfaces**: convenient for single-domain demos, but poor for multi-pack scenarios and shared control-center layouts.
- **Allow scenario files to import/render arbitrary components**: powerful, but unsafe, hard to validate, hard to test, and too close to a plugin system before the primitive contract is stable.
- **Use fallbacks for missing map center/zoom**: masks authoring errors. A scenario that requests a map must explicitly declare its viewport.
