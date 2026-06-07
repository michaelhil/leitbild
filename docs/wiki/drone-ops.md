---
title: Drone Operations
type: pack
---

# Drone Operations

!!! note "Status"
    Leitbild now has a standalone `drone` pack for shared drone, drone-swarm, browser-control, Three.js flight-view, and drone-effect simulation. It is independent of the aviation/airspace pack. The model is a deterministic operational simulation intended for scenario work, demonstrations, command-and-control UX, and reusable pack architecture, not a certified autopilot or safety analysis tool.

Drone operations live in `src/packs/drone`. The pack contributes drone object creation, scenario expansion, profile validation, flight dynamics, energy state, swarm commands, interaction effects, read-only pack queries, map presentation, and pack-specific UI modals. The runtime is registered as `drone.local`.

The first built-in scenario is `oslo-drone-operations`. It combines ambulances and drones in one Control Instance, attaches the mission `mission:oslo-drone-search-and-intercept`, and demonstrates surveillance, supply, and effect-capable drones without depending on aviation.

## Operational Scope

The current implementation supports:

- individually simulated drone objects with per-drone profile, energy, kinematics, control, health, payload, sensor, and optional swarm state
- keyboard and browser Gamepad API control from drone flight windows
- multiple open flight windows in one browser, each bound to one drone
- multiple remote browsers controlling the same Control Instance through the existing command/runtime path
- map-visible drones, sensor footprints, and effect ranges
- 2D, 3D chase, and FPV Three.js drone flight windows
- procedural deterministic 3D environment generated from the active object/map context, with drones, ambulances, other assets, roads, water, buildings, vegetation, weather cues, and HUD telemetry rendered as scene objects
- configurable drone profiles through scenario runtime config, per-object scenario config, and a profile editor modal
- swarm commands that preserve every member as an individual object
- read-only sensor-contact projections with range, field-of-view, visibility, precipitation, bearing, and confidence filtering
- validated drone effect commands that can damage or destroy drone and non-drone operational assets through the generic interaction-signal/effect path
- a formal mission definition for drone search, support, and effect demonstration

The current implementation does not yet include a full mission runner, rich vector-tile building extrusion, RF/link modeling, collision physics, or a full autopilot stack. Those are deliberate next layers, not hidden production claims.

## Architecture

The drone capability is one pack, not several packs.

This is intentional. Flight dynamics, profiles, swarm membership, sensors, payloads, and drone effects are one cohesive domain right now. Splitting immediately into `drone`, `swarm`, `uas-control`, and `mission` packs would add coordination overhead before there is a proven second caller. The extraction boundary remains available later: generic mission intent stays in core, while drone-specific flight and swarm execution stays in the drone pack runtime.

Core remains responsible for:

- scenario catalog validation
- Control Instance creation and projected state
- command envelopes and actor identity
- runtime routing through the Runtime Hub
- durable event ordering
- read-only pack query routing
- interaction signal ordering and constrained effect commits
- generic map, rail, and surface rendering

The drone pack owns:

- validated drone profile schemas
- drone command schemas
- scenario object expansion for `pack: "drone", type: "drone"`
- fixed-step flight simulation
- typed environment/wind/weather model
- local runtime adapter emissions
- map area features for sensor/effect ranges
- drone scene/read-model queries
- attack/effect interaction handlers
- pack presentation and create-object metadata
- pack-specific flight/profile UI modals

Generic UI modules do not contain drone flight math. They open pack-specific modals from generic object rows, then the modal sends normal Control Instance commands.

## Files

Primary implementation:

- `src/packs/drone/model.ts`: schemas and TypeScript types for profiles, capabilities, sensors, payloads, dynamics, energy, kinematics, control, health, swarm, mission, and pack data
- `src/packs/drone/commands.ts`: validated command kinds and payload schemas
- `src/packs/drone/scenario.ts`: scenario expansion and runtime profile override parsing
- `src/packs/drone/sim/engine.ts`: fixed-step flight, control arbitration, energy, swarm, and command handling
- `src/packs/drone/sim/physics.ts`: pure multicopter physics/environment integration for wind, drag, attitude, and energy
- `src/packs/drone/sim/adapter.ts`: Runtime Hub adapter and bounded projected emissions
- `src/packs/drone/sim/object-state.ts`: creation and projection of drone OperationalObjects
- `src/packs/drone/query.ts`: read-only scene, profile, controller-binding, and map-feature queries
- `src/packs/drone/interactions.ts`: validated effect handling through generic interaction signals
- `src/packs/drone/pack.ts`: pack registration, presentation, map features, actions, and create-object contract

