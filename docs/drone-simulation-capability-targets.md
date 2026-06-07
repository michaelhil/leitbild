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
- Generate terrain plane, grid/roads/water/building proxies from map/object context available in the control instance.
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

Explicitly remaining:

- mission progress runner and mission-driven command issuance
- vector-tile-derived 3D world geometry from the self-hosted map artifact
- richer swarm search/patrol/separation/cohesion behavior
- sensor contact model and shared detections
- communications/link loss/geofence model
- browser visual verification on the deployed route with screenshots/canvas checks
- credibility benchmarking harness for flight and swarm acceptance envelopes
