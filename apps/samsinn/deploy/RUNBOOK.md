# Samsinn production runbook

Production is the normal integration and testing runtime. Edit and validate in
the permanent local checkout, then deploy a complete immutable release directly
over the configured `ssh samsinn` alias. GitHub is backup and collaboration,
not a deployment transport.

## Routine release

```bash
cd /Users/hilde/Documents/ChatGPT/Samsinn
bun run deploy -- --dry-run   # optional rehearsal
bun run deploy               # guarded production deployment
```

The deployer runs type checks, deterministic unit tests, and the CSS build;
blocks active agent generations; uploads a complete code artifact; atomically
switches `/opt/samsinn-deploy/current`; restarts Samsinn; and verifies health
and WebSocket message delivery. See [RELEASES.md](RELEASES.md) for layout,
provenance, and rollback details.

## Operations

Use the `manage-samsinn-server` skill helpers:

```bash
scripts/samsinn-ops health
scripts/samsinn-ops status
scripts/samsinn-ops metrics
scripts/samsinn-ops preflight
scripts/samsinn-ops logs 100
```

Production mutations—including deploys, restarts, configuration changes,
updates, and cleanup—require explicit confirmation immediately beforehand.

## Persistent state and secrets

- `/var/lib/samsinn`: Workspaces, provider configuration, packs, and logs
- `/etc/samsinn/env`: production environment, root-owned mode `0600`
- `/etc/systemd/system/samsinn.service`: active service unit
- `/etc/caddy/Caddyfile`: public TLS/reverse-proxy configuration

Never copy persistent state or secrets into a release artifact, Git, or logs.
Authentication is intentionally disabled for the trusted-colleague sandbox;
retain spend limits, resource caps, backups, observability, and operational
safety controls.

## Rollback

```bash
bun run deploy -- --list
bun run deploy -- --rollback <release-id>
```

Rollback changes code only. Persistent state remains in `/var/lib/samsinn`.

## GitHub

Push useful milestones for off-machine backup and CI. No GitHub workflow or
server-side Git checkout is authorized to deploy or mutate production.
