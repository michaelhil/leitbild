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

// Scripted clients can select an existing Workspace without a cookie by
// passing ?workspace=<uuid> on every request.
export const getWorkspaceFromQuery = (url: URL): WorkspaceId | null =>
  parseWorkspaceId(url.searchParams.get('workspace'))

// Share links retain the compact ?join= form; the value is now the canonical
// Workspace UUID and is verified against the Workspace Directory by server.ts.
export const getJoinFromQuery = (url: URL): WorkspaceId | null =>
  parseWorkspaceId(url.searchParams.get('join'))

export interface ResolvedWorkspace {
  readonly id: WorkspaceId | null
  readonly source: 'join' | 'cookie' | 'query' | 'none'
}

export const resolveWorkspaceId = (req: Request, url: URL): ResolvedWorkspace => {
  const joined = getJoinFromQuery(url)
  if (joined) return { id: joined, source: 'join' }
  const cookie = getWorkspaceId(req)
  if (cookie) return { id: cookie, source: 'cookie' }
  const queried = getWorkspaceFromQuery(url)
  if (queried) return { id: queried, source: 'query' }
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
    return { workspaceId: resolved.id, setCookieValue: null, isNew: false }
  }
  const workspaceId = newWorkspaceId()
  return {
    workspaceId,
    setCookieValue: buildWorkspaceCookie(workspaceId, req),
    isNew: true,
  }
}
