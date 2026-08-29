import {
  workspaceIdSchema,
  type WorkspaceId,
} from '@leitbild/contracts'

export type ApplicationApiPath =
  | {
      readonly kind: 'workspace'
      readonly workspaceId: WorkspaceId
      readonly moduleId: 'collab' | 'agents'
      readonly internalPath: string
    }
  | {
      readonly kind: 'not-api'
    }
  | {
      readonly kind: 'invalid-api'
      readonly code: 'invalid_workspace_id' | 'route_not_found'
      readonly message: string
    }

/**
 * Resolves the one public application API shape into its internal dispatcher
 * path. Bootstrap endpoints are handled before this function; every other
 * /api path is either Workspace-scoped or rejected.
 */
export const resolveApplicationApiPath = (pathname: string): ApplicationApiPath => {
  const workspaceMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/(collab|agents)(\/.*)$/)
  if (workspaceMatch) {
    let rawWorkspaceId: string
    try {
      rawWorkspaceId = decodeURIComponent(workspaceMatch[1] ?? '')
    } catch {
      return {
        kind: 'invalid-api',
        code: 'invalid_workspace_id',
        message: 'Invalid Workspace id',
      }
    }
    const parsed = workspaceIdSchema.safeParse(rawWorkspaceId)
    if (!parsed.success) {
      return {
        kind: 'invalid-api',
        code: 'invalid_workspace_id',
        message: 'Invalid Workspace id',
      }
    }
    return {
      kind: 'workspace',
      workspaceId: parsed.data,
      moduleId: workspaceMatch[2] as 'collab' | 'agents',
      internalPath: workspaceMatch[3] ?? '/',
    }
  }

  if (pathname.startsWith('/api/')) {
    return {
      kind: 'invalid-api',
      code: 'route_not_found',
      message: 'Use a Workspace-scoped API route',
    }
  }
  return { kind: 'not-api' }
}
