# Samsinn

Samsinn is a multi-agent collaboration system. Humans and AI Agents work together in Rooms, with configurable delivery, tools, scripts, knowledge, and persistent Workspace state.

Samsinn is independently deployable. It can also share a Workspace identity with Leitbild through the optional suite without importing Leitbild code or depending on the suite at runtime.

## Architecture

- A **Deployment** is one running Samsinn installation and owns provider configuration plus installed Packs.
- A **Workspace** is an isolated Samsinn data shard with its own Rooms, Agents, settings, messages, documents, logs, and vector index.
- A **Room** is a durable collaboration space inside one Workspace.
- An **Agent** is a human or AI collaboration identity inside one Workspace.
- A **Pack** is a strict, Samsinn-specific extension installed at Deployment scope and activated per Room.
- A **Capability Manifest** is derived from the effective Pack descriptors; it is never a second source of truth.

Workspace identity is an opaque UUID. Display names and Room names are not identity. Cross-Workspace reads, writes, realtime subscriptions, and persistence paths are rejected by construction.

The canonical domain language is documented in [CONTEXT.md](CONTEXT.md). The cross-application boundaries are documented in the repository [context map](../../CONTEXT-MAP.md).

## Quick start

Requirements: Bun 1.4.0 and at least one configured LLM provider. Ollama is optional.

```sh
bun install
ollama pull llama3.2       # optional local provider
bun run start
```

Open `http://localhost:3000`. A standalone Deployment creates and selects a local default Workspace automatically.

Useful commands:

```sh
bun run dev
bun run check
bun test
bun run build:css
bun run headless
```

## Workspaces and sharing

The Workspace Directory owns only Workspace metadata and Module Bindings. Samsinn owns all collaboration state beneath that identity.

- `GET /api/workspaces` lists Workspaces.
- `POST /api/workspaces` creates a Workspace with a generated UUID.
- `PUT /api/workspaces/{workspaceId}` idempotently provisions a caller-supplied UUID, which is how the suite coordinates modules.
- Navigate to `/workspaces/{workspaceId}` to select an existing Workspace in the browser.
- `/workspaces/{workspaceId}` is the canonical UI and share URL.

Module Bindings are stored once on the Workspace. Rooms and Agents never copy application base URLs or discovery URLs.

## API

Samsinn has one versionless public API. There are no old aliases, redirects, alternate response shapes, or version negotiation.

Discovery is available at:

```text
GET /.well-known/samsinn
```

Deployment resources are intentionally unscoped:

```text
/api/auth
/api/system/info
/api/system/diagnostics
/api/workspaces
/api/packs
```

All collaboration resources are Workspace-scoped:

```text
/api/workspaces/{workspaceId}/settings
/api/workspaces/{workspaceId}/rooms
/api/workspaces/{workspaceId}/agents
/api/workspaces/{workspaceId}/messages
/api/workspaces/{workspaceId}/scripts
/api/workspaces/{workspaceId}/documents
/api/workspaces/{workspaceId}/capabilities
/api/workspaces/{workspaceId}/ws
```

The browser UI uses the selected Workspace cookie only to construct these explicit paths. The server validates that the path Workspace, cookie Workspace, and realtime scope agree.

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

Each Pack requires a strict `pack.json` containing the shared descriptor envelope and Samsinn-specific metadata. The descriptor declares:

- Pack id and version;
- owning Module (`samsinn`);
- exact supported platform range;
- dependencies;
- contribution kinds such as tools, skills, scripts, geodata, wikis, and UI extensions.

Malformed manifests, duplicate ids, missing dependencies, and unsupported contribution declarations fail visibly. Packs are installed at Deployment scope; a Room's active Pack set is the effective allowlist for Agent tools and Pack geodata.

Authored local extensions use the same layout under `$SAMSINN_HOME/packs/local/`. Samsinn does not migrate or interpret older extension layouts.

## Leitbild integration

A Workspace may contain a Leitbild Module Binding. A Samsinn Room may then bind to one opaque Leitbild Simulation Run id and choose an observer or operator role.

The integration client:

- discovers Leitbild through the Workspace Module Binding;
- uses only the canonical Workspace-scoped links advertised by Leitbild;
- mirrors ordered Run events into a Room when enabled;
- exposes Run state, object, Scenario, Pack query, and operator command tools;
- rejects alternate discovery and response shapes rather than guessing.

Neither a Room nor an Agent may supply a Leitbild base URL. Topology belongs to the Workspace; the Room binding contains only the Simulation Run id and role.

## Persistence

`SAMSINN_HOME` defaults to `~/.samsinn`.

```text
$SAMSINN_HOME/
  workspace-directory.json
  providers.json
  llm-policy.json
  packs/
  workspaces/{workspaceId}/samsinn/
    snapshot.json
    logs/
    memory/
    vectors.jsonl
```

Snapshot `29` is the only accepted Samsinn runtime snapshot shape. Module Bindings live in the Workspace Directory, not in the snapshot. Unsupported snapshots are rejected; there is no migration ladder or compatibility parser.

## Configuration and auth posture

Provider keys are configured through Settings or environment variables and are never returned by the API. Common Deployment settings are documented in [deploy/env.example](deploy/env.example).

Authentication remains deliberately simple while the architecture stabilizes:

- without `SAMSINN_TOKEN`, the Deployment is open;
- with `SAMSINN_TOKEN`, shared-token login issues a session cookie;
- every application use case already carries explicit Workspace and access context so richer policy can be added without changing domain signatures.

Access policy does not alter Workspace identity or resource ownership.

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

Production operations are documented in [deploy/RUNBOOK.md](deploy/RUNBOOK.md). Samsinn and Leitbild retain independent build artifacts, services, releases, and rollback procedures.

## Security

Samsinn is powerful software: Agents can use configured tools, network services, and locally installed Pack code. Treat Pack installation and code-generation settings as operator trust decisions. Deployments should use TLS, a strong token, restricted file permissions, and conservative tool enablement.

## License

MIT
