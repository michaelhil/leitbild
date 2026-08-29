# Architecture status

The target topology is:

```text
Leitbild Host
  └─ Workspace
      ├─ World
      └─ Agents
```

Workspace creation provisions both core Modules. World and Agents have separate manifests and runtimes; Rooms and Agent Profiles remain internally separated within Agents. Cross-Module interaction uses dynamically discovered Resources and Capabilities, so Agent profiles do not store concrete World asset or Simulation Run IDs.

The shared shell provides creation, rename, deletion, module health/retry, and direct module navigation. Root selection is URL-only. Deployment is a single release and one Caddy origin at `leitbild.app`.
