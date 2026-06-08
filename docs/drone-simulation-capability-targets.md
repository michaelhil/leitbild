# Drone Simulation Capability Targets

## Requirement Restatement

Leitbild needs a brand-new drone capability, independent of the existing aviation and airspace functionality. The first implementation should be a real pack-owned simulation capability, not a one-off demo. It must support single drones, multiple human pilots, drone swarms, map display, Three.js flight views, configurable drone types, asset interaction, and reusable mission semantics.

Required user-facing capabilities:

- Create and run drone scenarios without importing or depending on the aviation pack.
- Fly drones in a shared Leitbild control instance from one browser or multiple remote browsers.
- Support keyboard control and browser Gamepad API control, including Bluetooth Xbox-style controllers on Windows and macOS where the browser exposes them.
- Allow multiple controllers and pilots in one browser window, and multiple users from different machines, with each drone remaining an individually simulated entity.
- Show drones on the operational map and in one or more Three.js modals.
- Support 2D tactical and 3D flight views in the drone modal.
- Generate a recognizable 3D environment procedurally from the map and current objects, without pre-rendered scenes.
- Render non-drone assets such as ambulances in the 3D world.
- Model drones as real entities with per-drone state, capability profiles, energy, sensors, payloads, control mode, and damage state.
- Support configurable drone roles such as attack, supply, and surveillance without hard-coding those as the only possible types.
- Provide an editor for drone type/capability configuration.
- Support attack drones that can damage or destroy ambulances, other drones, or other assets through validated commands and runtime interaction rules.
- Support swarm configuration and command: assign formations, destinations, patrol/search behavior, and manual takeover of individual drones.
- Keep swarm members as individual objects; no fake visual-only clone clouds.
- Support manual takeover from map commands or by opening a 3D direct-control window.
- Define a mission model that reuses Leitbild's existing generic mission/scenario concepts where possible and extends only where reusable.
- Produce a complete drone ops wiki/LLM handbook when the capability is closed out.

Engineering requirements:

- TypeScript only; no JavaScript files.
- Bun for scripts, tests, and dependency management.
- No new HTTP server. All remote multiplayer behavior must use the existing Control Instance API and realtime path.
- Keep pack-specific logic in `src/packs/drone`.
- Do not depend on `src/packs/aviation`.
- Keep continuous drone mechanics inside the drone pack runtime.
- Validate external input at HTTP/realtime/command/scenario/query boundaries.
- Avoid silent fallbacks and hidden defaults when invalid config or commands should be visible.
- Prefer generic, composable config data over hard-coded demo behavior.
- Avoid over-engineering: add abstractions only where they protect a real boundary or have a second clear caller.

## Architecture Decision

Use one new pack first: `drone`.

Reasoning:

- Flight dynamics, swarm behavior, drone configuration, control input, sensors, payloads, and drone-specific interactions form one cohesive domain.
- Splitting immediately into `drone`, `swarm`, `uas-control`, and `mission` packs would add coordination overhead before there are stable internal boundaries.
- Generic mission concepts should stay in core and existing mission definitions; drone-specific execution of a swarm or flight task belongs in the drone runtime.
- Future extraction remains possible if another pack later needs the same generic capability, such as robot swarms, maritime vehicles, or ground robots.

The pack will expose:

- Drone object categories and presentation.
- Create-object types for drones and optional target zones.
- Scenario expansion for drone profiles, initial drones, teams, and swarm definitions.
- Runtime command handling for manual control, navigation, landing, hold, capability profile edits, swarm tasking, and attack/interact actions.
- Runtime queries for drone world snapshots, controller bindings, capability catalog, and 3D scene projections.
- Map area feature queries for sensor footprints, commanded search zones, formation envelopes, and engagement ranges.

The runtime will own:

- Fixed-step drone mechanics.
- Control-mode arbitration between manual, guided, mission, swarm, land, hold, disabled, and destroyed.
- Simplified but credible cascaded control approximation: command input -> desired velocity/altitude/yaw or attitude -> rate-limited acceleration -> position/energy update.
- Battery and payload mass effects.
- Sensor/contact read models.
- Damage and interaction rules.
- Swarm steering per drone, using leader/follower, formation offsets, separation, cohesion, and goal seeking as configurable rules.

The UI will own:

- Gamepad and keyboard sampling only.
- Mapping browser inputs to validated drone commands.
- Three.js rendering of the current drone world snapshot.
- Drone profile editing through validated commands.