UI implementation:

- `src/ui/drone/DroneControlModal.svelte`: keyboard/gamepad flight window, command buttons, target/effect command UI
- `src/ui/drone/DroneProfileEditorModal.svelte`: profile editing through validated commands
- `src/ui/drone/drone-scene.ts`: Three.js renderer and procedural scene generation
- `src/ui/routes/ControlSurfaceRoute.svelte`: modal window management
- `src/ui/ObjectRow.svelte`: drone flight/profile actions in the generic rail row

Scenario and tests:

- `src/scenarios/oslo-drone-operations.scenario.json`: built-in mixed ambulance/drone scenario
- `src/scenarios/index.ts`: built-in drone mission definition and scenario registration
- `tests/drone-pack.test.ts`: scenario expansion, manual flight, environment physics, swarm individuality, effect handling, scene query, sensor contacts, command rejection, and catalog validity

## Drone Profile Model

A drone profile is data. It is not a hard-coded enum of surveillance/supply/attack types.

The profile contains:

- `airframe`: kind, rotor count, mass, size, and drag area
- `dynamics`: horizontal speed, vertical speed, acceleration, yaw rate, tilt, and service ceiling
- `energy`: battery capacity, reserve, nominal voltage, hover power, cruise power, and payload power
- `capabilities`: free-form validated capability descriptors such as `manual_control`, `guided_navigation`, `swarm_member`, `surveillance`, `supply`, or `effect_delivery`
- `sensors`: sensor kind, range, field of view, update cadence, and optional energy use
- `payloads`: supply/effect payloads with quantity, mass, range, and effect parameters
- `visual`: color, accent color, and scale for map/3D presentation

Built-in examples are:

- `quad-surveillance`
- `heavy-supply`
- `interceptor-effect`

Scenario runtime config can add or override profiles and set environment conditions. The `oslo-drone-operations` scenario adds `micro-observer` entirely through config and sets wind, gust, precipitation, visibility, and air density.

## Environment Model

The drone runtime accepts typed environment config:

- `windSpeedMps`
- `windDirectionDeg`
- `gustSpeedMps`
- `turbulenceIntensity`
- `precipitation`
- `precipitationIntensity`
- `visibilityM`
- `airDensityKgM3`

Environment is not cosmetic. The runtime samples the environment into each drone's pack data and uses it in the physics step. Wind changes air-relative speed, drag, attitude, and energy use. Visibility and precipitation feed sensor-contact confidence and the FPV/Three.js weather presentation.

## Flight Model

The runtime uses a compact fixed-step multicopter approximation:

1. Resolve the current control mode.
2. Expire stale manual inputs by command TTL.
3. Convert manual, guided, land, return-to-launch, or swarm intent into desired local velocity, vertical speed, and yaw rate.
4. Convert ground-velocity intent to an acceleration-limited physics step.
5. Apply air-relative drag from wind/gust, drag area, air density, and payload mass.
6. Estimate pitch/roll from acceleration so FPV and external views reflect vehicle effort.
7. Integrate local meters to WGS84 lon/lat.
8. Integrate altitude and yaw.
9. Drain energy based on hover, cruise, payload power, airspeed, climb power, turbulence, precipitation, and timestep.
10. Apply low-energy behavior: below reserve, return-to-launch is preferred; at zero energy, the drone becomes disabled.
11. Project changed state back as ordinary object-upsert events at a bounded runtime cadence.

This follows the broad shape of real multicopter control systems without trying to reproduce PX4 or ArduPilot internals. PX4 documents multicopter position/velocity/attitude control concepts; ArduPilot separates operator modes such as Guided, Auto, RTL, Land, Loiter, and Stabilize; MAVLink separates navigation waypoints from mission/action commands. Leitbild uses those patterns as modeling anchors, while keeping the runtime inspectable and deterministic.

Reference anchors:

- PX4 docs: `https://docs.px4.io/`
- ArduPilot Copter flight modes: `https://ardupilot.org/copter/docs/flight-modes.html`
- MAVLink mission protocol: `https://mavlink.io/en/services/mission.html`
- MDN Gamepad API: `https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API`

## Control Modes

The drone control mode is pack-owned state:

