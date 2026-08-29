// ============================================================================
// Filesystem layout — one source of truth for every persistent path Samsinn
// uses on disk. Paths are functions (not constants) so SAMSINN_HOME can be
// overridden per-test or per-deploy, including in tests that mock homedir().
//
// Layout:
//   $SAMSINN_HOME/                              ← global / shared
//     providers.json                            ← provider keys + order
//     packs/                                    ← installed packs (shared)
//       <namespace>/                            ← third-party packs
//       local/                                  ← user's drop-in dirs
//         tools/                                ← drop-in TS tools
//         skills/<name>/                        ← drop-in skills
//         scripts/*.md                          ← drop-in scripts
//         geodata/<category>.geojson            ← user-paste geodata
//     geodata/.bundled/<version>/               ← cached samsinn-geodata snapshot (NOT user data)
//     knowledge/                                ← shared knowledge files
//     logs/admin.jsonl                          ← janitor + registry events
//     workspaces/                               ← Workspace-scoped Module state
//       <workspace-id>/
//         collaboration/                       ← Rooms, messages, membership
//         agents/                              ← Agent profiles and runtime state
//
// SAMSINN_HOME defaults to ~/.samsinn.
// ============================================================================

import { homedir } from 'node:os'
import { join } from 'node:path'
import { workspaceIdSchema, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'

export const samsinnHome = (): string =>
  process.env.SAMSINN_HOME && process.env.SAMSINN_HOME.length > 0
    ? process.env.SAMSINN_HOME
    : join(homedir(), '.samsinn')

// Shared (global) paths — registries, configs, packs dirs.
//
// Authored tools, skills, scripts, and geodata live inside the local Pack.
const localPack = (): string => join(samsinnHome(), 'packs', 'local')

export const sharedPaths = {
  root: (): string => samsinnHome(),
  providers: (): string => join(samsinnHome(), 'providers.json'),
  llmPolicy: (): string => join(samsinnHome(), 'llm-policy.json'),
  packs: (): string => join(samsinnHome(), 'packs'),
  skills: (): string => join(localPack(), 'skills'),
  scripts: (): string => join(localPack(), 'scripts'),
  tools: (): string => join(localPack(), 'tools'),
  knowledge: (): string => join(samsinnHome(), 'knowledge'),
  geodata: (): string => join(localPack(), 'geodata'),
  adminLog: (): string => join(samsinnHome(), 'logs', 'admin.jsonl'),
  workspacesRoot: (): string => join(samsinnHome(), 'workspaces'),
}

export interface CollaborationWorkspacePaths {
  readonly root: string
  readonly marker: string
  readonly snapshot: string
  readonly logs: string
  readonly documents: string
}

export interface AgentsWorkspacePaths {
  readonly root: string
  readonly marker: string
  readonly snapshot: string
  readonly memory: string
  readonly vectors: string
}

export interface WorkspaceModulePaths {
  readonly root: string
  readonly collaboration: CollaborationWorkspacePaths
  readonly agents: AgentsWorkspacePaths
}

export const workspaceModulePaths = (id: WorkspaceId): WorkspaceModulePaths => {
  assertValidWorkspaceId(id)
  const root = join(samsinnHome(), 'workspaces', id)
  const collaborationRoot = join(root, 'collaboration')
  const agentsRoot = join(root, 'agents')
  return {
    root,
    collaboration: {
      root: collaborationRoot,
      marker: join(collaborationRoot, 'workspace.json'),
      snapshot: join(collaborationRoot, 'snapshot.json'),
      logs: join(collaborationRoot, 'logs'),
      documents: join(collaborationRoot, 'documents'),
    },
    agents: {
      root: agentsRoot,
      marker: join(agentsRoot, 'workspace.json'),
      snapshot: join(agentsRoot, 'snapshot.json'),
      memory: join(agentsRoot, 'memory'),
      vectors: join(agentsRoot, 'vectors.jsonl'),
    },
  }
}

export const isValidWorkspaceId = (id: string): id is WorkspaceId =>
  workspaceIdSchema.safeParse(id).success

// Defense-in-depth: throws if a caller bypassed the boundary check. Cheap
// guard that prevents accidental path traversal if a future call site
// forgets to validate before constructing Workspace paths.
export const assertValidWorkspaceId: (id: string) => asserts id is WorkspaceId = (id) => {
  workspaceIdSchema.parse(id)
}
