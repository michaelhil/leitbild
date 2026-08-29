# Experimental Architecture Status

## Implemented topology

```text
                              Workspace Host
                    identity / membership / routing / shell
                         /              |              \
               Microworld       Collaboration        Agents
              state + runtime    rooms + messages   profiles + tools
                    |                                  |
          Microworld Packs                         Agent Packs

Experiences: Leitbild = Microworld
             Samsinn  = Collaboration + Agents
```

The Workspace Host is the sole Workspace authority. An Experience is a
user-facing composition and owns no domain state. Each Module publishes a
strict lifecycle, Resource, Capability, and Workspace-UI contract. The Host
stores only Workspace and Module Membership records and routes domain work to
the owning Module.

Microworld remains a separate process. Collaboration and Agents currently
share the Samsinn process and runtime assembly, but have independent manifests,
lifecycle endpoints, state markers, snapshots, Resource catalogs, and
Capability catalogs. Co-deployment is an operational choice, not a shared
contract; either Module can be provisioned without the other and they can be
split into separate processes later without changing Host contracts.

## User-facing behavior

- `/` creates one unnamed Workspace only when none exist.
- A single configured initial Experience opens immediately; a combined
  distribution creates the configured composition and opens Workspace detail.
- `/workspaces` is the root-level directory for create, rename, compose, open,
  retry, and hard delete.
- Canonical Module UI paths contain the Workspace id. Module root paths return
  to the Host. No cookie or process default selects a Workspace.
- Leitbild and Samsinn retain specialised UIs while sharing the same Workspace
  lifecycle and navigation model.

## Cross-Module interaction

Agents receive resource-independent Tool Grants such as
`microworld.simulation-run.read`. At action time, generic Workspace tools ask
the Host for current Resources and Capabilities, select a Resource from that
response, and invoke its owning Module through the Host. Agent Profiles contain
neither Resource ids nor Module URLs.

The combined integration test proves this against real Microworld,
Collaboration, and Agents Modules. It creates a Simulation Run and Agent,
discovers the Run dynamically from the Agent runtime, invokes the granted read
Capability, and then verifies destructive Workspace cleanup across all Module
shards.

## Packs, demos, and templates

- Every Pack names exactly one owning Module. Current Simulation Packs belong
  to `microworld`; current Agent-facing Packs belong to `agents`.
- Pack contributions remain Module-specific. There is no universal Pack
  loader, universal runtime, or cross-Module executable plugin format.
- Existing demos remain Experience-owned prompts and Agent/Collaboration
  setup. A future demo that uses another Module must declare Capability needs
  and use dynamic discovery; it may not store a Resource id.
- There is no Blueprint model or controller. A Workspace Template remains a
  possible apply-once convenience only after two repeated environment setups
  demonstrate a real need. It may never configure Agent behavior or reconcile
  a live Workspace.
- The Binding schema reserves a clear boundary for continuous system behavior,
  but there is no Binding runtime without a real continuous-behavior use case.
  Ordinary Agent actions remain discovery plus invocation.

## Deliberately deferred

- Authentication and access policy. Workspace scope and actor propagation are
  already explicit so auth can be added at the Host without changing domain
  ownership.
- Production deployment. The experiment must remain separate from the live
  systems until the user accepts its behavior and benchmark.
- A physical Collaboration/Agents process split. Their contracts and storage
  are split now; adding network/process overhead before operationally useful
  would not improve modularity.

## Evidence gates

| Gate | Evidence |
| --- | --- |
| Strict shared contracts | `bun run test:contracts` |
| Workspace and failure lifecycle | `bun run test:host` |
| Microworld standalone behavior | `bun run test:leitbild` and real Host integration |
| Collaboration/Agents behavior | `bun run test:samsinn` and independent Module API tests |
| Combined composition | real three-Module integration test |
| URL-only Workspace identity | route parsers, no selection cookie, canonical path tests |
| Static and type boundaries | `bun run check` |
| Old/new control plane | `bun run benchmark:control-plane` |

Production readiness additionally requires an explicit auth decision,
deployment rehearsal, observability review, backup/restore rehearsal, and a
user acceptance pass. Those are rollout concerns, not reasons to distort the
domain architecture now.
