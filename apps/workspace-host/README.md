# Workspace Host

The Workspace Host is the authoritative public entry point for Workspace lifecycle, Module Membership, navigation, and routing. It stores no Module domain state.

```sh
bun run --cwd apps/workspace-host start
```

Configuration:

- `WORKSPACE_HOST_HOME` — directory containing the Host SQLite database; defaults to `./data/workspace-host`
- `WORKSPACE_MODULES` — JSON array of strict Module registrations
- `WORKSPACE_EXPERIENCES` — JSON array mapping user-facing Experiences to required technical Modules
- `INITIAL_EXPERIENCE_IDS` — JSON array added only when the root route creates the first unnamed Workspace
- `PORT` — HTTP port; defaults to `3100`
- `BIND_HOST` — listener address; defaults to `127.0.0.1`

The Host has no direct-application, Suite, cookie-selection, default-Workspace, compatibility, or migration mode.

## Distribution examples

Module processes receive the Host origin through `WORKSPACE_HOST_URL`. A
combined local distribution uses:

```sh
export WORKSPACE_HOST_URL=http://127.0.0.1:3100
export WORKSPACE_MODULES='[{"moduleId":"microworld","baseUrl":"http://127.0.0.1:4177","manifestPath":"/.well-known/workspace-module"},{"moduleId":"collaboration","baseUrl":"http://127.0.0.1:3000","manifestPath":"/.well-known/workspace-module/collaboration"},{"moduleId":"agents","baseUrl":"http://127.0.0.1:3000","manifestPath":"/.well-known/workspace-module/agents"}]'
export WORKSPACE_EXPERIENCES='[{"id":"leitbild","title":"Leitbild","requiredModules":["microworld"],"entryModuleId":"microworld"},{"id":"samsinn","title":"Samsinn","requiredModules":["collaboration","agents"],"entryModuleId":"collaboration"}]'
export INITIAL_EXPERIENCE_IDS='["leitbild","samsinn"]'
```

Start the two Module processes and then the Host:

```sh
bun run --cwd apps/leitbild start
bun run --cwd apps/samsinn start
bun run --cwd apps/workspace-host start
```

For a Microworld-only distribution, register only `microworld`, install only
the `leitbild` Experience, and set `INITIAL_EXPERIENCE_IDS='["leitbild"]'`.
For a Collaboration/Agents-only distribution, register those two Modules,
install only `samsinn`, and set `INITIAL_EXPERIENCE_IDS='["samsinn"]'`. The
topology, URL rules, and lifecycle contracts remain identical.