- `hold`: maintain current position and altitude
- `manual`: honor keyboard/gamepad axes while the command TTL is alive
- `guided`: navigate toward one target point and altitude
- `swarm`: follow swarm command target/formation while remaining an individual drone
- `mission`: reserved for mission-runner integration
- `land`: descend and transition to landed hold
- `return_to_launch`: navigate back toward launch point
- `disabled`: no controlled flight
- `destroyed`: inactive destroyed object

Manual commands are intentionally not sent every animation frame. The flight modal sends only on input changes or active keepalive intervals, which preserves responsiveness without flooding durable command history.

## Commands

The drone pack accepts these commands:

- `drone.create_object`: create a drone from a profile and location
- `drone.manual_control`: set per-drone control axes with TTL and input-source metadata
- `drone.navigate_to`: command one drone to a target point and altitude
- `drone.set_mode`: hold, land, return-to-launch, or other allowed mode transitions
- `drone.configure_profile`: replace one drone profile through validated data
- `drone.swarm_command`: command a set of individually simulated drones
- `drone.attack`: request a validated payload effect against a target object

All command payloads are validated with Zod before the runtime changes state. Invalid IDs, missing capabilities, depleted payloads, out-of-range targets, and unsupported commands fail explicitly.

## Swarm Model

A swarm is not a visual clone cloud. Every member remains an ordinary `OperationalObject` with its own:

- profile
- position
- altitude
- energy
- mode
- health
- payloads
- telemetry
- projected state

The first swarm implementation supports a command-level group target plus per-member formation offsets. Supported command vocabulary includes navigation, search-area placement, disperse, hold, and land. Manual takeover is a normal per-drone manual-control command. Richer patrol/search coverage patterns are the next implementation layer.

The design keeps swarm behavior simple on purpose:

- group commands are data
- members remain individual simulated objects
- local per-drone limits still apply
- runtime emissions are coalesced
- manual takeover is per drone, not swarm-global

Future swarm deepening should add separation/cohesion weights, obstacle awareness, coverage metrics, and assignment algorithms only when scenarios need them.

## Effects And Damage

Drone effects use the generic interaction system.

Flow:

1. UI, scenario, AI, or operator issues `drone.attack`.
2. The drone runtime validates attacker existence, profile validity, payload availability, and command shape.
3. The runtime emits `drone.attack.requested` as an interaction signal.
4. The drone interaction handler reads the current Control Instance snapshot.
5. It validates target existence, effect payload, range, and quantity again at commit time.
6. It returns constrained effects: object upserts and an operational notification.
7. Core orders, persists, and broadcasts those effects.

Targets can be drones or non-drone assets. Drone targets receive integrity and health-state updates. Non-drone targets receive operational damage/destroyed status plus an alert. The handler does not import ambulance internals and does not directly mutate foreign pack state.

## Browser Flight UI

Open a drone flight window from the object rail action on any drone.

Controls:

- keyboard:
  - W/S or up/down: forward/back
  - A/D: left/right
  - Space/Shift: climb/descend
  - Q/E or left/right arrows: yaw
  - Escape: close flight window
- gamepad:
  - left stick: forward/right
  - right stick X: yaw
  - right trigger / left trigger: climb/descend

The browser exposes Bluetooth Xbox-style controllers through the standard Gamepad API on supported Windows/macOS/browser combinations. Leitbild does not talk directly to Bluetooth hardware; it consumes `navigator.getGamepads()` and browser gamepad events.

Multiple flight windows can be open at once. Each window carries its own selected controller, target selector, view mode, FPV/chase/2D camera state, sensor-contact panel, and command state. Multiple remote browsers work because the runtime receives normal Control Instance commands and projects canonical object state back to every client.

## Three.js Scene

The drone flight modal uses Three.js.

The scene renders:

- active drone as a colored quadrotor mesh
- other drones with their own profile color/scale
- ambulances as recognizable ambulance meshes
- generic operational assets as markers
- ground, roads, water, park space, and building proxies
- road markings, roofs, windows, vegetation, shadows, fog, rain/snow streaks, and rotor animation
- 2D overhead, 3D chase, and first-person FPV camera modes
- flight HUD: altitude, speed, battery, heading, pitch, roll, wind, precipitation, and visibility

The first environment generator is deterministic from the current map/object context and viewport center. It does not use pre-rendered images. It currently creates credible proxy scenery around the active object set. A future map-fidelity pass should consume vector tile/building/road/water features from the self-hosted map artifact and extrude/symbolize those features instead of using deterministic proxy roads/buildings.

The renderer owns its WebGL lifecycle:

