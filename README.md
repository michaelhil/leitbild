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
