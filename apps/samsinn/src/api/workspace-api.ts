import { moduleBindingSchema, newWorkspaceId, workspaceIdSchema, type ModuleBinding, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { z } from 'zod'
import type { WorkspaceDirectory } from '../core/workspaces/directory.ts'
import { createRateLimiter, type RateLimiter } from './rate-limit.ts'
import type { LimitMetrics } from '../core/limit-metrics.ts'

const provisionWorkspaceSchema = z.object({
  displayName: z.string().trim().min(1).max(256),
  modules: z.array(moduleBindingSchema).optional(),
}).strict()

const json = (body: unknown, status = 200): Response => Response.json(body, { status })
const apiError = (status: number, code: string, message: string): Response =>
  json({ error: { code, message } }, status)

let workspaceLimiter: RateLimiter | null = null
export const initWorkspaceLimiter = (limitMetrics?: LimitMetrics): RateLimiter => {
  if (workspaceLimiter) return workspaceLimiter
  workspaceLimiter = createRateLimiter({
    windowMs: Number(process.env.SAMSINN_CREATE_RATE_WINDOW_MS) || 60_000,
    max: Number(process.env.SAMSINN_CREATE_RATE_LIMIT) || 5,
    ...(limitMetrics ? { limitMetrics } : {}),
  })
  return workspaceLimiter
}

const readBody = async (request: Request): Promise<unknown> => {
  try { return await request.json() } catch (error) {
    if (error instanceof SyntaxError) throw error
    throw new SyntaxError('request body must be valid JSON', { cause: error })
  }
}

export const handleWorkspaceDirectoryApi = async (
  request: Request,
  url: URL,
  directory: WorkspaceDirectory,
  remoteAddress?: string,
  onModulesChanged?: (workspaceId: WorkspaceId, modules: ReadonlyArray<ModuleBinding>) => void,
): Promise<Response | null> => {
  try {
    if (url.pathname === '/api/workspaces' && request.method === 'GET') {
      return json({ workspaces: await directory.list() })
    }
    if (url.pathname === '/api/workspaces' && request.method === 'POST') {
      const limit = initWorkspaceLimiter().check(remoteAddress)
      if (!limit.ok) {
        return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Workspace creation rate limit exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1_000)) },
        })
      }
      const body = provisionWorkspaceSchema.parse(await readBody(request))
      const workspace = await directory.ensure({
        id: newWorkspaceId(),
        displayName: body.displayName,
        ...(body.modules === undefined ? {} : { modules: body.modules }),
      })
      return json({ workspace }, 201)
    }

    const match = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/)
    if (!match) return null
    const workspaceId = workspaceIdSchema.parse(decodeURIComponent(match[1] ?? ''))

    if (request.method === 'GET') {
      const workspace = await directory.get(workspaceId)
      return workspace
        ? json({ workspace })
        : apiError(404, 'workspace_not_found', 'Workspace not found')
    }
    if (request.method === 'PUT') {
      const limit = initWorkspaceLimiter().check(remoteAddress)
      if (!limit.ok) {
        return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Workspace provisioning rate limit exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1_000)) },
        })
      }
      const body = provisionWorkspaceSchema.parse(await readBody(request))
      const existing = await directory.get(workspaceId)
      if (existing && existing.displayName !== body.displayName) {
        return apiError(409, 'workspace_conflict', 'Workspace display name does not match the existing Workspace')
      }
      const workspace = await directory.ensure({
        id: workspaceId,
        displayName: body.displayName,
        ...(body.modules === undefined ? {} : { modules: body.modules }),
      })
      if (body.modules !== undefined) onModulesChanged?.(workspaceId, workspace.modules)
      return json({ workspace }, existing ? 200 : 201)
    }
    return null
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(400, 'invalid_json', error.message)
    if (error instanceof z.ZodError) return apiError(400, 'invalid_request', error.message)
    throw error
  }
}
