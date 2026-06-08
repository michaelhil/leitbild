---
title: Drone Operations
type: pack
---

# Drone Operations

!!! note "Status"
    The `drone` pack now uses Gazebo SITL plus PX4 or ArduPilot through MAVLink. The browser renderer is Babylon.js only. Leitbild no longer contains a browser-local drone physics runtime, Three.js drone renderer, or `drone.local` runtime path.

Drone operations live in `src/packs/drone`. The pack contributes drone object creation, scenario expansion, vehicle model validation, MAVLink command schemas, interaction effects, read-only pack queries, map presentation, and pack-specific UI modals. The default runtime is `drone.sitl`.

The first built-in scenario is `oslo-drone-operations`. It combines ambulances and drones in one Control Instance, attaches the mission `mission:oslo-drone-search-and-intercept`, and demonstrates surveillance, support, and effect-capable drones without depending on the aviation/airspace pack.

## Runtime Scope

The current implementation supports:

- Gazebo-backed SITL drone control through MAVLink v2 over UDP
- PX4 as the default deployment stack and ArduPilot as the alternate supported SITL stack
- per-drone vehicle model metadata for autopilot model, Gazebo model, airframe, capabilities, sensors, payloads, and visual profile
- MAVLink heartbeat, arm/disarm, manual control, guided reposition, takeoff, land, return-to-launch, loiter/hold, mission upload/start/pause/clear, geofence upload/clear, parameter set, and gimbal commands
- MAVLink telemetry projection for link state, arming, navigation mode, global pose, velocity, attitude, battery, health, status text, and mission current sequence
- map-visible drones, sensor footprints, effect ranges, and swarm envelopes from pack queries
- 2D, 3D chase, and FPV Babylon.js flight windows
- validated drone effect commands through the generic interaction-signal/effect path
- a formal mission definition for drone search, support, and effect demonstration

The runtime does not simulate flight physics in TypeScript. PX4 or ArduPilot owns vehicle motion, control laws, failsafe behavior, geofence handling, mission execution, and sensor/plugin integration. Leitbild projects accepted telemetry into canonical Control Instance state and sends validated commands back through MAVLink.

## Architecture

The drone capability is one pack with one runtime path:

- runtime id: `drone.sitl`
- adapter: `src/packs/drone/sitl/adapter.ts`
- MAVLink client: `src/packs/drone/sitl/mavlink.ts`
- object projection helpers: `src/packs/drone/sitl/object-state.ts`

Core remains responsible for scenario catalog validation, Control Instance creation, command envelopes, Runtime Hub routing, durable event ordering, read-only pack query routing, interaction signal ordering, and generic map/rail/surface rendering.

The drone pack owns vehicle model schemas, command schemas, scenario expansion, SITL runtime connection, MAVLink command translation, telemetry projection, map area features, drone scene/read-model queries, attack/effect interaction handlers, pack presentation, and pack-specific UI modals.

The browser owns input capture and rendering only. It sends normal Control Instance commands and renders projected object/query state. It does not own authoritative drone motion.

## Files

Primary implementation:

- `src/packs/drone/model.ts`: schema version 2 drone pack data, vehicle models, pose, velocity, attitude, battery, link, arming, health, mission, geofence, payload runtime state, and swarm metadata
- `src/packs/drone/commands.ts`: validated MAVLink-oriented command kinds and payload schemas
- `src/packs/drone/scenario.ts`: scenario expansion and runtime vehicle model parsing
- `src/packs/drone/sitl/adapter.ts`: Runtime Hub adapter for Gazebo/PX4/ArduPilot SITL
- `src/packs/drone/sitl/mavlink.ts`: direct TypeScript MAVLink v2 UDP client
- `src/packs/drone/sitl/object-state.ts`: creation and projection of drone OperationalObjects
- `src/packs/drone/query.ts`: read-only scene, vehicle model, controller-binding, sensor-contact, and map-feature queries
- `src/packs/drone/interactions.ts`: validated effect handling through generic interaction signals
- `src/packs/drone/pack.ts`: pack registration, presentation, map features, actions, and create-object contract