## Research Anchors

The implementation should be an approximation inspired by published/open systems, not a certified autopilot:

- PX4 multicopter controllers use cascaded position, velocity, attitude, and angular-rate loops with saturation, anti-windup, thrust limits, and mode-dependent bypasses.
- ArduPilot Copter separates modes such as Stabilize, Alt Hold, Loiter, Guided, Auto, RTL, and Land, and its Auto mode follows waypoint missions with acceleration-limited path shaping.
- MAVLink mission plans distinguish navigation waypoints and action commands.
- Browser controller input should use `navigator.getGamepads()` plus `gamepadconnected` and `gamepaddisconnected`.
- Swarm steering should start with transparent, tunable local rules: separation, alignment, cohesion, goal seeking, and formation offsets, with consensus/leader-follower concepts added where mission behavior needs them.
- Three.js should be used as the rendering engine for the flight modal.

## Pass Plan

### Pass 1: Domain Contract

- Add `src/packs/drone/model.ts` with Zod schemas and TypeScript types.
- Define drone profile, airframe, dynamics, battery, payload, sensor, weapon/effect, control state, mission state, swarm state, and damage state.
- Add command kinds and payload schemas.
- Add scenario expansion helpers for drone profiles and initial drones.
- Add unit tests for schema validation and scenario expansion.

Acceptance target:

- Drone pack data is fully validated.
- Profiles are config-driven; attack/supply/surveillance are example profiles, not hard-coded type limits.
- No aviation imports.

### Pass 2: Runtime Mechanics

- Add a local drone runtime adapter.
- Implement fixed-step simulation with projected object updates.
- Support manual axis commands, hold, land, navigate-to, profile update, and attack command validation.
- Maintain runtime-private control input expiry so remote/manual commands degrade safely.
- Publish per-drone telemetry/state at a bounded update cadence.
- Add tests for manual flight, command rejection, battery drain, land/hold, and multi-drone isolation.

Acceptance target:

- Multiple drones move independently under runtime control.
- Command effects are visible to all clients through normal Control Instance state.
- Runtime does not mutate unrelated pack state except through explicit interaction effects or validated object events.

### Pass 3: Registration And Scenario

- Register the drone pack in app assembly, UI pack loader, runtime adapter list, and built-in scenarios.
- Add a drone demo scenario with ambulances plus drones to verify cross-pack visibility and interactions.
- Add map presentation and map area features for footprints/ranges.
- Add tests for pack registration, scenario catalog loading, and no dependency on aviation.

Acceptance target:

- A drone scenario starts from the normal scenario picker.
- Drones and ambulances coexist in one control instance.

### Pass 4: Control UI

- Add a drone control modal with keyboard and Gamepad API input.
- Support multiple open control windows, each bound to a drone.
- Add a drone profile editor modal that sends validated profile update commands.
- Keep browser input as a UI concern; runtime remains authoritative.

Acceptance target:

- Keyboard flight works in-browser.
- Gamepads are discoverable and bindable when exposed by the browser.
- Multiple windows can control different drones without shared local state collisions.

### Pass 5: Three.js World

- Add Three.js dependency through Bun.
- Build a reusable drone-world scene module.
- Generate map-derived ground, roads, road labels, water, shorelines, landcover, landuse, buildings, aeroway context, place labels, and POI anchors from the self-hosted vector map artifact and current object context.
- Render drones, ambulances, targets, formation/sensor/weapon affordances, and camera modes.
- Support 2D top-down and 3D chase/first-person modes.
- Add rendering lifecycle cleanup and resize handling.

Acceptance target:

- The modal has nonblank, moving, inspectable Three.js output.
- Environment generation is deterministic from current map/object state and does not rely on pre-rendered assets.

### Pass 6: Swarms And Missions

- Add swarm command payloads for formation, search, patrol, converge, disperse, hold, land, and manual takeover.
- Implement per-drone steering rules with config-driven weights and limits.
- Link swarm commands to existing mission/task semantics where appropriate.
- Add tests for formation behavior, collision separation, individual object updates, and manual takeover.

Acceptance target:

- Swarm members are individual drones.
- Commands scale to dozens of drones without excessive event churn.

### Pass 7: Interactions And Damage

- Implement attack/damage commands and deterministic interaction rules.
- Support drone-vs-drone and drone-vs-ground-asset effects through validated payloads and object updates.
- Add capability checks, range checks, cooldowns, payload depletion, and visible alert/damage state.
- Add tests against ambulances and drones.

