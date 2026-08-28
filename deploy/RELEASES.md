# Samsinn production releases

Production is the everyday integration/test runtime. Source is edited locally,
validated locally, and deployed directly over the configured `ssh samsinn`
alias. A GitHub push is not required.

## Normal loop

```bash
# Optional packaging rehearsal; performs the complete deterministic gate.
bun run deploy -- --dry-run

# Interactive production deployment.
bun run deploy
```

The deploy gate runs `bun run check`, `bun run test:unit`, and
`bun run build:css`. Tests requiring a local Ollama daemon are deliberately not
part of this deterministic gate; production streaming is checked after restart.

The first migration to the release-layout unit requires:

```bash
bun run deploy -- --update-service
```

`--update-service` backs up the live unit before installing the repository
template. Use it later only when intentionally changing the service template.

## What is deployed

The artifact contains every tracked file, every non-ignored untracked file, the
ignored but verified `src/ui/dist.css`, and `DEPLOYMENT.json`. The manifest
records the base commit, branch, dirty worktree entries, source digest, file
count, validation gate, and release id.

The complete compressed artifact is currently about 1–2 MiB. Production
dependencies are installed once per `bun.lock` checksum and shared read-only by
release symlink. Startup does not pull Git or resolve packages.

Persistent state remains exclusively under `/var/lib/samsinn` and is never
included, deleted, reset, or restored by this deployer.

## Production layout

```text
/opt/samsinn-deploy/current                 atomic active-release symlink
/opt/samsinn-deploy/releases/<release-id>  immutable source + manifest
/opt/samsinn-deploy/deps/<lock-sha>         Linux node_modules for one lock
/var/lib/samsinn                            persistent application state
```

The previous `/opt/samsinn` Git checkout remains untouched during the initial
migration so the backed-up systemd unit can restore the legacy service if first
activation fails. Remove it only after the release path has been proven and a
separate deletion is approved.

## Safety and rollback

Before upload, the deployer checks both application services, Caddy, local
health, disk headroom, active Samsinn generations, and the expected systemd
layout. Connected browsers are reported but do not block deployment. An active
agent generation blocks it.

Activation uses an atomic `current` symlink switch. Failed local health or
streaming smoke checks reactivate the previous code release. The deployer does
not attempt persistent-data migrations.

```bash
bun run deploy -- --list
bun run deploy -- --rollback <release-id>
```

Releases and dependency trees are not automatically deleted. Retention cleanup
is a separate operator action so a routine deploy cannot destroy rollback data.

## GitHub

Commit when a logical change is worth preserving and push at milestones for CI,
collaboration, and off-machine backup. The legacy pull-based deployment is
available temporarily as `bun run deploy:legacy`; do not use it after the
systemd unit has moved to `/opt/samsinn-deploy/current`.