- resize observer updates the camera and renderer size
- object meshes are cached and updated in place; only disappeared or visually changed objects are disposed/rebuilt
- modal close disposes renderer resources and removes the canvas

## Surveillance Contacts

Sensor contacts are exposed as a read-only pack query and in the flight modal's sensor panel. A contact is produced only when:

- the observing object is an active drone
- the target has a point position and is active
- the target is within sensor range and local visibility
- the target is inside the sensor field of view unless the sensor is omnidirectional

Contacts include the observing drone id, sensor id, target id/label, distance, bearing, and confidence. Confidence is intentionally simple and inspectable: it drops with range and precipitation, with thermal sensors penalized less by precipitation. Contacts do not mutate target objects and do not become a second source of truth.

## Queries

The drone runtime exposes read-only pack queries:

- `drone.scene`: scene/read-model state for drones
- `drone.controllerBindings`: controller binding metadata shape
- `drone.profiles`: active profile catalog
- `drone.mapFeatures`: sensor footprints and effect ranges for map rendering
- `drone.sensorContacts`: read-only surveillance contacts from active drone sensors

Queries do not mutate runtime state. UI and future AI/procedure tooling should use queries for rich drone read models rather than copying runtime-private mechanics into core objects.

## Scenario And Mission Integration

Scenario config can declare drone objects with:

- `profileId` or inline `profile`
- lon/lat position
- initial altitude
- initial heading
- initial mode
- optional swarm membership and slot

Runtime config can declare reusable profile overrides:

```json
{
  "runtimeConfigs": {
    "drone": {
      "environment": {
        "windSpeedMps": 5.5,
        "windDirectionDeg": 215,
        "gustSpeedMps": 2.8,
        "turbulenceIntensity": 0.32,
        "precipitation": "rain",
        "precipitationIntensity": 0.18,
        "visibilityM": 6500,
        "airDensityKgM3": 1.225
      },
      "profiles": [
        {
          "id": "micro-observer",
          "label": "Micro Observer"
        }
      ]
    }
  }
}
```

Mission intent is expressed with core `MissionDefinition` data. The first drone mission defines goals, objectives, tasks, stages, triggers, actions, and metrics for the Oslo drone scenario. Mission execution is not yet a hidden script engine. The recommended pattern is:

- core mission definition expresses reusable intent
- scenario scripts introduce timed briefing/setup events
- drone commands execute flight/swarm/effect behavior
- future mission progress should observe committed events and issue validated commands only through core paths

## Safety And Architecture Boundaries

The drone pack must keep these boundaries:

- no aviation imports
- no extra HTTP server
- no browser-local authoritative flight state
- no arbitrary profile code or runtime scripting
- no direct mutation of foreign pack state
- no map/UI import of drone simulation internals outside pack-specific UI
- no high-rate durable event stream for every input sample
- no fake swarm objects that exist only in the renderer

## Verification

Use these checks before demoing drone behavior:

```text
bun test tests/drone-pack.test.ts
bun test tests/drone-pack.test.ts tests/pack-architecture.test.ts tests/scenario-surface.test.ts tests/context-scenario-mission-model.test.ts
bun run check
bun run build:ui
bun run health
```

Important tested behaviors:

- drone scenario expansion is config-driven and aviation-independent
- manual control moves one drone without moving another
- runtime environment config changes energy, attitude, and pack data
- swarm command keeps every member as an individual object
- attack effects damage non-drone assets through interaction handlers
- scene projection returns one entry per drone
- sensor contacts honor range/FOV filtering
- invalid attack commands fail explicitly
- the built-in drone scenario and mission are catalog-valid together

## Known Next Work

Highest-value next work:

- vector-tile-derived 3D world: roads, water, landuse, buildings, and object anchors from the self-hosted map artifact
- richer swarm steering: separation, cohesion, coverage search, patrol legs, leader/follower fallbacks, and collision avoidance
- mission progress runner: observe committed events, update mission progress, and issue only validated commands
- deeper sensor model: occlusion approximations, contact classification, shared sightings, and sensor update cadence
- communications model: control-link quality, latency, loss-of-link, geofence and return behavior
- credibility benchmarks: acceptance envelopes for speed, climb rate, turn/yaw rate, endurance, RTL, landing, and swarm convergence
- operator UX: map-side swarm tasking, formation editor, target zones, mission progress panel, and controller diagnostics

The current implementation establishes the pack, runtime, scenario, command, query, interaction, and UI foundations for these layers without hard-coding the system to one drone type or one demo scenario.
