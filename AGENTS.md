# Leitbild Platform Agent Instructions

These rules apply across the repository. Module-local `AGENTS.md` files may add stricter domain rules but may not weaken these platform boundaries.

- The Leitbild Host is the only public product entry point and the sole owner of Workspace identity, display metadata, and core Module provisioning state.
- A Module owns its domain state and behavior. The Host must not own Rooms, Agents, Scenarios, Simulation Runs, Pack configuration, projections, or runtime-private state.
- Modules communicate through `packages/contracts`; they never import another Module's implementation.
- The contracts package contains identifiers and validated wire schemas, not shared business logic, persistence services, runtime implementations, or UI components.
- Every Workspace provisions the World, Collab, and Agents core Modules. Do not add Experiences, user-controlled Module installation, or alternate Workspace compositions.
- Agents discover Resources and Capabilities at runtime. Do not persist Module-specific resource ids or bindings in Agent configuration.
- A Binding is allowed only for continuous system behavior that must persist without an Agent choosing on every action.
- Packs belong to exactly one Module. Do not create a universal Pack runtime.
- A Workspace Template is an optional apply-once factory. It must not configure Agents, grants, workflows, resource bindings, or ongoing reconciliation.
- Workspace identity is carried in canonical URL paths. Cookies must not select or override a Workspace.
- Expensive Module runtimes remain lazy even though all core Modules are provisioned for every Workspace.
- Use Bun 1.4.0 and TypeScript. Prefer functional modules, factory functions, explicit ports, and validated boundaries.
- Do not add silent fallbacks, mocks in production, compatibility behavior, API versions, migrations, aliases, archives, or legacy parsing.
- Commit each logical phase separately. Do not deploy this experimental branch to production until its standalone, combined, and baseline benchmark gates pass.
