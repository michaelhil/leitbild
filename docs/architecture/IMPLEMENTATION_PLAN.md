# Architecture Alignment Implementation Plan

## Objective

Align Samsinn and Leitbild around a common Workspace model, predictable extension lifecycle, strict integration contracts, and an optional coordinated suite while preserving their independent domain models, standalone operation, and deployment artifacts.

The refactor is complete only when Workspace and Simulation Run are the sole canonical platform and execution concepts in product code, persistence paths, public APIs, URLs, UI copy, integration bindings, and current documentation.

## Non-negotiable invariants

1. Samsinn and Leitbild remain independently buildable, testable, versioned, deployable, and operable.
2. Neither application imports source code from the other.
3. The shared package contains wire schemas and identifiers only.
4. Each application owns its state and remains available when the suite is unavailable.
5. Leitbild keeps one canonical event commit pipeline and one active Pack Runtime per active Pack in a Simulation Run.
6. Samsinn keeps typed callbacks and intentional REST/MCP surface differences.
7. All external input is validated at the boundary; failures are structured and visible.
8. There is no compatibility or migration layer. Old state is rejected; current state has one canonical shape.
9. Authentication policy is deferred, but every application use case receives an explicit access context so auth can be inserted without changing domain signatures again.

## Target dependency graph

```text
apps/suite ---------> packages/platform-contracts
apps/samsinn -------> packages/platform-contracts
apps/leitbild ------> packages/platform-contracts
integration-tests --> all public application contracts

apps/samsinn -X-> apps/leitbild
apps/leitbild -X-> apps/samsinn
platform-contracts -X-> any application
```

## Phase 0 — Baseline and characterization

### Work

- Record current commits, toolchain versions, test outcomes, deploy entry points, API discovery, URL shapes, storage layouts, and production service names.
- Characterize behavior that remains valid after the clean break: Rooms, Agents, Simulation Runs, bindings, snapshots, journals, and share URLs.
- Record environmental test dependencies separately from deterministic failures.

### Gate

- Samsinn type-check and non-Ollama suite pass.
- Leitbild type-check and full suite pass.
- No production or source data is changed.

## Phase 1 — Behavior-neutral monorepo migration

### Work

- Import both Git histories below `apps/`.
- Add a root Bun workspace without replacing application lockfiles until reproducibility is proven.
- Add root commands for check, test, and package-specific execution.
- Add dependency rules preventing application-to-application imports and preventing contracts from importing applications.
- Adapt deploy scripts only for the new working-directory prefix; do not change release behavior.

### Gate

- Application commit histories remain reachable.
- Both applications produce the same build outputs and pass their Phase 0 checks from their new paths.
- Existing deployment dry-runs produce equivalent release manifests.

### Rollback

- Existing repositories remain untouched and deployable until final cutover.

## Phase 2 — Domain model and platform contracts

### Work

- Establish `Deployment`, `Workspace`, `Module`, `Module Binding`, `Pack`, `Capability`, `Scenario Revision`, and `Simulation Run` as canonical terms.
- Add branded Workspace and request identifiers.
- Add strict schemas for structured errors, request context, discovery, module bindings, event transport metadata, pack descriptors, contribution descriptors, and capability descriptors.
- Publish JSON Schema/OpenAPI fragments from the same validated source where useful; do not maintain duplicate handwritten schemas.
- Validate one canonical discovery and Module Binding shape; do not negotiate API versions or accept alternate contract shapes.

### Gate

- The contracts package has no application imports or runtime-side effects.
- IDs are opaque; display slugs are never canonical identity.
- Strict contract rejection paths are tested.

## Phase 3 — Workspace foundation

### Work

- Define a `WorkspaceDirectory` port in each application using platform contract values at the boundary and application-owned types internally.
- Implement a real local filesystem directory for standalone mode.
- Add explicit `WorkspaceContext` and `AccessContext` to application use cases. The initial access policy allows the current open mode.
- Introduce deployment-scoped defaults and a deliberate default Workspace for standalone local startup.
- Make WebSocket connections and background jobs carry Workspace Id explicitly.

### Gate

- Two Workspaces in the same process cannot read, mutate, subscribe to, or persist into each other's state.
- Each application starts and works without the suite.
- An unavailable external directory prevents new provisioning with a structured error but does not terminate already loaded Workspace runtimes.

## Phase 4 — Samsinn restructuring

### Work

