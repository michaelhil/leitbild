import { z } from 'zod'
import { moduleBindingSchema, workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'
import type { LeitbildWorkspaceRuntimeRegistry } from '../workspaces/runtime-registry.ts'
import { apiError, json, readJson } from './responses.ts'

const provisionWorkspaceSchema = z.object({
  displayName: z.string().trim().min(1).max(256),
  modules: z.array(moduleBindingSchema).optional(),
}).strict()

export const handleWorkspaceApi = async (
  req: Request,
  url: URL,
  registry: LeitbildWorkspaceRuntimeRegistry,
): Promise<Response | null> => {
  try {
    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      const defaultWorkspace = await registry.defaultWorkspace()
      const workspaces = await registry.list()
      return json({
        defaultWorkspaceId: defaultWorkspace.id,
        workspaces: workspaces.map(workspace => ({
          ...workspace,
          loaded: registry.getLoaded(workspace.id) !== undefined,
          links: {
            self: `/api/workspaces/${workspace.id}`,
            ui: `/workspaces/${workspace.id}`,
          },
        })),
      })
    }

    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      const parsed = provisionWorkspaceSchema.parse(await readJson(req))
      const runtime = await registry.provision({
        displayName: parsed.displayName,
        ...(parsed.modules === undefined ? {} : { modules: parsed.modules }),
      })
      return json({ workspace: runtime.workspace }, { status: 201 })
    }

    const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/)
    if (!workspaceMatch) return null
    const workspaceId = workspaceIdSchema.parse(decodeURIComponent(workspaceMatch[1] ?? ''))

    if (req.method === 'GET') {
      const workspace = (await registry.list()).find(candidate => candidate.id === workspaceId)
      if (!workspace) return apiError(404, 'workspace_not_found', 'Workspace not found')
      return json({
        workspace,
        loaded: registry.getLoaded(workspaceId) !== undefined,
        links: {
          scenarios: `/api/workspaces/${workspaceId}/scenarios`,
          simulationRuns: `/api/workspaces/${workspaceId}/simulation-runs`,
          ui: `/workspaces/${workspaceId}`,
        },
      })
    }

    if (req.method === 'PUT') {
      const parsed = provisionWorkspaceSchema.parse(await readJson(req))
      try {
        const existing = (await registry.list()).some(candidate => candidate.id === workspaceId)
        const runtime = await registry.provision({
          id: workspaceId,
          displayName: parsed.displayName,
          ...(parsed.modules === undefined ? {} : { modules: parsed.modules }),
        })
        return json({ workspace: runtime.workspace }, { status: existing ? 200 : 201 })
      } catch (err) {
        if ((err as Error).message.startsWith('Workspace display name mismatch')) {
          return apiError(409, 'workspace_conflict', (err as Error).message)
        }
        throw err
      }
    }

    return null
  } catch (err) {
    if (err instanceof SyntaxError) return apiError(400, 'invalid_json', err.message)
    if (err instanceof z.ZodError) return apiError(400, 'invalid_request', err.message)
    throw err
  }
}
