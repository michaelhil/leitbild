import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'

let activeWorkspace: WorkspaceId | null = null

export const configureActiveWorkspace = (workspaceId: WorkspaceId): void => {
  activeWorkspace = workspaceIdSchema.parse(workspaceId)
}

export const activeWorkspaceId = (): WorkspaceId => {
  if (activeWorkspace === null) throw new Error('Leitbild Workspace context has not been configured')
  return activeWorkspace
}

export const workspaceApiPath = (path: `/${string}`): string =>
  `/api/workspaces/${encodeURIComponent(activeWorkspaceId())}/world${path}`
