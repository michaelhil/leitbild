import { join } from 'node:path'
import { workspaceIdSchema, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'

export interface MicroworldWorkspacePaths {
  readonly workspaceRoot: string
  readonly root: string
  readonly marker: string
  readonly simulationRuns: string
  readonly scenarios: string
}

export const microworldWorkspacePaths = (
  dataDir: string,
  workspaceId: WorkspaceId,
): MicroworldWorkspacePaths => {
  const parsedId = workspaceIdSchema.parse(workspaceId)
  const workspaceRoot = join(dataDir, 'workspaces', parsedId)
  const root = join(workspaceRoot, 'microworld')
  return {
    workspaceRoot,
    root,
    marker: join(root, 'workspace.json'),
    simulationRuns: join(root, 'simulation-runs'),
    scenarios: join(root, 'scenarios'),
  }
}
