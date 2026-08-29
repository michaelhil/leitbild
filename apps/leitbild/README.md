# Leitbild Host

The Host is the sole Workspace authority and public entry shell. It provisions World, Collab, and Agents for every new Workspace and aggregates their Resources and Capabilities without owning their domain state.

Required environment:

```bash
WORKSPACE_HOST_URL=http://127.0.0.1:3100
WORKSPACE_MODULES=[{"moduleId":"world","internalBaseUrl":"http://127.0.0.1:4177","manifestPath":"/.well-known/workspace-module"},{"moduleId":"collab","internalBaseUrl":"http://127.0.0.1:3000","manifestPath":"/.well-known/workspace-module/collab"},{"moduleId":"agents","internalBaseUrl":"http://127.0.0.1:3000","manifestPath":"/.well-known/workspace-module/agents"}]
```

Root behavior is deterministic: zero Workspaces opens onboarding, one resumes that Workspace, and multiple open the manager. Workspace selection is always encoded in the URL.

Run locally with `bun run --cwd apps/leitbild start`. Production deploys are issued only from the repository root with `bun run deploy`.
