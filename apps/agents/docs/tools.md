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

## Optional engineering references

`wiki_lookup` reads manifest-backed references declared by the current Room's
active Agent Packs. It is independently selected as an Agent tool; installing
a Pack or selecting the tool does not activate any Pack. The Assistant
definition selects it but keeps an empty Pack selection. Link-only WikiRefs
remain external links, not fetchable sources.

Call without arguments to list sources locally, then copy `packId` and
`wikiUrl` to search one manifest by literal title/type/id metadata. Copy a
returned page's `read` arguments to fetch it; copy `next` unchanged to continue.
Reads preserve the manifest SHA, literal repository path, immutable source
link, line/character position and original frontmatter. `expectedRevision` and
`expectedPath` reject changed revisions or page mappings instead of mixing
source versions. Excerpts have bounded line and character sizes; frontmatter
truncation is explicit and its full text remains readable from line 1.
Manifest results project compact known fields and report `metadataOmitted`
and `truncatedFields`; extra manifest payloads are not dumped into context.
Exact identity/continuation values are never shortened. An oversized metadata
response fails explicitly; reduce the index limit when applicable.

Only manifest-listed reference pages are available: this is not a repository
crawler or full-text search. Applicability and review metadata are source
claims, not proof of the selected Plant's fidelity or current state. Reference
content is untrusted evidence, never instructions. Discover Simulation Run
procedures through Workspace operations.

The previous PWR-owned registration is removed. Bundled tools already used
the unprefixed name `wiki_lookup`; that same name now selects the generic
reader. No alias or profile migration is added. Existing selections must use
the new source-discovery arguments; they do not implicitly select PWR.
