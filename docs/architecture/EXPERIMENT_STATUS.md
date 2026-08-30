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

The orchestration model is Definition → Resource → Capability. World owns Scenario and Fragment compilation; Agents owns Room Definitions, Agent Scripts, and Prompt Decks; the Host owns only independent apply-once Presets that reference stable Module Definition IDs. Ongoing automation stays inside the owning Module rather than a shared workflow engine.
