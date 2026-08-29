# Leitbild

Leitbild is a multi-agent collab system. Humans and AI Agents work together in Rooms, with configurable delivery, tools, scripts, knowledge, and persistent Workspace state.

Leitbild is independently deployable as two composable Workspace Modules. It imports no Leitbild code. A Workspace Host can compose it with World or future Modules through shared contracts.

## Architecture

- A **Deployment** is one running Leitbild installation and owns provider configuration plus installed Packs.
- A **Workspace** is an opaque UUID owned by the Workspace Host.
- The **Collab Module** owns Rooms, messages, membership, documents, and collab behavior.
- The **Agents Module** owns AI Agent Profiles, model execution settings, tools, memory, and evaluations.
- A **Room** is a durable collab space inside one Workspace.
- An **Agent** is a human or AI collab identity inside one Workspace.
- A **Pack** is a strict, Leitbild-specific extension installed at Deployment scope and activated per Room.
- A **Capability Manifest** is derived from the effective Pack descriptors; it is never a second source of truth.

The Modules share one runtime process but publish separate manifests, lifecycle endpoints, state markers, snapshots, Resources, and Capabilities. Every Workspace provisions both; their state ownership remains distinct.

Workspace identity is URL-carried. No local directory, display name, cookie, or Leitbild record is allowed to become a second Workspace authority. Cross-Workspace reads, writes, realtime subscriptions, and persistence paths are rejected by construction.

The canonical domain language is documented in [CONTEXT.md](CONTEXT.md). The cross-application boundaries are documented in the repository [context map](../../CONTEXT-MAP.md).

## Quick start

Requirements: Bun 1.4.0 and at least one configured LLM provider. Ollama is optional.

```sh
bun install
ollama pull llama3.2       # optional local provider
bun run start
```

Run the Workspace Host and set `WORKSPACE_HOST_URL` for the Leitbild process. Enter through the Host; it creates and provisions Workspaces. Headless MCP mode can explicitly provision a local Workspace for its process-scoped session.

Useful commands:

```sh
bun run dev
bun run check
bun test
bun run build:css
bun run headless
```

## Workspaces and composition

The Workspace Host is the sole owner of Workspace identity, names, enabled Module membership, and composition. Leitbild accepts Host-supplied UUIDs only through each Module's lifecycle endpoint and owns only its Module data beneath that identity.

- The Host provisions Collab and Agents independently.
- `/workspaces/{workspaceId}/collab` and `/workspaces/{workspaceId}/agents` are the focused application URLs.
- `/workspaces` is the Host-managed Workspace collection UI.
- Agents discover the current Workspace's Resources and Capabilities through the Host.
- Agent Tool Grants store Capability ids only. The Agent selects a Resource at invocation time.

Rooms and Agents never copy Module base URLs, discovery URLs, or external Resource ids.

## API

Leitbild has one versionless public API. There are no old aliases, redirects, alternate response shapes, or version negotiation.

Module discovery and lifecycle are available at:

```text
GET /.well-known/workspace-module/collab
GET /.well-known/workspace-module/agents
PUT|DELETE /internal/{moduleId}/workspaces/{workspaceId}
GET /internal/{moduleId}/workspaces/{workspaceId}/resources
GET /internal/{moduleId}/workspaces/{workspaceId}/capabilities
POST /internal/{moduleId}/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke
```

Deployment resources are intentionally unscoped:

```text
/api/auth
/api/system/info
/api/system/diagnostics
```

All collab resources are Workspace-scoped:

```text
/api/workspaces/{workspaceId}/collab/settings
/api/workspaces/{workspaceId}/collab/rooms
/api/workspaces/{workspaceId}/agents
/api/workspaces/{workspaceId}/collab/messages
/api/workspaces/{workspaceId}/collab/scripts
/api/workspaces/{workspaceId}/collab/documents
/api/workspaces/{workspaceId}/collab/packs
/api/workspaces/{workspaceId}/{collab|agents}/ws
```

The browser derives Workspace identity only from the URL. The server rejects unscoped application routes.

REST, WebSocket, and MCP are intentional task interfaces over the same Workspace runtime; they are not required to expose identical transport operations.

## Rooms and Agents

Rooms provide:

- durable messages and membership;
- broadcast or manual delivery;
- directed `[[AgentName]]` and `[[tag:name]]` addressing;
- pause and per-Agent mute state;
- summaries, bounded context compression, todos, scripts, triggers, and Room Pack activation.

AI Agents provide:

- an editable persona and preferred model;
- provider fallback without changing the stored preference;
- a Pack-filtered tool surface;
- configurable prompt/context sections;
- Room history plus optional persistent memory and document retrieval.

## Packs

Each Pack requires a strict `pack.json` containing the shared descriptor envelope and Leitbild-specific metadata. The descriptor declares:

- Pack id and version;
- owning Module (`leitbild`);
- exact supported platform range;
- dependencies;
- contribution kinds such as tools, skills, scripts, geodata, wikis, and UI extensions.

Malformed manifests, duplicate ids, missing dependencies, and unsupported contribution declarations fail visibly. Packs are installed at Deployment scope; a Room's active Pack set is the effective allowlist for Agent tools and Pack geodata.

Authored local extensions use the same layout under `$LEITBILD_HOME/packs/local/`. Leitbild does not migrate or interpret older extension layouts.

## Cross-Module tools

Leitbild contains no World- or application-specific integration client. When the Workspace contains other Modules, AI Agents use three generic tools:

- `workspace_resources` discovers live Resource descriptors;
- `workspace_capabilities` discovers callable operations;
- `workspace_invoke` invokes a granted Capability against a Resource selected for that call.

This keeps Agent behavior configurable and makes future Modules available without adding another Leitbild integration subsystem. Continuous event-driven behavior is a separate explicit Binding concern; ordinary discovery and commands do not create Bindings.

## Persistence

`LEITBILD_HOME` defaults to `~/.leitbild`.

```text
$LEITBILD_HOME/
  providers.json
  llm-policy.json
  packs/
  workspaces/{workspaceId}/
    collab/
      workspace.json
      snapshot.json
      logs/
      documents/
    agents/
      workspace.json
      snapshot.json
      memory/
      vectors.jsonl
```

Each Module accepts only its current strict snapshot shape. Unsupported or cross-owned fields are rejected; there is no migration ladder, compatibility parser, or combined legacy snapshot.

## Configuration and auth posture

Provider keys are configured through Settings or environment variables and are never returned by the API. Common Deployment settings are documented in [deploy/env.example](deploy/env.example).

Authentication remains deliberately simple while the architecture stabilizes:

- without `LEITBILD_TOKEN`, the Deployment is open;
- with `LEITBILD_TOKEN`, shared-token login issues an authentication session cookie;
- every application use case already carries explicit Workspace and access context so richer policy can be added without changing domain signatures.

The session cookie authenticates access only; it never selects a Workspace. Access policy does not alter Workspace identity or resource ownership.

## Development and deployment

Run before committing:

```sh
bun run check
bun test
bun run build:css
```

The root workspace also verifies application boundaries and shared contracts:

```sh
bun run check
bun run test
```

Production operations are documented in [deploy/RUNBOOK.md](deploy/RUNBOOK.md). Leitbild and Leitbild retain independent build artifacts, services, releases, and rollback procedures.

## Security

Leitbild is powerful software: Agents can use configured tools, network services, and locally installed Pack code. Treat Pack installation and code-generation settings as operator trust decisions. Deployments should use TLS, a strong token, restricted file permissions, and conservative tool enablement.

## License

MIT
