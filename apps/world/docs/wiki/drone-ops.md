# Drone Operations

The `drone` pack uses Leitbild's native server-side drone runtime. There is no separate drone simulator process, external controller runner, or flight-control protocol bridge in the active stack.

Drone operations live in `src/packs/drone`. The Pack contributes drone object creation, Scenario expansion, vehicle model validation, interaction effects, read-only Simulation Capabilities, map presentation, and Pack-specific UI modals. The default runtime is `drone.native`.

The browser owns input capture and rendering only. It sends normal Simulation Run commands and renders projected object/query state. It does not own authoritative drone motion.

## Capability Surface

- native fixed-step drone control loop
- per-drone vehicle model metadata for airframe, flight envelope, capabilities, sensors, payloads, and visual profile
- arm/disarm, manual control, guided goto, takeoff, land, return-to-launch, hold, mission upload/start/pause/clear, geofence upload/clear, gimbal, vehicle model, swarm, and effect commands
- runtime projection for link state, arming, navigation mode, global pose, velocity, attitude, battery, health, mission, geofence, payload, and controller binding state
- map-visible drones, sensor footprints, effect ranges, and swarm envelopes from query Capabilities
- validated drone effect commands through the generic interaction-signal/effect path
- a formal mission definition for drone search, support, and effect demonstration

## Runtime

The drone capability is one pack with one runtime path:

- runtime id: `drone.native`
- adapter: `src/packs/drone/native/adapter.ts`
- config: `src/packs/drone/native/config.ts`
- object projection helpers: `src/packs/drone/native/object-state.ts`

The runtime keeps private motion targets, home points, mission plans, and geofence polygons. It emits ordinary Pack Runtime object updates through the Runtime Hub, so Simulation Run Projected State remains canonical shared Leitbild truth.

Default runtime settings:

- `maxDrones`: 10
- `stepIntervalMs`: 20
- `projectionIntervalMs`: 33
- `batteryDrainPercentPerHour`: 8

Scenario runtime config can override these values and add vehicle models.

## Vehicle Models

Vehicle models are declarative data. They describe:

- `airframe`
- `flightEnvelope`
- `capabilities`
- `sensors`
- `payloads`
- `visual`

Built-in model ids:

- `native-survey-quad`
- `native-gimbal-quad`
- `native-interceptor-quad`

## Commands

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
- `drone.set_gimbal`
- `drone.configure_vehicle_model`
- `drone.swarm_command`
- `drone.attack`

All payloads are validated with Zod before the runtime mutates state or emits interaction signals. Invalid object ids, unavailable capabilities, out-of-geofence targets, depleted payloads, and invalid targets fail explicitly.

## Flight Window

The drone flight modal uses Babylon.js for the 3D flight view. It renders:

- active drone mesh using vehicle visual metadata
- other drones and generic operational assets
- terrain/scenery from source-backed map artifacts
- chase, FPV, and top-down camera modes
- HUD data from projected drone pack data
- keyboard, mouse, and Gamepad API input capture

Babylon owns only presentation. It interpolates projected object state for smooth rendering and uses adaptive pixel ratio, cached asset containers, bounded scenery streaming, and mesh reuse to keep performance predictable.

## Query Capabilities

The drone runtime exposes read-only Simulation Capabilities:

- `world.drone.scene`: scene/read-model state for drones
- `world.drone.controller-bindings`: controller binding metadata
- `world.drone.vehicle-models`: active vehicle model catalog
- `world.drone.map-features`: sensor footprints, effect ranges, and swarm envelopes
- `world.drone.sensor-contacts`: detected contacts from configured real sensor inputs

Queries do not mutate runtime state. UI, AI, and procedure tooling should invoke these Capabilities for rich drone read models rather than copying runtime-private mechanics into core objects.

## Effects

Drone effects are routed through generic interaction signals:

1. UI, scenario, AI, or operator issues `drone.attack`.
2. The drone runtime validates attacker/target command shape and emits `drone.attack.requested`.
3. The pack interaction handler validates attacker state, payload availability, range, and target state.
4. The handler returns constrained effects for the Simulation Run runtime to commit.

Targets can be drones or non-drone assets. Drone targets receive damage records and health-state updates. Non-drone targets receive operational damage/destroyed status plus an alert. The handler does not import another pack's internals and does not directly mutate foreign private state.

## Checks

Use these checks before demoing drone behavior:

```bash
bun test tests/drone-pack.test.ts
bun test tests/drone-scenery-renderer.test.ts tests/drone-scene-streaming.test.ts tests/drone-terrain.test.ts
bun run check
```
