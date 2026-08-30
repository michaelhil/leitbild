# Agents discover Resources and Capabilities dynamically

Agent Profiles contain behavior, tools, and grants but never Module-specific Resource ids or persistent Agent-to-Resource links. Agents discover compatible Workspace Resources when they act, which avoids hard-coded cross-Module integration and allows new Resource types to participate without changing the Agent model. Leitbild has no generic persistent relationship abstraction; any future continuous cross-Module behavior must have a concrete owner and typed contract.
