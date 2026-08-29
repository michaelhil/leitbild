import { workspaceIdSchema, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'

export interface WorkspaceListItem {
  readonly id: WorkspaceId
  readonly displayName: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly loaded: boolean
  readonly links: {
    readonly self: string
    readonly ui: string
  }
}

export interface WorkspaceListResponse {
  readonly defaultWorkspaceId: WorkspaceId
  readonly workspaces: ReadonlyArray<WorkspaceListItem>
}

const readResponse = async <T>(response: Response, action: string): Promise<T> => {
  if (!response.ok) throw new Error(`${action} failed: ${response.status}`)
  return await response.json() as T
}

export const listWorkspaces = async (): Promise<WorkspaceListResponse> =>
  await readResponse<WorkspaceListResponse>(
    await fetch('/api/workspaces', { cache: 'no-store' }),
    'Workspace list',
  )

export const createWorkspace = async (displayName: string): Promise<WorkspaceListItem> => {
  const response = await readResponse<{ readonly workspace: Omit<WorkspaceListItem, 'loaded' | 'links'> }>(
    await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    }),
    'Workspace creation',
  )
  const id = workspaceIdSchema.parse(response.workspace.id)
  return {
    ...response.workspace,
    id,
    loaded: true,
    links: {
      self: `/api/workspaces/${id}`,
      ui: `/workspaces/${id}`,
    },
  }
}