- Rename the external Instance concept to Workspace across types, registry, cookie/query selection, UI, API, logs, diagnostics, and persistence.
- Rename `SharedRuntime` to `DeploymentRuntime` and limit it to genuinely deployment-scoped resources.
- Replace the public `System` god-interface with a `SamsinnWorkspaceRuntime` composition root exposing narrow application services.
- Split `House` into room directory, Workspace settings, and bookmark responsibilities without introducing a generic event bus.
- Make REST, WebSocket commands, and MCP tools call application use cases rather than navigating internal aggregates directly.
- Change storage to `data/workspaces/<workspaceId>/samsinn` through one path policy.
- Make pack installation deployment-scoped, Workspace availability explicit, and Room activation the effective allowlist.
- Resolve geodata and every other pack contribution only from packs effective for the current Workspace/Room.

### Gate

- Existing room, agent, messaging, script, trigger, document, logging, and provider behavior is characterized and preserved.
- No route or adapter accesses `house`, `team`, provider internals, or persistence stores directly.
- Cross-Workspace isolation and pack activation have end-to-end tests.

## Phase 5 — Leitbild restructuring

### Work

- Use Simulation Run consistently throughout domain code, API, realtime, UI, metrics, persistence, tests, and documentation.
- Use opaque `SimulationRunId`; remove the encoded `scenarioId:runId` identity.
- Add Workspace-owned Scenario records and immutable Scenario Revisions. Built-in scenario configs remain deployment templates that can be materialized into a Workspace library.
- Persist a Run Manifest containing Workspace Id, Scenario Revision snapshot/digest, selected Packs, resolved Pack/runtime versions, creation time, and lifecycle state.
- Make a Simulation Run permanently reference one Scenario Revision. Reset restores that revision; another revision requires another run.
- Split the current runtime into lifecycle, command, query, projection, event commit, runtime hub, and persistence services while retaining one ordered commit path.
- Change storage to `data/workspaces/<workspaceId>/leitbild/simulation-runs/<runId>`.
- Keep deletion explicit and immediate. Do not add archive/trash lifecycle without a product need.

### Gate

- Reload never reapplies a Scenario Definition.
- Restores use the pinned Scenario Revision and reject incompatible Pack/runtime versions visibly.
- Run sequence ordering, projections, journals, runtime-private state, and realtime scoping remain correct.
- Scenario mismatch can never reset or replace an existing run implicitly.

## Phase 6 — Pack and capability alignment

### Work

- Add the common Pack Descriptor envelope: id, application, version, runtime requirements, dependencies, and declared contribution kinds.
- Keep application-specific typed contribution contracts.
- Make Samsinn pack manifests strict and transactional: malformed descriptors or contributions fail installation without partially mutating the catalog.
- Split Leitbild's broad pack interface into independently optional contribution groups: scenario, runtime, presentation, interaction, reference data, commands, and queries.
- Validate duplicate ids, dependency cycles, unsupported versions, runtime ownership, and contribution conflicts at registration.
- Derive a Capability Manifest from effective active contributions; never persist it as a second source of truth.

### Gate

- Packs are installed at Deployment scope, available at Workspace scope, selected/configured by resources, and activated at runtime.
- Packs from one application are never loadable by the other unless a future explicit adapter is added.
- Capability results change immediately and predictably when effective Pack selection changes.

## Phase 7 — Scoped APIs, realtime, and integration

### Work

- Add `/api/workspaces/{workspaceId}/...` resource trees.
- Standardize structured errors, cursors, revisions/ETags, timestamps, correlation/causation ids, and idempotency keys.
- Add versionless discovery manifests advertising Workspace scope, links, capabilities, and current open access posture.
- Make realtime clients subscribe to explicit Workspace/resource scopes with sequence-based resume.
- Preserve intentional REST/MCP task differences while routing both through the same use cases.
- Replace duplicated Samsinn Leitbild URLs and Run ids with one Workspace Module Binding and Room-level Simulation Run binding. Agents inherit Room context unless explicitly overridden.
- Remove old APIs and clients in the same cut. Do not ship aliases, redirects, or deprecation adapters.

### Gate

- Contract tests cover both applications and the Samsinn-to-Leitbild integration.
- Stale revisions, duplicate idempotency keys, malformed discovery, and scope mismatches return distinct structured errors.
- No current integration client relies on tolerant guessing of alternate response shapes.

## Phase 8 — Optional suite

### Work

- Implement a minimal Workspace Directory and navigation shell.
- Store only Workspace metadata, enabled Module ids, Module Bindings, and provisioning status.
- Provision application shards through their canonical Workspace APIs.
- Add aggregate status and links without proxying or copying application state.
- Cache known bindings in each application so directory downtime does not end active work.

### Gate

- Samsinn-only, Leitbild-only, and combined deployments pass the same contract suite.
- Stopping the suite leaves existing direct application URLs operational.
- The suite database contains no Rooms, Agents, Scenarios, Simulation Runs, Pack settings, events, or projections.

