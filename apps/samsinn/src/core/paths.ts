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
//     workspaces/                               ← Workspace-scoped module state
//       <workspace-id>/
//         samsinn/                              ← Samsinn-owned shard
//         snapshot.json
//         logs/*.jsonl
//         memory/<agentName>/{notes.log,facts.json}
//     .local-pack-migrated                      ← sentinel: drop-in dirs
//                                                  moved into packs/local/
//                                                  (commit P, one-shot)
//
// SAMSINN_HOME defaults to ~/.samsinn (preserves existing single-tenant UX).
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
// Drop-in dirs (tools/skills/scripts/geodata) live INSIDE the synthetic
// 'local' pack at packs/local/<subdir>/ since commit P. The migration
// at boot moves them from their old top-level locations idempotently.
// See migrate-local-pack.ts.
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
  workspaceDirectory: (): string => join(samsinnHome(), 'workspace-directory.json'),
  workspacesRoot: (): string => join(samsinnHome(), 'workspaces'),
}

// Samsinn's owned persistence shard inside one Workspace.
export interface WorkspacePaths {
  readonly root: string
  readonly snapshot: string
  readonly logs: string
  readonly memory: string
  // per-Workspace vector index (RAG). Single JSONL file with header,
  // vectors, and tombstones. See src/embed/vector-store.ts.
  readonly vectors: string
}

export const workspacePaths = (id: WorkspaceId): WorkspacePaths => {
  assertValidWorkspaceId(id)
  const root = join(samsinnHome(), 'workspaces', id, 'samsinn')
  return {
    root,
    snapshot: join(root, 'snapshot.json'),
    logs: join(root, 'logs'),
    memory: join(root, 'memory'),
    vectors: join(root, 'vectors.jsonl'),
  }
}

export const isValidWorkspaceId = (id: string): id is WorkspaceId =>
  workspaceIdSchema.safeParse(id).success

// Defense-in-depth: throws if a caller bypassed the boundary check. Cheap
// guard that prevents accidental path traversal if any future call site
// forgets to validate before passing into instancePaths/trashPath.
export const assertValidWorkspaceId: (id: string) => asserts id is WorkspaceId = (id) => {
  workspaceIdSchema.parse(id)
}
