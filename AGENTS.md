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
- Keep pack-specific logic in `src/packs/*`; keep `core` use-case agnostic.
- Generic UI modules must consume pack presentation and creation protocols instead of importing pack-specific models, simulators, geometry helpers, or condition calculators.
- Shared spatial indexing belongs in `src/core/spatial/*`. The `h3-js` dependency may only be imported by the core spatial wrapper; packs and UI must consume Leitbild spatial interfaces instead of depending on H3 directly.
- Weather field computation belongs inside the weather pack. UI may request provider-projected map features through the pack query protocol, but must not import weather models, weather cell math, or weather condition calculators.
- Pack map-feature animation metadata is presentation-only. It can smooth rendered geometry and attached symbol anchors between provider query refreshes, but it must not become a simulation update path or a substitute for provider-owned truth.
- New Control Instances must start from a validated top-level Scenario Definition resolved through the Scenario Catalog. Do not add domain seed factories, hidden simulator defaults, pack-owned scenario files, or parallel startup formats.
- Scenario Definitions name active `packs`; provider ids are internal runtime wiring resolved from pack defaults or explicit scenario provider overrides.
- Scenario Definitions own initial UI assembly through a validated Surface Definition. Do not render hardcoded operational map/rail/footer surfaces before the scenario surface is loaded.
- Surface Definitions may configure only safe built-in primitives. Do not allow scenario JSON, AI output, or pack code to inject arbitrary Svelte components, HTML, scripts, or hidden fallback viewports.
- Built-in scenarios should be authored as compact declarative JSON Scenario Configs when practical, then expanded through pack-owned scenario codecs into full validated Scenario Definitions. Do not put reusable object-construction logic inside individual scenario files.
- Scenario Config expansion must stay deterministic and ordered. Do not parallelize object/action expansion when later specs may reference earlier created objects.
- Scenario scripts must stay declarative and must emit ordered domain events through the Control Instance runtime. Do not add browser-only scenario/tutorial state, simulator-private scenario timers, or arbitrary scenario code execution.
- Restored Control Instances must start from persisted snapshots/history, not by replaying or reapplying Scenario Definitions.
- Treat Control Instance Projected State as canonical current Leitbild truth. UI, API, AI agents, metrics, and interaction handlers must read shared operational state from the Control Instance projection.
- Treat the Durable Journal as meaningful accepted history, not as full current state and not as a high-frequency motion trace.
- Simulation providers may keep private mechanics and provider-local projections, but those are not canonical shared object state. Providers must rehydrate private runtime mechanics from canonical objects on connect; do not make the UI infer or drive simulator motion.
- Use the Simulation Hub for multiple providers in one Control Instance. Do not merge a new provider domain into an existing domain simulator just to get a short-term demo.
- Providers must declare accepted command kinds; do not rely on broad command broadcast as the long-term command-routing model.
- Provider-owned read models must be exposed through the generic pack query surface. Do not add domain-specific HTTP endpoint families such as `/api/weather/*`, `/api/traffic/*`, or `/api/ambulance/*` without a new ADR.
- Pack queries must be read-only. They must not issue commands, mutate provider state, emit events, or commit canonical changes.
- Keep `domainData` and `context` conceptually separate: `domainData` is pack-owned domain operational truth, while `context` is structured, perspective-bearing awareness for assets, operators, system processes, and AI agents.
- Do not store generated prompts, raw full event logs, or unbounded memory dumps in object `context`; derive bounded agent context views instead.
- Model cross-object and cross-simulation interaction through scoped interaction signals and registered handlers. Objects may be the source or subject of signals/events, but objects are data, not active executable actors.
- Interaction handlers must return constrained effects for the control-instance runtime to validate, order, persist, and broadcast. Handlers must not directly mutate shared state or call other objects.
- Providers observe committed domain events; do not add second authoritative mutation paths that mirror canonical object state into a simulator as if the simulator owned shared truth.
- Traffic conditions should first be aggregate zone/segment objects. Do not add individual traffic vehicles until a feature actually needs per-vehicle behavior and culling/performance rules are in place.
- Route impacts from traffic must be canonical and visible. Do not silently reroute a mobile asset without an explicit command or declared automation policy.
- Treat AI outputs as untrusted input: AI agents may issue commands or emit interaction signals, but only validated handlers and committed domain events can change canonical state.
- Treat the self-hosted vector map artifact as contextual data, not operational truth. Simulation providers and UI surfaces must discover map-context capabilities through `/map/capabilities.json` instead of hard-coding tile assumptions.
- Do not reintroduce raster OSM base maps or raster fallback paths. Leitbild's base map is vector-only.

## Svelte UI Rules

- Use Svelte 5 runes for new and actively migrated UI code.
- Use `$props` for component inputs, `$state` for local mutable UI state, `$derived` for derived UI state, and `$effect` only for synchronization with external systems, timers, browser APIs, network connections, or imperative libraries.
- Do not add new `export let`, `$:`, `on:`, deprecated `context="module"`, `<svelte:component>`, or slot-based APIs in migrated UI code unless there is a clear written reason.
- Use modern event attributes such as `onclick` in migrated components.
- Prefer snippets over slots for shared modal/composition components.
- Svelte state is client-local UI state only. Do not duplicate Control Instance Projected State into a second canonical UI store.
- Do not use raw `$effect` as an `onMount` substitute. Use `runOnMount` from `src/ui/svelte-lifecycle.svelte.ts` for mount-only browser listeners, intervals, map construction, WebSocket startup orchestration, and similar one-time external lifecycle setup.
- Keep MapLibre as an imperative boundary. Use Svelte effects to synchronize inputs to the map, not to make the map lifecycle itself a reactive data model.
- MapLibre resize is owned by observed map container geometry. Do not use rail state, modal state, startup state, arbitrary revision counters, or delayed activation frames to wake or resize the map.
- Pure TypeScript UI presenters/selectors are allowed when they concentrate real derivation logic and are tested. Delete them if they become pass-through wrappers.
- See `docs/adr/0012-svelte-5-ui-architecture.md` before changing UI state architecture.

## Map Rendering Rules

- Use MapLibre as Leitbild's base geospatial rendering engine.
- Use self-hosted PMTiles vector tiles as the only base map source. The base map style must load from `/map/style.json`; the tile source must load from `/map/tiles/current.pmtiles`.
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
- `bun run deploy` deploys to the Hetzner sandbox. It defaults to `root@178.104.229.113` and accepts `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_PORT`, and `HETZNER_BUN` overrides.

## Delivery Rule

- After completing code changes, push to `main` and deploy to `leitbild.samsinn.app` unless the user explicitly says not to.
