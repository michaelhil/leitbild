# Leitbild Platform Agent Instructions

These rules apply across the repository. Module-local `AGENTS.md` files may add stricter domain rules but may not weaken these platform boundaries.

- The Leitbild Host is the only public product entry point and the sole owner of Workspace identity, display metadata, and core Module provisioning state.
- A Module owns its domain state and behavior. The Host must not own Rooms, Agents, Scenarios, Simulation Runs, Pack configuration, projections, or runtime-private state.
- Modules communicate through `packages/contracts`; they never import another Module's implementation.
- The contracts package contains identifiers and validated wire schemas, not shared business logic, persistence services, runtime implementations, or UI components.
- Every Workspace provisions the World and Agents core Modules. Rooms and messaging are internal Agents domains, not another Module. Do not add Experiences, user-controlled Module installation, or alternate Workspace compositions.
- Agents discover Resources and Capabilities at runtime. Do not persist Module-specific resource ids or bindings in Agent configuration.
- A Binding is allowed only for continuous system behavior that must persist without an Agent choosing on every action.
- Packs belong to exactly one Module. Do not create a universal Pack runtime.
- Pack descriptors declare provenance and contribution identities; exact callable operations belong to the owning Module's Capability Registry. Do not derive vague Pack capabilities from contribution kinds.
- The Host launches Module Definitions only through their published Capabilities. Do not add a separate Host-owned demo catalog or hidden cross-Module launch logic.
- Definitions, Resources, and Capabilities are the common orchestration model. Modules own Definition schemas and compilation, Resource state, Capability handlers, and ongoing automation.
- Reusable composition fragments belong to one Module. Do not add a universal fragment runtime, arbitrary inheritance, merge-patch language, or cross-Module fragment.
- Workspace identity is carried in canonical URL paths. Cookies must not select or override a Workspace.
- Expensive Module runtimes remain lazy even though all core Modules are provisioned for every Workspace.
- Use Bun 1.4.0 and TypeScript. Prefer functional modules, factory functions, explicit ports, and validated boundaries.
- Do not add silent fallbacks, mocks in production, compatibility behavior, API versions, migrations, aliases, archives, or legacy parsing.
- Commit each logical phase separately. Deploy only after standalone and combined validation passes.
