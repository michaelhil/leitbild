# Composable Workspace Platform Rewrite

## Objective

Rebuild Samsinn and Leitbild as distinct Experiences over one Workspace Host and a set of composable domain Modules. Preserve proven domain mechanics by transplanting them behind new boundaries, but carry no old Workspace authority, app-to-app integration, selection cookie, default Workspace, Suite abstraction, compatibility route, API version, or persisted shape into the target.

The benchmark baseline is `main` at `d212523`. The experiment is developed on `experiment/composable-workspace-platform` and does not deploy to production before the final gate.

## Architectural invariants

1. The Workspace Host is the only public entry point and Workspace authority.
2. Modules own domain state and expose validated lifecycle, Resource, Capability, and UI contracts.
3. Experiences compose Modules for users but own no state.
4. Agents discover Resources dynamically and invoke typed Capabilities through explicit Tool Grants.
5. Bindings exist only for durable continuous system behavior.
6. Packs belong to one Module; there is no universal Pack runtime.
7. Combined and single-Experience distributions use the same topology.
8. Workspace identity is URL-only.
9. Templates are optional, apply once, and are not required by the architecture.
10. Every boundary rejects invalid input with a structured error; failures are visible and retryable only when the contract says so.

## Target topology

```text
browser / API / agent host
            |
     Workspace Host
       /     |     \
Microworld Collaboration Agents
       \     |     /
     validated contracts
```

The Host routes requests and aggregates descriptors. It does not copy Module domain state or execute domain behavior.

## Phase 1 — Constitution and executable contracts

- Replace the old domain language and architectural decisions.
- Define strict schemas for Workspace, Module Membership, Module Manifest, Resource Descriptor, Capability Descriptor, Binding, and structured failures.
- Create contract tests for invalid identity, duplicate membership, bad ownership, and forbidden Agent resource links.

Gate: contracts and dependency boundaries pass independently.

## Phase 2 — Workspace Host vertical slice

- Replace Suite with Workspace Host.
- Persist Workspaces and Module Membership in SQLite.
- Implement create, list, read, rename, delete, add Module, remove Module, retry Module, and root auto-create.
- Permit `name: null`; do not create a default Workspace.
- Discover configured Modules and provision their Workspace state with explicit lifecycle status.
- Expose one versionless API and canonical `/workspaces/{workspaceId}` URL family.

Gate: two tabs can use different Workspaces; Module failure is visible and retryable; delete is immediate.

## Phase 3 — Resource and Capability plane

- Let each Module publish Workspace-scoped Resources and Capabilities through its manifest.
- Aggregate descriptors without copying domain payloads into the Host.
- Route invocations to the owning Module with request, Workspace, actor, correlation, and idempotency context.
- Add explicit Bindings only for continuous Resource-to-Resource behavior.

Gate: a caller can discover and invoke a Microworld Capability without knowing a Leitbild-specific endpoint.

## Phase 4 — Shared shell and Experiences

- Build one Svelte 5 shell with Workspaces as root-level navigation.
- Auto-create an unnamed Workspace only when the directory is empty, then redirect to its canonical URL.
- Add create, rename, delete, add/remove Experience, and direct Module navigation.
- Let Module UI contributions render specialised Leitbild and Samsinn surfaces without copying domain state into shell stores.

Gate: Microworld-only, Collaboration/Agents-only, and combined Workspaces share the same interaction model.

## Phase 5 — Microworld Module

- Move Leitbild Workspace state behind the Host lifecycle contract.
- Publish Scenarios, Simulation Runs, and relevant Operational Resources through discovery.
- Publish commands, queries, and streams as typed Capabilities.
- Retain scenario revisions, projections, journals, Runtime Hub, Pack runtimes, and specialised UI as Microworld-owned mechanics.
- Remove local Workspace directory, default Workspace, and public standalone application routing.

Gate: existing simulation acceptance evidence remains equivalent while Workspace ownership and access use only the new Host.

## Phase 6 — Collaboration and Agents Modules

- Separate Room/message/membership behavior from Agent/model/tool/context behavior.
- Publish Rooms and relevant documents as Collaboration Resources.
- Publish Agent lifecycle, tools, context, and evaluations through the Agents Module.
- Remove Workspace cookie selection, local Workspace directory, `leitbildBinding`, special proxy routes, and demo-specific integration setup.
- Replace app-specific Resource access with dynamic discovery and Tool Grants.

Gate: an Agent discovers and operates an available Simulation Run or wiki without a stored Resource id.

## Phase 7 — Packs and UI contributions

- Make every Pack declare one owning Module.
- Keep Module-specific contribution contracts and validation.
- Derive Resource and Capability descriptors from active contributions.
- Register Experience navigation and surfaces through reviewed Module UI contracts rather than arbitrary code injection.

Gate: adding a Pack changes only its owning Module and published descriptors.

## Phase 8 — Demos and optional Templates

- Extract demo prompts, personas, recommended tools, and capability requirements into Demo Definitions.
- Keep Demo Definitions free of concrete Resource ids.
- Add the Workspace Template executor only after two real repeated environment setups exist.
- Validate every Module seed before applying; delete partial newly created state on failure.
- Store provenance only; never reconcile or update an existing Workspace from a Template.

Gate: the PWR demo works through discovery; if Templates qualify, one can reproduce its environment without configuring Agent behavior.

## Phase 9 — Distributions, benchmark, and destructive cutover

- Package combined and single-Experience distributions from the same Host and Module artifacts.
- Add correlated health, startup, lifecycle failure, and cleanup reporting.
- Benchmark behavior, API latency, startup, resource use, test duration, code coupling, and operator steps against `d212523`.
- Delete replaced Suite, local directory, cookie, proxy, compatibility, and duplicated integration code.
- Deploy only after standalone and combined gates pass and no material benchmark regression is unexplained.

## Benchmark scenarios

1. Create an unnamed Workspace and open it from the root URL.
2. Use two different Workspaces concurrently in two tabs.
3. Add and remove Microworld, Collaboration, and Agents Modules.
4. Create a Scenario and Run; reload it from its canonical URL.
5. Let an Agent discover a Run and invoke a permitted command.
6. Mirror a Run event stream into a Room through an explicit Binding.
7. Run the PWR demonstration without special Leitbild configuration in an Agent Profile.
8. Stop one Module, observe explicit degraded status, recover, and retry.
9. Delete a Workspace and verify all Module-owned state is removed.
10. Run Microworld-only and Collaboration/Agents-only distributions with the same URL and lifecycle semantics.
