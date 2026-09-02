# Process Plant Pack

The Process Plant Pack provides graph-based continuous process simulation while keeping World core independent of process-control details.

## Authored model

Each Process Plant Scenario Item owns:

- `id`, label, and map location
- a Plant Model selection and its validated parameters
- an Operating Point selection and sparse overrides
- an Automation Definition selection
- optional presentation metadata such as cluster and cooling-water labels

Pack configuration is intentionally empty. Scenario compilation turns each Item into one Operational Object and one runtime Plant definition; there is no second authored list joined by id.

The current catalog contains a parameterized reference PWR Model, a full-power Operating Point, and standard graph-derived PWR I&C. Adding another model family should extend this local definition catalog only when a real second family exists. There is no dynamic physics-plugin loader.

## Compilation and runtime

Plant Model data is validated as a typed component graph. Compilation resolves component types, ports, links, variables, tags, limits, services, and solver contracts into immutable indexed structures. The runtime creates an independent variable table and fixed-step clock for each Plant.

The calculation path is:

1. apply queued validated commands;
2. update control logic;
3. solve component and link fluid flow;
4. solve thermal transfer and electrical behavior;
5. update component and process-link state;
6. evaluate I&C and publish selected projections.

Component Types own reviewed TypeScript behavior. Model data selects and parameterizes those types; it cannot inject equations or executable code. Compiled execution plans and topology indexes remove graph scans from hot loops. Compact runtime checkpoints contain only restart state.

## Functional layers

- **Graph**: components, ports, process links, variables, tags, units, limits, and topology validation.
- **Runtime**: fixed-step orchestration, variable table, behavior contracts, physics helpers, topology indexes, and PWR diagnostics.
- **I&C**: typed controls, protection, alarms, trips, permissives, interlocks, lifecycle state, and automatic queued writes.
- **Actions**: discoverable parameterized operations resolved to normal validated commands.
- **Assessments**: named read-only evaluations over graph-owned signals for procedures and agents.
- **Process Displays**: validated signal-bound visualization definitions rendered by reviewed UI widgets.
- **Projection**: compact Plant status on the canonical Operational Object.
- **Recording**: Pack-owned profile-to-signal mapping that emits typed observation batches to the optional Run Historian.
- **Engineering**: schedules, testbeds, telemetry utilities, acceptance traces, credibility checks, and benchmarks that are not exported by the product runtime.

Procedures remain a separate optional World feature. They consume discoverable signals and named assessments and issue normal commands; the Process Plant Pack does not execute procedure documents.

## Public boundaries

The Pack's Simulation Capabilities expose catalog, Plant, graph, variable, signal, I&C, display, diagnostics, and credibility views. All Plant-scoped calls use an explicit `plantId`. Command Capabilities expose control writes, ramps, lifecycle actions, and Action invocation. Their validated schemas are shared by the World UI, Scenario Timeline, and Workspace broker; no Pack-specific HTTP family or implicit current Plant exists.

The Durable Journal records meaningful committed events. Runtime projections update canonical current World state without creating high-frequency event noise. When a Scenario selects a Recording Profile, the Run Historian stores typed time-series samples in Run-local SQLite; samples never become canonical state or checkpoint data.

## Extension rules

- Add a Component Type only with real behavior, initialization, graph contracts, and tests.
- Extend a Plant Model through its explicit validated model builder and family-local structure, not broad string substitution.
- Keep PWR assumptions in PWR Model, I&C, action, assessment, display, and diagnostic contributions rather than the generic graph kernel.
- Address dynamic assets and Plants by stable ids; never rely on current-unit globals or fleet-wide tag aliases.
- Expose new operator or agent functionality through discoverable queries, commands, actions, or Recording Profiles rather than source-code inspection.
- Do not add another registry, DSL, or plugin layer until a concrete second implementation needs it.

Architectural rationale is recorded in [ADR 0027](./adr/0027-single-source-process-plants-and-run-historian.md).
