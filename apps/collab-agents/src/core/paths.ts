// ============================================================================
// Filesystem layout — one source of truth for every persistent path Leitbild
// uses on disk. Paths are functions (not constants) so LEITBILD_HOME can be
// overridden per-test or per-deploy, including in tests that mock homedir().
//
// Layout:
//   $LEITBILD_HOME/                              ← global / shared
//     providers.json                            ← provider keys + order
//     packs/                                    ← installed packs (shared)
//       <namespace>/                            ← third-party packs
//       local/                                  ← user's drop-in dirs
//         tools/                                ← drop-in TS tools
//         skills/<name>/                        ← drop-in skills
//         scripts/*.md                          ← drop-in scripts
//         geodata/<category>.geojson            ← user-paste geodata
//     geodata/.bundled/<version>/               ← cached leitbild-geodata snapshot (NOT user data)
//     knowledge/                                ← shared knowledge files
//     logs/admin.jsonl                          ← janitor + registry events
//     workspaces/                               ← Workspace-scoped Module state
//       <workspace-id>/
//         collab/                       ← Rooms, messages, membership
//         agents/                              ← Agent profiles and runtime state
//
// LEITBILD_HOME defaults to ~/.leitbild.
// ============================================================================

import { homedir } from 'node:os'
import { join } from 'node:path'
import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'

export const leitbildHome = (): string =>
  process.env.LEITBILD_HOME && process.env.LEITBILD_HOME.length > 0
    ? process.env.LEITBILD_HOME
    : join(homedir(), '.leitbild')

// Shared (global) paths — registries, configs, packs dirs.
//
// Authored tools, skills, scripts, and geodata live inside the local Pack.
const localPack = (): string => join(leitbildHome(), 'packs', 'local')

export const sharedPaths = {
  root: (): string => leitbildHome(),
  providers: (): string => join(leitbildHome(), 'providers.json'),
  llmPolicy: (): string => join(leitbildHome(), 'llm-policy.json'),
  packs: (): string => join(leitbildHome(), 'packs'),
  skills: (): string => join(localPack(), 'skills'),
  scripts: (): string => join(localPack(), 'scripts'),
  tools: (): string => join(localPack(), 'tools'),
  knowledge: (): string => join(leitbildHome(), 'knowledge'),
  geodata: (): string => join(localPack(), 'geodata'),
  adminLog: (): string => join(leitbildHome(), 'logs', 'admin.jsonl'),
  workspacesRoot: (): string => join(leitbildHome(), 'workspaces'),
}

export interface CollabWorkspacePaths {
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
  readonly collab: CollabWorkspacePaths
  readonly agents: AgentsWorkspacePaths
}

export const workspaceModulePaths = (id: WorkspaceId): WorkspaceModulePaths => {
  assertValidWorkspaceId(id)
  const root = join(leitbildHome(), 'workspaces', id)
  const collabRoot = join(root, 'collab')
  const agentsRoot = join(root, 'agents')
  return {
    root,
    collab: {
      root: collabRoot,
      marker: join(collabRoot, 'workspace.json'),
      snapshot: join(collabRoot, 'snapshot.json'),
      logs: join(collabRoot, 'logs'),
      documents: join(collabRoot, 'documents'),
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