UI implementation:

- `src/ui/drone/DroneControlModal.svelte`: keyboard/gamepad flight window, command buttons, target/effect command UI
- `src/ui/drone/DroneProfileEditorModal.svelte`: vehicle model editing through validated commands
- `src/ui/drone/drone-scene.ts`: Babylon.js renderer and source-backed scenery streaming
- `src/ui/routes/ControlSurfaceRoute.svelte`: modal window management
- `src/ui/ObjectRow.svelte`: drone flight/model actions in the generic rail row

Deployment:

- `scripts/drone/setup-sitl.ts`: Linux host setup for PX4, ArduPilot, and Gazebo build dependencies
- `scripts/drone/run-sitl.ts`: selected SITL runner
- `scripts/drone/run-px4-gazebo.ts`: PX4 Gazebo runner
- `scripts/drone/run-ardupilot-gazebo.ts`: ArduPilot Gazebo runner
- `deploy/leitbild-drone-sitl.service`: selected stack systemd unit
- `deploy/leitbild-px4-gazebo.service`: PX4-specific systemd unit
- `deploy/leitbild-ardupilot-gazebo.service`: ArduPilot-specific systemd unit

Scenario and tests:

- `src/scenarios/oslo-drone-operations.scenario.json`: built-in mixed ambulance/drone scenario
- `src/scenarios/index.ts`: built-in drone mission definition and scenario registration
- `tests/drone-pack.test.ts`: SITL scenario expansion, query, interaction, model, map-feature, renderer support, and catalog validity

## Vehicle Model

A vehicle model is declarative data. It is not a hard-coded enum of surveillance/supply/effect types.

The model contains:

- `autopilotModel`: PX4 or ArduPilot model identity
- `gazeboModel`: Gazebo model identity
- `airframe`: kind, rotor count, mass, and size
- `capabilities`: validated descriptors such as manual control, guided navigation, mission, geofence, gimbal, sensor, or effect payload
- `sensors`: declared sensor range/FOV/update metadata from Gazebo, autopilot, payload, or operator-declared sources
- `payloads`: support/effect payloads with quantity, mass, range, and effect parameters
- `visual`: color, accent color, scale, and optional mesh reference for Babylon presentation

Built-in examples are:

- `px4-x500-depth`
- `px4-x500-gimbal`
- `ardupilot-iris`

Scenario runtime config can add or override vehicle models:

```json
{
  "runtimeConfigs": {
    "drone": {
      "autopilot": "px4",
      "world": "oslo",
      "mavlink": {
        "endpoint": "udp://127.0.0.1:14580?localPort=14540",
        "systemIdBase": 1
      },
      "models": [
        {
          "id": "px4-x500-vision-micro",
          "label": "PX4 X500 Vision Micro",
          "autopilotModel": "x500",
          "gazeboModel": "x500",
          "airframe": { "kind": "quadrotor", "rotorCount": 4 },
          "capabilities": [],
          "sensors": [],
          "payloads": [],
          "visual": { "color": "#2563eb", "accentColor": "#f8fafc", "scale": 1 }
        }
      ]
    }
  }
}
```

Scenario objects declare `modelId` or an inline `model`; they do not use `profileId`.

## MAVLink Control

The drone pack accepts these command kinds:

- `drone.create_vehicle`
- `drone.arm`
- `drone.manual_control`
- `drone.goto`
- `drone.takeoff`
- `drone.land`
- `drone.return_to_launch`
- `drone.hold`
- `drone.upload_mission`
- `drone.start_mission`
- `drone.pause_mission`
- `drone.clear_mission`
- `drone.upload_geofence`
- `drone.clear_geofence`
- `drone.set_parameter`
- `drone.set_gimbal`
- `drone.configure_vehicle_model`
- `drone.swarm_command`
- `drone.attack`

All payloads are validated with Zod before the runtime sends MAVLink messages or emits interaction signals. Invalid IDs, unavailable MAVLink systems, missing heartbeats, unsupported commands, depleted payloads, and out-of-range targets fail explicitly.

