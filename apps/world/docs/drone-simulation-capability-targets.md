# Drone Native Runtime Capability Targets

This file records the current drone stack after removing the external drone simulator stack.

Leitbild uses a server-side native drone pack runtime. The browser renders projected operational truth and captures input devices only; it does not own drone truth.

Current artifacts:

- Drone runtime: `drone.native`
- Runtime adapter: `src/packs/drone/native/adapter.ts`
- Runtime config: `src/packs/drone/native/config.ts`
- Object projection: `src/packs/drone/native/object-state.ts`
- Renderer: `src/ui/drone/drone-scene.ts`
- Scenario: `src/scenarios/oslo-drone-operations.scenario.json`

Removed artifacts:

- external drone simulator process runners
- external drone systemd units
- external controller command translation
- UDP flight-control protocol client code
- external simulator vehicle ids and endpoint config
- browser-owned authoritative drone flight dynamics

Native runtime responsibilities:

- fixed-step flight integration
- arm/disarm, takeoff, land, hold, return, goto, manual velocity, mission, geofence, gimbal, swarm, and effect commands
- flight-envelope validation from declarative vehicle models
- battery drain, pose, velocity, attitude, health, arming, navigation, mission, geofence, and payload projection
- shared Simulation Run object updates through the Runtime Hub

Target behavior:

- direct input commands should be accepted in well under 1 ms on the server hot path
- internal stepping defaults to 50 Hz
- projected state defaults to about 30 Hz
- the default scenario budget is 10 drones or fewer
- the runtime design should remain simple enough to scale by batching/coalescing object projection before raising fleet size
