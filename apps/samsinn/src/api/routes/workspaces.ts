// Workspace administration for the standalone Samsinn deployment.

import { workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'
import { json, errorResponse } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { getWorkspaceId } from '../workspace-cookie.ts'
import { createRateLimiter, type RateLimiter } from '../rate-limit.ts'
import type { LimitMetrics } from '../../core/limit-metrics.ts'

const REQUIRED = () => errorResponse('Workspace administration is not wired', 501)

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

const parseRouteWorkspaceId = (raw: string | undefined) => {
  const parsed = workspaceIdSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export const workspaceRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/workspaces$/,
    handler: async (req, _match, ctx) => {
      if (!ctx.workspaces) return REQUIRED()
      return json({ workspaces: await ctx.workspaces.list(), currentId: getWorkspaceId(req) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/workspaces$/,
    handler: async (req, _match, ctx) => {
      if (!ctx.workspaces) return REQUIRED()
      const limit = initWorkspaceLimiter().check(ctx.remoteAddress)
      if (!limit.ok) {
        const retrySeconds = Math.ceil(limit.retryAfterMs / 1000)
        return new Response(JSON.stringify({ error: `create rate limit — try again in ${retrySeconds}s` }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(retrySeconds) },
        })
      }
      let displayName: string | undefined
      if ((req.headers.get('content-type') ?? '').includes('application/json')) {
        const body = await req.json().catch(() => null) as { displayName?: unknown } | null
        if (body?.displayName !== undefined) {
          if (typeof body.displayName !== 'string' || body.displayName.trim().length === 0 || body.displayName.length > 256) {
            return errorResponse('displayName must be a non-empty string up to 256 characters', 400)
          }
          displayName = body.displayName.trim()
        }
      }
      const created = await ctx.workspaces.create(displayName)
      return json(created, 201)
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/workspaces\/([^/]+)\/switch$/,
    handler: async (req, match, ctx) => {
      if (!ctx.workspaces) return REQUIRED()
      const targetId = parseRouteWorkspaceId(match[1])
      if (!targetId) return errorResponse('invalid Workspace id', 400)
      const target = (await ctx.workspaces.list()).find(workspace => workspace.id === targetId)
      if (!target) return errorResponse('Workspace not found', 404)
      return new Response(JSON.stringify({ ok: true, id: targetId }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': ctx.workspaces.buildSwitchCookie(targetId, req),
        },
      })
    },
  },
]