Acceptance target:

- Attack effects are explicit, visible, validated, and reversible only by explicit repair/reset commands.

### Pass 8: Documentation, Health, Push, Deploy

- Add `docs/wiki/drone-ops.md` as the operational/implementation handbook.
- Update `docs/packs.md` and relevant ADR/doc references.
- Run focused tests, `bun run check`, and `bun run health`.
- Push to `main` and deploy.

## Adversarial Risks And Controls

| Risk | Control |
| --- | --- |
| Beautiful 3D but detached from runtime truth | 3D views consume drone runtime query/object state only. |
| PWR-style hard-coded variant creep | Profiles, commands, swarm rules, and scenario objects are declarative and validated. |
| Over-abstracted universal mission/simulation framework | Keep drone execution in the drone pack; extend core mission only after another real pack needs the same operation. |
| Event storm from many drones | Fixed runtime cadence, projected persistence, meaningful-delta thresholds, and query read models for rich detail. |
| Gamepad portability surprises | Use standard Gamepad API, expose clear diagnostics, retain keyboard controls. |
| Browser-only multiplayer state | Every control action is a command to the Control Instance runtime; no browser-local authoritative flight state. |
| Unsafe arbitrary profile editing | Editor emits validated profile payloads with finite bounds and explicit capabilities. |
| Cross-pack damage mutates foreign assets secretly | Interaction effects and object updates carry provenance and are tested; no global hidden mutation path. |

## Implementation Snapshot

Implemented in the first drone pass:

- standalone `drone` pack with no aviation imports
- typed profile/capability/sensor/payload/energy/dynamics/control/health/swarm schemas
- scenario expansion for configurable drone objects and runtime profile overrides
- `drone.local` runtime adapter with fixed-step flight, manual input TTL, guided navigation, landing, return-to-launch, battery drain, swarm navigation, and bounded projected emissions
- command contracts for create, manual control, navigate, set mode, profile configuration, swarm command, and attack/effect request
- read-only pack queries for scene objects, profiles, controller bindings, and map features
- map/rail presentation, create-object metadata, sensor/effect range features, and drone icons
- generic app/runtime/scenario registration
- built-in `oslo-drone-operations` scenario with ambulances plus drones
- built-in `mission:oslo-drone-search-and-intercept` mission definition attached to the scenario
- keyboard/gamepad flight modal with 2D/3D Three.js view and target/effect commands
- profile editor modal that persists changes through validated commands
- interaction handler for drone effects against drone and non-drone targets
- tests for scenario expansion, manual flight isolation, swarm individuality, effects, scene query, command rejection, and built-in catalog validity
- `docs/wiki/drone-ops.md` as the operational/implementation handbook

Implemented in the V2 fidelity pass:

- typed environment config for wind, gust, turbulence, precipitation, visibility, and air density
- pure `src/packs/drone/sim/physics.ts` integration for air-relative drag, wind/gust effects, acceleration-limited velocity, pitch/roll attitude estimates, payload mass, and weather-sensitive energy use
- built-in Oslo drone scenario environment config, so weather is visible through normal scenario data
- first-person FPV camera mode attached to the selected drone body frame
- flight HUD with altitude, speed, battery, heading, pitch/roll, wind, precipitation, and visibility
- cached Three.js object meshes, rotor animation, shadows, road markings, windows, vegetation, fog/visibility, and rain/snow streaks
- optional DEM sampling from advertised terrain PMTiles and terrain-aware draping for ground, roads, buildings, vegetation, and POI affordances
- moving-world scenery streaming keyed by rounded source-backed map grid centers, so flight away from the start loads new vector-derived scenery instead of remaining in the original block
- source-backed aeroway and place-layer consumption in the Three.js world
- conservative transport-fragment merging for source-identical and named-major road/rail/aeroway features so tile cuts do not dominate road continuity
- source coverage counters for streamed worlds, including buildings, roads, water, vegetation, road labels, and merged line fragments
- bounded scenery exclusion checks so derived vegetation and road furniture do not occupy source-backed solids or transport corridors
- read-only `drone.sensorContacts` query and pilot-panel contact list with range/FOV/visibility/precipitation confidence filtering
- tests for environment physics and sensor-contact filtering

Implemented in the scenery close-out pass:

