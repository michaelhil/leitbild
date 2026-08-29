# Platform Agent Instructions

These rules apply across the repository. Application-local `AGENTS.md` files add stricter rules within their own directories.

- Samsinn and Leitbild are independently deployable applications. They must never import from each other.
- Cross-application source imports are limited to `packages/platform-contracts`.
- Platform contracts contain identifiers and wire schemas, not shared business logic, persistence, runtime services, or UI components.
- Every application must remain usable with a local Workspace directory when the suite application is absent.
- The suite owns Workspace metadata and module bindings only. It must not own rooms, agents, scenarios, simulation runs, pack configuration, projected state, or runtime-private state.
- Use Bun 1.4.0 and TypeScript. Prefer functional modules, factory functions, explicit ports, and validated boundaries.
- Do not add silent fallbacks or compatibility behavior without a visible warning, a test, and a removal condition.
- Persistence changes are clean breaks unless the user explicitly requests a migration. Do not add automatic migration, compatibility parsing, aliases, or archive paths.
- Commit each logical phase separately. Do not deploy a phase until its standalone and combined acceptance gates pass.
