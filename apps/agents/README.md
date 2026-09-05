# Leitbild

Leitbild Agents is a multi-agent collaboration environment. Humans and AI Agents work together in Rooms, with configurable delivery, tools, scripts, knowledge, and persistent Workspace state.

Agents is an independently runnable and testable Workspace Module. Production ships it with Host and World in one Leitbild release; it imports no World or Host implementation code.

## Architecture

- A **Deployment** is one running Leitbild installation and owns provider configuration plus installed Packs.
- A **Workspace** is an opaque UUID owned by the Workspace Host.
- The **Agents Module** owns Rooms, messages, membership, documents, AI Agent Profiles, model execution, tools, memory, and evaluations.
- A **Room** is a durable collaboration space inside one Workspace.
- An **Agent** is a configurable AI actor; people participate as Human Participants.
- A **Pack** is a strict, Leitbild-specific extension installed at Deployment scope and activated per Room.
- A **Capability Manifest** is derived from the effective Pack descriptors; it is never a second source of truth.

Rooms and Agent Profiles share one runtime and publish one manifest, lifecycle, Resource collection, and Capability collection. Their persistence schemas remain separate internal documents.

Workspace identity is URL-carried. No local directory, display name, cookie, or Leitbild record is allowed to become a second Workspace authority. Cross-Workspace reads, writes, realtime subscriptions, and persistence paths are rejected by construction.

The canonical domain language is documented in the [Agents context](../../contexts/agents/CONTEXT.md). The cross-application boundaries are documented in the repository [context map](../../CONTEXT-MAP.md).

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

The Leitbild Host is the sole owner of Workspace identity, names, Module provisioning state, and composition. Agents accepts Host-supplied UUIDs only through its lifecycle endpoint and owns only Agents data beneath that identity.

- The Host provisions Agents once per Workspace.
- `/workspaces/{workspaceId}/agents` is the focused application URL.
- `/workspaces` is the Host-managed Workspace collection UI.
- Agents discover the current Workspace's Resources and Capabilities through the Host.

Opening or copying a Simulation Run creates no Room or Agent. The Host opens a **Run Assistant Room** only on request, using the ordinary Room Definition that advertises assistance for `world.run-family`. The Room stores a generic Subject Selection and publishes it through catalog links; Tool Grants separately allow read/write access to the live selected Runs. An `all except` selection automatically includes future copies without copying family membership into Agents. Reopening preserves the conversation. Deleting a Run leaves the Room conversation intact; deleting the Room also removes the AI profiles created for that Room.
- Agent Tool Grants store Capability ids only. The Agent selects a Resource at invocation time.

Rooms and Agents never copy Module base URLs, discovery URLs, or external Resource ids.

## API

Leitbild has one versionless public API. There are no old aliases, redirects, alternate response shapes, or version negotiation.

Module discovery and lifecycle are available at:

```text
GET /.well-known/workspace-module
PUT|DELETE /internal/workspaces/{workspaceId}
GET /internal/workspaces/{workspaceId}/definitions
GET /internal/workspaces/{workspaceId}/resources
GET /internal/workspaces/{workspaceId}/capabilities
POST /internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke
```

Deployment resources are intentionally unscoped:

```text
/api/auth
/api/system/info
/api/system/diagnostics
```

All Agents resources are Workspace-scoped:

```text
/api/workspaces/{workspaceId}/agents/settings
/api/workspaces/{workspaceId}/agents/rooms
/api/workspaces/{workspaceId}/agents
/api/workspaces/{workspaceId}/agents/messages
/api/workspaces/{workspaceId}/agents/scripts
/api/workspaces/{workspaceId}/agents/documents
/api/workspaces/{workspaceId}/agents/packs
/api/workspaces/{workspaceId}/agents/ws
```

The browser derives Workspace identity only from the URL. The server rejects unscoped application routes.

REST, WebSocket, and MCP are intentional task interfaces over the same Workspace runtime; they are not required to expose identical transport operations.

## Rooms and Agents

Rooms provide:

- durable messages and membership;
- broadcast or manual delivery;
- directed `[[AgentName]]` and `[[tag:name]]` addressing;
- pause and per-Agent mute state;
- summaries, bounded context compression, scripts, triggers, and Room Pack activation.

AI Agents provide:

- an editable persona and preferred model;
- provider fallback without changing the stored preference;
- a Pack-filtered tool surface;
- configurable prompt/context sections;
- Room history plus optional persistent memory and document retrieval.

## Packs

Each Pack requires a strict `pack.json` containing the shared descriptor envelope and Leitbild-specific metadata. The descriptor declares:

- Pack id and version;
- owning Module (`agents`);
- exact supported platform range;
- dependencies;
- contribution kinds such as tools, skills, scripts, geodata, wikis, and UI extensions.

Malformed manifests, duplicate ids, missing dependencies, and unsupported contribution declarations fail visibly. Packs are installed at Deployment scope; a Room's active Pack set is the effective allowlist for Agent tools and Pack geodata.

Deployment-authored tools, skills, scripts, and geodata live under `$LEITBILD_HOME/authoring/`. They are not Packs and are independent of Room Pack activation. Leitbild does not migrate or interpret older extension layouts.

## Cross-Module tools

Leitbild contains no World- or application-specific integration client. AI Agents use three generic tools:

- `workspace_catalog` discovers reusable Definitions and live Resource descriptors;
- `workspace_capabilities` searches Capability descriptions and, when given an exact catalog reference, reports target applicability, Agent authority, structured blockers, and callable schemas;
- `workspace_invoke` invokes a granted Capability against an exact Definition Revision or Resource selected for that call.

Catalog references are passed unchanged between these tools. Wildcards are valid only in discovery filters, never as target identity. Untargeted Capability search does not claim target-specific access; an exact target is required before a Resource or Definition Capability is classified as callable or blocked.

An Agent Profile with one or more Tool Grants receives this broker surface automatically at runtime. Room Definitions select domain-facing Agents tools only; they do not repeat these infrastructure tool names. Removing all Tool Grants removes the derived broker surface again.

For a World Simulation Run, the Agent can request `world.simulation-run.context` when it needs compact orientation: Scenario, objectives, current situation, procedure state, an object index, and supported Capabilities. It can then search or read specific objects, fetch changes or history, inspect procedures, or invoke an authorized and applicable Capability. The Skill advises this evidence-gathering without imposing a fixed call sequence or count. Future Scenario Timeline events and solver-private state are not exposed. This keeps Agent behavior configurable and makes future Modules available without another integration subsystem. A concrete continuous cross-Module behavior must be implemented and owned explicitly; ordinary discovery and commands create no persistent relationship.

## Persistence

`LEITBILD_HOME` defaults to `~/.leitbild`.

```text
$LEITBILD_HOME/
  providers.json
  packs/
  workspaces/{workspaceId}/
    agents/
      workspace.json
      snapshot.json
      generation-inspections.json
      memory/
      vectors.jsonl
      rooms/
      snapshot.json
      logs/
      documents/
```

The Agents Module accepts only its current strict Room and Agent Profile document shapes. Unsupported fields are rejected; there is no migration ladder or compatibility parser.

## Configuration and auth posture

Provider keys are configured through Settings or environment variables and are never returned by the API. Common Deployment settings are documented in [agents.env.example](../leitbild/deploy/agents.env.example).

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

Production is built and deployed through the repository-level unified Leitbild release.

## Security

Leitbild is powerful software: Agents can use configured tools, network services, and locally installed Pack code. Treat Pack installation and code-generation settings as operator trust decisions. Deployments should use TLS, a strong token, restricted file permissions, and conservative tool enablement.

## License

MIT
