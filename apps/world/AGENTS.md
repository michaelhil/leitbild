# Leitbild Agent Instructions

## Project Guardrails

- Use TypeScript for all source code.
- Do not create JavaScript files unless the user explicitly approves.
- Use Bun 1.4.0 for package management, scripts, tests, and local/production runtime.
- Maintain exactly one main HTTP server at `src/core/api/server.ts`.
- Keep runtime mechanics conceptually separate from Leitbild core. Local runtimes must use the same adapter boundary as remote runtimes.
- Validate external input at trust boundaries: HTTP, WebSocket, runtime feeds, file imports, AI-generated dashboard specs, and generated code.
- Scope real-time broadcasts by simulation run. Never broadcast events globally unless the event is explicitly global.
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
- Generic UI modules must consume pack presentation and creation protocols instead of importing pack-specific models, runtimes, geometry helpers, or condition calculators.
- Shared spatial indexing belongs in `src/core/spatial/*`. The `h3-js` dependency may only be imported by the core spatial wrapper; packs and UI must consume Leitbild spatial interfaces instead of depending on H3 directly.
- Weather field computation belongs inside the weather pack. UI may request runtime-projected map features through the pack query protocol, but must not import weather models, weather cell math, or weather condition calculators.
- Pack map-feature animation metadata is presentation-only. It can smooth rendered geometry and attached symbol anchors between runtime query refreshes, but it must not become a simulation update path or a substitute for runtime-owned truth.
- New Simulation Runs must start from a validated top-level Scenario Definition resolved through the Scenario Catalog. Do not add pack seed factories, hidden runtime defaults, pack-owned scenario files, or parallel startup formats.
- Scenario Definitions name active `packs`; runtime ids are internal wiring resolved from pack defaults or explicit scenario runtime overrides.
- Scenario Definitions own initial UI assembly through a validated Surface Definition. Do not render hardcoded operational map/rail/footer surfaces before the scenario surface is loaded.
- Surface Definitions may configure only safe built-in primitives. Do not allow scenario JSON, AI output, or pack code to inject arbitrary Svelte components, HTML, scripts, or hidden fallback viewports.
- Built-in scenarios should be authored as compact declarative JSON Scenario Configs when practical, then expanded through pack-owned scenario codecs into full validated Scenario Definitions. Do not put reusable object-construction logic inside individual scenario files.
- Scenario Config expansion must stay deterministic and ordered. Do not parallelize object/action expansion when later specs may reference earlier created objects.
- Scenario scripts must stay declarative and must emit ordered Simulation Run events through the Simulation Run runtime. Do not add browser-only scenario/tutorial state, runtime-private scenario timers, or arbitrary scenario code execution.
- Restored Simulation Runs must start from persisted snapshots/history, not by replaying or reapplying Scenario Definitions.
- Treat Simulation Run Projected State as canonical current Leitbild truth. UI, API, AI agents, metrics, and interaction handlers must read shared operational state from the Simulation Run projection.
- Treat the Durable Journal as meaningful accepted history, not as full current state and not as a high-frequency motion trace.
- Pack runtimes may keep private mechanics and runtime-local projections, but those are not canonical shared object state. Runtimes must rehydrate private mechanics from canonical objects on connect; do not make the UI infer or drive runtime motion.
- Use the Runtime Hub for multiple pack runtimes in one Simulation Run. Do not merge a new pack runtime into an existing pack runtime just to get a short-term demo.
- Pack runtimes must declare accepted command kinds; do not rely on broad command broadcast as the long-term command-routing model.
- Runtime-owned read models must be exposed through the generic pack query surface. Do not add pack-specific HTTP endpoint families such as `/api/weather/*`, `/api/traffic/*`, or `/api/ambulance/*` without a new ADR.
- Pack queries must be read-only. They must not issue commands, mutate runtime state, emit events, or commit canonical changes.
- Process-control packs such as `process-plant` must keep continuous physics inside the pack-owned runtime. Use validated component graphs, typed ports, compiled runtime indices, pack queries, and discrete Simulation Run events; do not turn internal process variables into `OperationalObject`s or use event messages as the continuous physics solver.
- Process-plant signal bindings are graph-owned metadata. Use `tagId` plus explicit `systemId`; do not reintroduce `sensorId`, `actuatorId`, implicit current-unit lookup, fleet-wide aliases, or separate binding catalogs without an ADR.
- Process-plant variable capabilities and limits belong on variable descriptors and compiled signal bindings. Derive defaults from `writable`, `publish`, and `tagId`; add explicit overrides only when they carry operational value. Do not add arbitrary hard ranges to generic variables.
- Process-plant control/protection rules must be typed declarative data evaluated by the pack runtime. Treat this as a simplified plant I&C substrate above continuous physics: instrumentation signals, normal controllers, protection functions, alarms, structured annunciator metadata, mode-qualified rules, permissives, interlocks, and validated actions. Do not add arbitrary expression languages, generated procedure code, global mode stores, or mid-solver mutation.
- Process-plant I&C lifecycle actions are alarm/trip lifecycle state operations only. They must not mutate process variables, execute emergency procedures, or become a hidden control path.
- Process-plant procedures remain external for now. Procedure runners, operators, and AI agents may query signal values and condition truth through pack queries and may issue validated commands, but process-plant must not become an embedded emergency procedure engine.
- Process-plant alarms are persistent current state plus transition events. Do not model alarms only as transient interaction events or clear them merely because they were acknowledged.
- Process-plant automatic actions from normal control or protection must flow through the same validated queued write path as operator, scenario, and AI commands. Do not create a privileged mutation path that bypasses writability, limits, type checks, or solver phase boundaries.
- Process system topology is scenario-owned config/data. Keep reusable component definitions and solver behavior in code, but do not make hardcoded TypeScript plant graphs the canonical runtime source of truth.
- Keep `packData` and `context` conceptually separate: `packData` is pack-owned operational truth, while `context` is structured, perspective-bearing awareness for assets, operators, system processes, and AI agents.
- Do not store generated prompts, raw full event logs, or unbounded memory dumps in object `context`; derive bounded agent context views instead.
- Model cross-object and cross-runtime interaction through scoped interaction signals and registered handlers. Objects may be the source or subject of signals/events, but objects are data, not active executable actors.
- Interaction handlers must return constrained effects for the simulation-run runtime to validate, order, persist, and broadcast. Handlers must not directly mutate shared state or call other objects.
- Pack runtimes observe committed Simulation Run events; do not add second authoritative mutation paths that mirror canonical object state into a runtime as if the runtime owned shared truth.
- Traffic conditions should first be aggregate zone/segment objects. Do not add individual traffic vehicles until a feature actually needs per-vehicle behavior and culling/performance rules are in place.
- Route impacts from traffic must be canonical and visible. Do not silently reroute a mobile asset without an explicit command or declared automation policy.
- Treat AI outputs as untrusted input: AI agents may issue commands or emit interaction signals, but only validated handlers and committed Simulation Run events can change canonical state.
- Treat the self-hosted vector map artifact as contextual data, not operational truth. Pack runtimes and UI surfaces must discover map-context capabilities through `/map/capabilities.json` instead of hard-coding tile assumptions.
- Do not reintroduce raster OSM base maps or raster fallback paths. Leitbild's base map is vector-only.

## Svelte UI Rules

- Use Svelte 5 runes for new and actively migrated UI code.
- Use `$props` for component inputs, `$state` for local mutable UI state, `$derived` for derived UI state, and `$effect` only for synchronization with external systems, timers, browser APIs, network connections, or imperative libraries.
- Do not add new `export let`, `$:`, `on:`, deprecated `context="module"`, `<svelte:component>`, or slot-based APIs in migrated UI code unless there is a clear written reason.
- Use modern event attributes such as `onclick` in migrated components.
- Prefer snippets over slots for shared modal/composition components.
- Svelte state is client-local UI state only. Do not duplicate Simulation Run Projected State into a second canonical UI store.
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
- `bun run deploy` validates, packages, and deploys an immutable code-only release through the configured `ssh leitbild` alias. Use `--test <path>` for relevant tests or `--full` for all tests. It never publishes map/reference/OSRM artifacts.

## Delivery Rule

- After completing code changes, deploy from the local worktree to `leitbild.leitbild.app` unless the user explicitly says not to. Commit logical changes locally; push `main` to GitHub at useful backup/milestone points rather than as a deployment prerequisite.
