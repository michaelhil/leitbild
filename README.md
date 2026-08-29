# Samsinn–Leitbild Platform

This repository coordinates the independently deployable Samsinn and Leitbild applications and the small contracts they intentionally share.

The applications remain standalone products. A combined deployment may place both inside one Workspace, but neither application imports or owns the other's domain state.

## Repository layout

- `apps/samsinn` — multi-agent collaboration application
- `apps/leitbild` — operational simulation application
- `apps/suite` — optional Workspace directory and navigation shell
- `packages/platform-contracts` — versioned wire schemas and identifiers only
- `packages/integration-tests` — standalone and combined contract tests
- `docs/architecture` — implementation plan and architecture documentation
- `docs/adr` — cross-application architectural decisions

Each application retains its own package manifest, tests, deployment artifact, and release version.
