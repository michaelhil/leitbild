import { join } from 'node:path'
import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'

export interface WorldWorkspacePaths {
  readonly workspaceRoot: string
  readonly root: string
  readonly marker: string
  readonly simulationRuns: string
  readonly scenarios: string
}

export const worldWorkspacePaths = (
  dataDir: string,
  workspaceId: WorkspaceId,
): WorldWorkspacePaths => {
  const parsedId = workspaceIdSchema.parse(workspaceId)
  const workspaceRoot = join(dataDir, 'workspaces', parsedId)
  const root = join(workspaceRoot, 'world')
  return {
    workspaceRoot,
    root,
    marker: join(root, 'workspace.json'),
    simulationRuns: join(root, 'simulation-runs'),
    scenarios: join(root, 'scenarios'),
  }
}
