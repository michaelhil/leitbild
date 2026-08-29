# Composable Workspace Platform

This experimental branch rebuilds Samsinn and Leitbild as distinct Experiences over one modular Workspace platform. Users enter through one Workspace Host; specialised Modules retain their own domain state, runtime mechanics, and UI surfaces.

The experiment is intentionally a clean break. It contains no compatibility routes, state migration, API versions, default Workspace, Workspace-selection cookie, or Suite layer.

## Repository layout

- `apps/workspace-host` — authoritative Workspace lifecycle, module composition, routing, and shared shell
- `apps/samsinn` — current Collaboration and Agent implementation while those Modules are separated
- `apps/leitbild` — current Microworld implementation
- `packages/platform-contracts` — shared identifiers and validated wire contracts only
- `contexts` — canonical domain language for the Platform and its Modules
- `docs/architecture` — rewrite plan and acceptance gates
- `docs/adr` — hard-to-reverse architectural decisions

The `main` branch at commit `d212523` is the benchmark baseline. The experiment lives on `experiment/composable-workspace-platform` until it meets the acceptance and benchmark gates.

## Implemented experiment

- The Workspace Host owns the only Workspace directory and renders the root-level Workspace UI.
- Leitbild is the `leitbild` Experience over the `microworld` Module.
- Samsinn is the `samsinn` Experience over independent `collaboration` and `agents` Module state.
- Module UIs remain specialised and link back to the Host; Experience entry routes resolve them from validated Module manifests.
- Agent Profiles store Capability grants but no external Resource ids. Generic Agent tools discover and invoke current Workspace Resources through the Host.
- Packs name one owning Module: `microworld` for Simulation Packs and `agents` for Agent Packs.
- Workspace Templates and continuous Bindings are deliberately not implemented without a demonstrated repeated setup or continuous integration requirement.

See [the implementation plan](docs/architecture/IMPLEMENTATION_PLAN.md) and
[the old/new benchmark](docs/architecture/CONTROL_PLANE_BENCHMARK.md).
