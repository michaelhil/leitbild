# Drone Simulation Capability Status

This file records the current drone stack after the Gazebo/PX4/ArduPilot and Babylon.js migration.

Leitbild no longer targets an in-browser TypeScript drone physics simulator. Drone control is externalized to Gazebo SITL with PX4 by default and ArduPilot as the alternate supported stack. The browser renders projected operational truth with Babylon.js.

## Current Stack

- Drone runtime: `drone.sitl`
- Runtime adapter: `src/packs/drone/sitl/adapter.ts`
- MAVLink client: `src/packs/drone/sitl/mavlink.ts`
- Object projection: `src/packs/drone/sitl/object-state.ts`
- Renderer: `src/ui/drone/drone-scene.ts`
- Rendering engine: Babylon.js
- Source-backed scenery: GLB scenery tiles generated from the vector map artifact
- Deployment runner: `scripts/drone/run-sitl.ts`
- Default deployed SITL: PX4 Gazebo
- Alternate deployed SITL: ArduPilot Gazebo

## Removed Paths

- `drone.local`
- `src/packs/drone/sim/*`
- browser-owned drone flight dynamics
- Three.js drone renderer
- profile/kinematics/energy/environment drone pack data
- fake browser-generated sensor contacts

## First-Pass Capability Target

The first pass should be considered complete when these remain true:

- all drone commands go through validated MAVLink-oriented schemas
- all drone motion truth comes from PX4 or ArduPilot telemetry
- Leitbild projects link, arming, navigation, pose, velocity, attitude, battery, health, mission, geofence, payload, and swarm state into canonical objects
- Babylon renders 2D, 3D chase, and FPV views from projected state only
- deployment starts a selected non-HTTP SITL systemd unit alongside the one Leitbild HTTP server
- tests prove scenario expansion, queries, effects, rendering support structures, and catalog validity without importing a local drone sim

## Next Capability Targets

- Gazebo camera/depth/contact ingestion into `drone.sensorContacts`
- richer PX4 multi-instance acceptance traces for several scenario drones
- ArduPilot Gazebo world packaging and deployment acceptance runs
- mission/geofence acceptance traces against real autopilot behavior
- richer model catalog for PX4 X500 variants, ArduPilot Iris variants, gimbals, depth cameras, and payload plugins
- Babylon performance regression coverage for large scenery tiles and multiple drone windows
