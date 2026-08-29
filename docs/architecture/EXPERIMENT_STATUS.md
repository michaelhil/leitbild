# Architecture status

The experimental branch now implements the target topology:

```text
Leitbild Host
  └─ Workspace
      ├─ World
      ├─ Collab
      └─ Agents
```

Workspace creation provisions all core Modules. World runs independently; Collab and Agents retain separate manifests and state ownership while sharing a process and runtime assembly. Cross-Module interaction uses dynamically discovered Resources and Capabilities, so Agent profiles do not store concrete World asset or Simulation Run IDs.

The shared shell provides creation, rename, deletion, module health/retry, and direct module navigation. Root selection is URL-only. Deployment is a single release and one Caddy origin at `leitbild.app`.
