// Workspace message bookmarks. Mutations trigger
// the OnBookmarksChanged callback which the server wires to auto-save.

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'

const readContent = (body: Record<string, unknown>): string | null => {
  const raw = body.content
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export const bookmarkRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/bookmarks$/,
    handler: (_req, _match, { system }) =>
      json({ bookmarks: system.bookmarks.list() }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/bookmarks$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      const content = readContent(body)
      if (content === null) return errorResponse('content is required', 400)
      return json({ bookmark: system.bookmarks.add(content) }, 201)
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/bookmarks\/([^/]+)$/,
    handler: async (req, match, { system }) => {
      const id = decodeURIComponent(match[1]!)
      const body = await parseBody(req)
      const content = readContent(body)
      if (content === null) return errorResponse('content is required', 400)
      const updated = system.bookmarks.update(id, content)
      if (!updated) return errorResponse('bookmark not found', 404)
      return json({ bookmark: updated })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/bookmarks\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const id = decodeURIComponent(match[1]!)
      const removed = system.bookmarks.remove(id)
      if (!removed) return errorResponse('bookmark not found', 404)
      return json({ ok: true })
    },
  },
]
