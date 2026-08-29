# Workspace Host

The Workspace Host is the authoritative public entry point for Workspace lifecycle, Module Membership, navigation, and routing. It stores no Module domain state.

```sh
bun run --cwd apps/workspace-host start
```

Configuration:

- `WORKSPACE_HOST_HOME` — directory containing the Host SQLite database; defaults to `./data/workspace-host`
- `WORKSPACE_MODULES` — JSON array of strict Module registrations
- `INITIAL_MODULE_IDS` — JSON array added only when the root route creates the first unnamed Workspace
- `PORT` — HTTP port; defaults to `3100`
- `BIND_HOST` — listener address; defaults to `127.0.0.1`

The Host has no direct-application, Suite, cookie-selection, default-Workspace, compatibility, or migration mode.