## Babylon Scene

The drone flight modal uses Babylon.js.

The scene renders:

- active drone mesh using vehicle visual metadata
- other drones and generic operational assets
- source-backed GLB scenery tiles from the self-hosted map/scenery pipeline
- flat or DEM-derived terrain according to `/map/capabilities.json`
- 2D overhead, 3D chase, and FPV camera modes
- HUD data from projected drone pack data

Babylon owns only presentation. It interpolates projected object state for smooth rendering and uses adaptive pixel ratio, cached asset containers, bounded scenery streaming, and mesh reuse to keep performance predictable. It does not run physics or decide drone truth.

## Queries

The drone runtime exposes read-only pack queries:

- `drone.scene`: scene/read-model state for drones
- `drone.controllerBindings`: controller binding metadata
- `drone.vehicleModels`: active vehicle model catalog
- `drone.mapFeatures`: sensor footprints, effect ranges, and swarm envelopes
- `drone.sensorContacts`: external contact surface; currently empty until contacts are provided by Gazebo/MAVLink-backed sensor integration

Queries do not mutate runtime state. UI, AI, and procedure tooling should use queries for rich drone read models rather than copying runtime-private mechanics into core objects.

## Effects And Damage

Drone effects use the generic interaction system.

Flow:

1. UI, scenario, AI, or operator issues `drone.attack`.
2. The drone runtime validates attacker/target command shape and emits `drone.attack.requested`.
3. The interaction handler reads the current Control Instance snapshot.
4. It validates target existence, effect payload, range, and quantity at commit time.
5. It returns constrained effects: object upserts and an operational notification.
6. Core orders, persists, and broadcasts those effects.

Targets can be drones or non-drone assets. Drone targets receive damage records and health-state updates. Non-drone targets receive operational damage/destroyed status plus an alert. The handler does not import another pack's internals and does not directly mutate foreign private state.

## Deployment

The deployed platform keeps one HTTP server: `src/core/api/server.ts`.

Drone SITL runs as a separate non-HTTP systemd process:

- selected stack unit: `leitbild-drone-sitl.service`
- default stack: PX4 Gazebo
- alternate stack: ArduPilot Gazebo via `LEITBILD_DRONE_SITL_STACK=ardupilot`
- Leitbild MAVLink endpoint: `LEITBILD_DRONE_MAVLINK_ENDPOINT=udp://127.0.0.1:14580?localPort=14540`

The deploy script copies the SITL units, runs `bun run drone:sitl:setup` for the selected stack, enables `leitbild-drone-sitl`, then restarts the main Leitbild service. The main service depends on the selected SITL unit but does not contain a second server or a hidden browser simulation path.

## Safety Boundaries

The drone pack must keep these boundaries:

- no aviation imports
- no extra HTTP server
- no browser-local authoritative flight state
- no arbitrary vehicle model code or runtime scripting
- no direct mutation of foreign pack state
- no map/UI import of drone runtime internals outside pack-specific UI
- no high-rate durable event stream for continuous motion
- no fake sensor contacts or simulated production telemetry when Gazebo/MAVLink does not provide it

## Verification

Use these checks before demoing drone behavior:

```text
bun test tests/drone-pack.test.ts
bun run check
bun run build:ui
bun run health
```

Important tested behaviors:

- scenario expansion creates schema version 2 SITL drone objects
- MAVLink system ids come from scenario runtime config
- scene projection exposes pose/model/link/arming data from canonical pack data
- map features come from declared vehicle sensors, payloads, and swarm metadata
- sensor contacts are not fabricated in the browser query layer
- attack effects deplete payloads and damage targets through interaction handlers
- the built-in drone scenario and mission resolve through `drone.sitl`

Highest-value next work is Gazebo sensor contact ingestion, richer vehicle model catalogs, validated multi-vehicle PX4 instance orchestration, ArduPilot Gazebo world packaging, and acceptance traces against known PX4/ArduPilot behaviors.
