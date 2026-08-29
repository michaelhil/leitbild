// Workspace selection cookie. This identifies the platform Workspace whose
// Samsinn shard handles the request; it is not an authentication token.

import {
  newWorkspaceId,
  workspaceIdSchema,
  type WorkspaceId,
} from '@samsinn-leitbild/platform-contracts'
import { parseCookie } from './auth.ts'

export const WORKSPACE_COOKIE = 'samsinn_workspace'
const TTL_DAYS = 30
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60

const parseWorkspaceId = (raw: string | null): WorkspaceId | null => {
  if (raw === null) return null
  const parsed = workspaceIdSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export const getWorkspaceId = (req: Request): WorkspaceId | null =>
  parseWorkspaceId(parseCookie(req.headers.get('cookie'), WORKSPACE_COOKIE))

const shouldUseSecure = (req: Request): boolean => {
  if (process.env.SAMSINN_SECURE_COOKIES === '1') return true
  const forwardedProtocol = req.headers.get('x-forwarded-proto')
  if (forwardedProtocol?.toLowerCase() === 'https') return true
  try {
    return new URL(req.url).protocol === 'https:'
  } catch {
    return false
  }
}

export const buildWorkspaceCookie = (id: WorkspaceId, req: Request): string => {
  const secure = shouldUseSecure(req) ? '; Secure' : ''
  return `${WORKSPACE_COOKIE}=${id}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${TTL_SECONDS}`
}

export const getWorkspaceIdFromPath = (pathname: string): WorkspaceId | null => {
  const match = pathname.match(/^\/workspaces\/([^/]+)$/)
  if (!match) return null
  try {
    return parseWorkspaceId(decodeURIComponent(match[1] ?? ''))
  } catch {
    return null
  }
}

export interface ResolvedWorkspace {
  readonly id: WorkspaceId | null
  readonly source: 'path' | 'cookie' | 'none'
}

export const resolveWorkspaceId = (req: Request, url: URL): ResolvedWorkspace => {
  const fromPath = getWorkspaceIdFromPath(url.pathname)
  if (fromPath) return { id: fromPath, source: 'path' }
  const cookie = getWorkspaceId(req)
  if (cookie) return { id: cookie, source: 'cookie' }
  return { id: null, source: 'none' }
}

export interface MintedWorkspace {
  readonly workspaceId: WorkspaceId
  readonly setCookieValue: string | null
  readonly isNew: boolean
}

export const resolveOrMintWorkspace = (req: Request, url: URL): MintedWorkspace => {
  const resolved = resolveWorkspaceId(req, url)
  if (resolved.id !== null) {
    const cookie = getWorkspaceId(req)
    return {
      workspaceId: resolved.id,
      setCookieValue: cookie === resolved.id ? null : buildWorkspaceCookie(resolved.id, req),
      isNew: false,
    }
  }
  const workspaceId = newWorkspaceId()
  return {
    workspaceId,
    setCookieValue: buildWorkspaceCookie(workspaceId, req),
    isNew: true,
  }
}
