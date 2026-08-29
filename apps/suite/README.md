# Samsinn + Leitbild Suite

The suite is an optional Workspace directory and navigation shell. It discovers configured applications, provisions the same opaque Workspace ID in each, records Module Bindings and provisioning status, and links directly to each application.

It does not proxy application traffic or store Rooms, Agents, Scenarios, Simulation Runs, Packs, events, or projections. Samsinn and Leitbild remain independently deployable and usable without it.

```sh
SAMSINN_URL=http://localhost:3000 \
LEITBILD_URL=http://localhost:3001 \
bun run --cwd apps/suite start
```

Set `SUITE_HOME` for the suite directory file and `PORT`/`BIND_HOST` for its HTTP listener.