## Phase 9 — Clean cutover

### Work

- Switch each application directly to its canonical Workspace storage and API shape.
- Reject old snapshot, manifest, journal, cookie, URL, and identifier shapes visibly.
- Remove old terminology, routes, builders, types, and tests in the same change.
- Start with empty application state where old state cannot be read safely under the new model.

### Gate

- No compatibility adapter or migration command exists in production code.
- Unsupported persisted shapes fail visibly and never receive an implicit reinterpretation.
- Only the canonical URL and storage layout are documented and tested.

## Phase 10 — Final verification and deployment

### Work

- Run type checks, unit/integration tests, dependency checks, UI builds, deployment tests, restore tests, strict old-shape rejection tests, and combined failure drills.
- Test multiple Workspaces, multiple Runs, concurrent clients, suite outage, application outage, incompatible Pack versions, corrupt manifests, and stale URLs.
- Deploy independently built Samsinn and Leitbild artifacts.
- Run production health, persistence, URL-sharing, realtime, and cross-application smoke checks.
- Tag and document the cutover only after both services pass.

## Adversarial review

### Monorepo could create accidental coupling

**Failure mode:** applications begin sharing convenience code or require coordinated releases.

**Countermeasure:** dependency rules permit only contracts imports; separate manifests, versions, artifacts, and deployment jobs remain mandatory. A test matrix exercises each application without the other present.

### Workspace could become a junk-drawer aggregate

**Failure mode:** the suite or contracts package accumulates Rooms, Runs, Pack settings, users, or events.

**Countermeasure:** Workspace owns identity and module membership only. Application shards own every domain resource. Contract review rejects application nouns from platform storage schemas.

### The shared contract could become a lowest-common-denominator domain model

**Failure mode:** domain events and runtime abstractions are forced into generic types that fit neither system.

**Countermeasure:** share only wire envelopes and identifiers. Payloads remain application schemas. Domain events stay private; only integration-boundary metadata aligns.

### Scenario revisions and version pinning could be premature complexity

**Failure mode:** excessive version machinery slows ordinary scenario iteration.

**Countermeasure:** revisions are immutable normalized snapshots created automatically. Users edit a Scenario and the system creates a revision on save/run. Pinning is necessary because shared URLs and restored Runs must not change when templates or Pack code change.

### Pack splitting could replace one god-interface with abstraction confetti

**Failure mode:** every function gets a tiny interface with no independent lifecycle.

**Countermeasure:** split only contribution groups that are optional, independently consumed, independently validated, or server/UI/runtime separated. Keep cohesive functions together.

### A clean break could silently reinterpret old state

**Failure mode:** an old snapshot happens to parse under the new type names and is loaded with incorrect scope or scenario semantics.

**Countermeasure:** bump persisted schema versions, require Workspace and Scenario Revision identity, and reject every old shape. No heuristic inference or fallback paths.

### Compatibility code could creep back in

**Failure mode:** aliases or tolerant parsers are added during implementation to make old tests pass.

**Countermeasure:** old tests and fixtures are replaced, not accommodated. Boundary tests assert that old terms, paths, and persisted versions are rejected.

### The suite could become a single point of failure

**Failure mode:** Workspace directory downtime prevents active Rooms or Runs from operating.

**Countermeasure:** active application runtimes use locally resolved Workspace context and cached bindings. Directory failure blocks provisioning/metadata changes visibly, not current domain work.

### Auth deferral could force another signature-wide refactor

**Failure mode:** domain and application APIs assume every request is trusted and later need caller parameters everywhere.

**Countermeasure:** add Access Context now with an open policy provider. Do not implement accounts, login, roles, or ACL storage in this pass.

### The refactor could become an unreviewable big bang

**Failure mode:** naming, behavior, storage, API, and deployment change in one irreversible commit.

**Countermeasure:** the phases above are separately committed and gated. Repository movement is behavior-neutral; internal seams precede the clean public cutover; old state is discarded rather than migrated.

## Completion criteria

- Workspace and Simulation Run are the only canonical platform and execution terms.
- Both applications run standalone and together.
- One Workspace Id scopes both applications without duplicated identity mappings.
- Scenario revisions and Pack/runtime versions make Run restore deterministic or fail visibly as incompatible.
- All adapters call application use cases; no transport reaches directly into aggregates or persistence.
- Pack activation and Capability Manifest derivation are consistent at every scope.
- Old persisted and wire shapes are rejected, with no migration or compatibility path.
- Independent production deployments and combined smoke tests pass.
