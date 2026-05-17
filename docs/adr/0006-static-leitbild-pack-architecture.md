# ADR 0006: Static Leitbild Pack Architecture

## Decision

Leitbild will use a single user-facing extension concept: a **Leitbild Pack**.

A pack is a namespaced bundle that can contribute domain vocabulary, command schemas, simulation adapters/providers, map presentation, UI panels, research metrics, assets, and AI guidance.

The first implementation is static and built in. Leitbild will not add GitHub-based pack installation until the pack interface has stabilized through at least one internal pack.

## Rationale

Leitbild must support multiple operational domains without letting the core UI or control instance model become ambulance-specific. A pack-shaped interface gives the project a clear seam between generic control-center functionality and domain-specific behavior.

The installable unit should remain simple. Splitting domain, simulation, UI, and asset behavior into separate user-facing pack types would create management overhead and unclear compatibility rules. Instead, those are contribution sections inside one pack. Scenarios are top-level compositions that activate packs rather than being owned by a single pack.

Dynamic GitHub installation is deliberately deferred. Remote pack loading would freeze a still-young interface and introduce code-trust, compatibility, update, and run-validity concerns before they are needed.

## Consequences

- `core` remains use-case agnostic.
- `ui` should ask the active pack how to present objects and build domain commands.
- Domain-specific UI names should stay inside concrete pack modules under `src/packs/*`.
- Static built-in packs are registered in code first.
- Scenario definitions are top-level startup compositions; packs expose capabilities and default providers used by those scenarios.
- Future GitHub-distributed packs should follow the same interface, manifest, namespace, validation, and activation model documented in `docs/packs.md`.
- Pack code is trusted code. Installing a future code pack is equivalent to adding executable code to a control-center platform.

## Deferred

- GitHub pack registry and installer.
- Runtime loading of external TypeScript pack code.
- Pack dependency resolution beyond documentation.
- Sandboxed or data-only packs.
