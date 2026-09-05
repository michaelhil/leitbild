# Agent tools

Tools are typed functions exposed to AI Agents through native model tool
calling. The canonical contract is `src/core/types/tool.ts`.

```ts
import type { Tool } from '../src/core/types/tool.ts'

const tool: Tool = {
  name: 'lookup_status',
  description: 'Read the current status for one named item.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  execute: async ({ id }, context) => ({
    success: true,
    data: { id, requestedBy: context.callerName },
  }),
}

export default tool
```

Deployment-authored tools live in `$LEITBILD_HOME/authoring/tools/`. A file
exports one `Tool` or an array of tools as its default export. Tool names use
letters, digits, `_`, or `-`; duplicate or malformed tools are rejected and
reported by the loader.

Built-in tools live under `src/tools/built-in/`. Pack tools live under the
Pack's `tools/` directory and register as `<pack-id>_<tool-name>`. Skill-owned
tools live beside their `SKILL.md`. All four sources enter the same registry;
Room Pack activation determines Pack-owned tool visibility. The two generic
Workspace broker tools are included for every AI Agent.

`ToolContext` supplies caller identity, an optional Room id, and optional
model-bound LLM helpers. Tools return `{ success, data? }` or
`{ success: false, error }`; throwing is reserved for unexpected failures.

Use `workspace_explore` and `workspace_call` for cross-Module discovery and
action. Do not add World-specific clients to Agents or persist external
Resource ids in Agent configuration. Copy an exact Resource or
Definition-revision `target` from exploration unchanged into a call. An omitted
target explores Workspace operations only when Room Scope is Workspace-wide;
wildcard or partial targets are invalid rather than silently broadening scope.
Reads and changes share one call shape; batching is limited to independent
reads. The target Module remains responsible for validation and restrictions.
