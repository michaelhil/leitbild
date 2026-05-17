# Leitbild Agent Instructions

## Project Guardrails

- Use TypeScript for all source code.
- Do not create JavaScript files unless the user explicitly approves.
- Use Bun for package management, scripts, tests, and local runtime.
- Maintain exactly one main HTTP server at `src/core/api/server.ts`.
- Keep simulation conceptually separate from Leitbild core. Local simulators must use the same adapter boundary as remote simulators.
- Validate external input at trust boundaries: HTTP, WebSocket, simulation feeds, file imports, AI-generated dashboard specs, and generated code.
- Scope real-time broadcasts by control instance. Never broadcast events globally unless the event is explicitly global.
- Avoid silent fallbacks, silent skips, empty catches, or unexplained defaulting when failure should be visible.

## No Mock Or Dummy Functionality

- Never add mock, dummy, placeholder, fake, stubbed, or simulated production functionality as a shortcut.
- Test doubles are allowed only in tests, and must be clearly confined to test files.
- Production paths must either be real, deliberately minimal but functional, or absent.
- If a capability is not ready, expose it as unsupported with an explicit error or leave it out of the product surface.
- Do not add TODO-driven placeholder implementations that future work must replace.

## Architecture Preferences

- Prefer functional modules, factory functions, explicit interfaces, and immutable configuration.
- Avoid classes unless there is a strong technical reason.
- Use async/await instead of `.then()` or `.catch()` chains.
- Keep files and functions small enough to remain navigable.
- Add abstractions only when they protect a real boundary or remove real complexity.
- Keep domain-specific logic in domain modules; keep `core` use-case agnostic.
- Treat the Control Instance event log and projected state as canonical Leitbild truth. UI, API, AI agents, replay, metrics, and interaction handlers must read shared operational state from the Control Instance projection.
- Simulation providers may keep private mechanics and provider-local projections, but those are not canonical shared object state.
- Keep `domainData` and `context` conceptually separate: `domainData` is pack-owned domain operational truth, while `context` is structured, perspective-bearing awareness for assets, operators, system processes, and AI agents.
- Do not store generated prompts, raw full event logs, or unbounded memory dumps in object `context`; derive bounded agent context views instead.
- Model cross-object and cross-simulation interaction through scoped interaction signals and registered handlers. Objects may be the source or subject of signals/events, but objects are data, not active executable actors.
- Interaction handlers must return constrained effects for the control-instance runtime to validate, order, persist, and broadcast. Handlers must not directly mutate shared state or call other objects.
- Providers observe committed domain events; do not add second authoritative mutation paths that mirror canonical object state into a simulator as if the simulator owned shared truth.
- Treat AI outputs as untrusted input: AI agents may issue commands or emit interaction signals, but only validated handlers and committed domain events can change canonical state.

## Map Rendering Rules

- Use MapLibre as Leitbild's base geospatial rendering engine.
- Render geospatial truth with native MapLibre sources/layers: entity positions, routes, trails, zones, uncertainty geometry, alert areas, selection halos, and large-fleet views.
- Do not use MapLibre DOM markers for core object rendering; DOM marker anchoring can drift from the true projected coordinate across zoom levels.
- Use Lucide-style SVG artwork only as MapLibre-native registered images/symbols, not as free-floating marker DOM.
- Use Svelte/HTML overlays for rich operational UI: hover cards, selected object panels, ECG/vitals mini-trends, command menus, adaptive UI widgets, and pinned callouts.
- Object-attached rich overlays must be positioned by a controlled overlay manager using object id, object lon/lat, and `map.project([lon, lat])`; update overlays on object changes, map move/zoom/resize, and cull when off-screen or too dense.
- Keep rich overlays sparse: selected, hovered, pinned, high-priority, or scenario-condition-specific objects. Native layers carry the fleet.
- Maintain explicit map layer ordering: base map, routes/trails/zones, object halos, object icons, new-info indicators, then popups/HTML overlays.

## Commands

- `bun test` runs tests.
- `bun run check` should run type checking once configured.
- `bun run health` should run project health checks once configured.