- expanded vector-world decoding for `transportation_name` road labels and richer transportation metadata, including subclass, bridge/tunnel, access, service, maxspeed, and one-way hints
- layer-specific decode budgets so dense road/building tiles are not prematurely truncated by a single low cap before the renderer selection pass
- static UV-based building facades, double-sided wall rendering, roof surfaces, and rooftop fixtures derived from real building footprints
- shoreline edge cues derived from real water polygons
- road furniture, bridge barriers, and road-label signs derived from real road and road-name geometry
- deterministic vegetation instancing derived from landcover and landuse polygons
- source-backed exclusion index preventing derived vegetation inside buildings, water, aeroways, roads, rails, and runways
- DEM loader prefetches unique terrain tiles before sampling the local height grid, reducing avoidable terrain load stalls once a terrain artifact is promoted
- renderer regression tests proving that decoded source-backed features produce the rich Three.js scenery graph, that transport fragments merge conservatively, and that blocked vegetation is not emitted

Explicitly remaining:

- mission progress runner and mission-driven command issuance
- first production terrain artifact build from Kartverket DTM or another selected DEM source; the manifest now advertises terrain as available only after the PMTiles archive validates as readable PNG DEM data
- richer vector tile/reference-data builds for extra source-backed detail, especially vegetation density, landmarks, building semantics, rural landcover, bridges/tunnels, and non-city scenery; this is data-pipeline work, not hidden renderer fabrication
- richer swarm search/patrol/separation/cohesion behavior
- deeper sensor model for occlusion, classification, shared detections, and update cadence
- communications/link loss/geofence model
- browser visual verification on the deployed route with screenshots/canvas checks
- credibility benchmarking harness for flight and swarm acceptance envelopes

## V2 Fidelity Pass Targets

The second pass raises the target from "functional drone pack" to "credible browser-based drone/FPV simulator foundation". The goal is still not to embed a certified autopilot or full SITL stack inside Leitbild. The goal is to move the architecture toward the same separations used by mature systems: vehicle model, controller/autopilot, environment, sensors/effects, renderer, and operator UI.

Research anchors for this pass:

- PX4 multicopter control architecture separates position, velocity, attitude, and angular-rate loops. Leitbild should keep the simplified model, but it should expose the same conceptual layers instead of direct position teleportation.
- ArduPilot Copter modes distinguish manual/stabilized flight, guided point flight, return-to-launch, land, and mission/auto behavior. Leitbild's modes should remain explicit and mode-dependent.
- AirSim and similar simulators separate visual rendering from vehicle physics and sensor models. Leitbild's Three.js scene must remain a visualization of runtime truth, not the simulation authority.
- The browser Gamepad API is a polling API. Leitbild should keep reading current gamepad state every animation frame and send bounded, TTL-based commands to the runtime.
- Three.js `InstancedMesh` and cached object graphs should be used where many repeated visual elements would otherwise create excessive draw calls.

V2 acceptance criteria:

- The runtime accepts a typed drone environment config containing wind, gust/turbulence, precipitation, visibility, and air-density inputs.
- Manual, hold, guided, swarm, land, and return-to-launch modes use a shared physics integration path with acceleration limits, air-relative drag, wind effects, attitude estimates, and energy use that changes with climb, speed, payload, and wind.
- FPV is a first-class flight mode in the modal. The camera sits on the selected drone, follows its yaw/pitch/roll, and displays flight HUD data useful enough to fly by sight.
- The Three.js scene updates meshes in place instead of rebuilding all object meshes every frame.
- The visual world has enough cues for FPV: map-derived roads, lane markings, road furniture, road-label signs, water, shorelines, vegetation, building massing/facades/roofs, rooftop fixtures, shadows, fog/visibility, weather streaks, drones, ambulances, and other operational assets.
- No new HTTP server, JavaScript file, aviation dependency, or browser-authoritative simulation path is introduced.

V2 scoped deferrals:

- Real PX4/ArduPilot SITL, WebAssembly flight dynamics, and JSBSim-style aircraft modeling are deferred until there is a measured need or a concrete benchmarking target that the TypeScript model cannot meet.
- Real DEM terrain remains inactive until a self-hosted terrain PMTiles artifact validates. The modal reads terrain availability from `/map/capabilities.json`, attempts DEM decoding only for advertised real artifacts, and must not synthesize or imply real elevation while the artifact is unavailable.
- A full mission autopilot runner remains separate from this pass. V2 strengthens flight, FPV, environment, and visual fidelity first.
