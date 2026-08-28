# Leitbild code releases

Production is the everyday integration/test runtime. Edit locally, run the
relevant local gate, deploy a complete immutable code artifact, and test at
`https://leitbild.samsinn.app`.

Routine code deployment never builds, copies, promotes, or deletes maps,
terrain, scenery, reference datasets, OSRM data, or Control Instance state.

## Normal loop

```bash
# Quick rehearsal with tests relevant to this change.
bun run deploy -- --dry-run --test tests/discovery.test.ts

# Interactive production deployment with the same selected tests.
bun run deploy -- --test tests/discovery.test.ts

# Milestone/cross-cutting validation (currently about 90 seconds locally).
bun run deploy -- --full
```

Quick mode always runs `bun run check` and `bun run build:ui`. Supply one or
more `--test <path-or-pattern>` options for affected behavior. `--full` runs all
tests and cannot be combined with `--test`.

The first migration to the release-layout unit requires:

```bash
bun run deploy -- --test scripts/deploy.test.ts --update-service
```

## Artifact and provenance

The artifact includes all tracked files, non-ignored untracked files, and the
ignored but verified `src/ui/dist` build. `DEPLOYMENT.json` records the base
commit, dirty worktree entries, content digest, selected validation gate, and
the production roots excluded from deployment.

The current compressed artifact is about 4 MiB. Linux dependencies are shared
by `bun.lock` checksum, so ordinary source changes do not reinstall them.

```text
/opt/leitbild/current                 atomic active-release symlink
/opt/leitbild/releases/<release-id>  immutable code + UI + manifest
/opt/leitbild/deps/<lock-sha>         Linux node_modules for one lock

/opt/leitbild/data                    persistent Control Instance state
/opt/leitbild/maps                    persistent static map artifacts
/opt/leitbild/reference               persistent reference datasets
/opt/leitbild/osrm-data               persistent routing data
```

The four persistent roots are outside every code release and are untouched by
the deploy transaction. Caddy continues serving static map/reference artifacts
directly from their existing production paths.

## Safety and rollback

Preflight checks Samsinn, Leitbild, Caddy, disk headroom, local health, and
active Samsinn generations. Activation switches `current` atomically, restarts
only Leitbild, and verifies health, scenario discovery, map capabilities, and
the current scenery manifest. Failure reactivates the previous code release.

```bash
bun run deploy -- --list
bun run deploy -- --rollback <release-id>
```

Releases and dependency trees are deliberately not auto-pruned. Retention is a
separate operator action, so an ordinary code deploy cannot destroy rollback
data.
