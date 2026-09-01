// ============================================================================
// Packs admin routes — install / update / uninstall / list packs from GitHub.
//
// GET    /packs                 list installed packs + their registered
//                                   tool/skill keys
// POST   /packs/install         body: { source: string }
// POST   /packs/update/:id      git pull + re-register
// DELETE /packs/:id             unregister + delete
//
// All mutations emit a `packs_changed` WS broadcast so open UIs refresh.
// Heavy lifting lives in the deployment Pack Manager. REST and Agent tools
// are independent thin adapters over that same domain service.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import type { PackManagerResult } from '../../packs/manager.ts'

const responseFor = (result: PackManagerResult): Response => {
  if (!result.success) return errorResponse(result.error ?? 'operation failed', 400)
  return json(result.data ?? {})
}

export const packsRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/packs$/,
    handler: async (_req, _match, { packManager }) => responseFor(await packManager.list()),
  },
  {
    // Browse view — pack registry merged with installed flag. Powers the
    // "Available packs" section of the Packs modal. Cached 5 min server-side.
    method: 'GET',
    pattern: /^\/packs\/registry$/,
    handler: async (_req, _match, { packManager }) => responseFor(await packManager.listAvailable()),
  },
  {
    method: 'POST',
    pattern: /^\/packs\/install$/,
    handler: async (req, _match, { packManager }) => {
      const body = await parseBody(req)
      if (typeof body.source !== 'string' || !body.source.trim()) {
        return errorResponse('source is required')
      }
      return responseFor(await packManager.install(body.source.trim()))
    },
  },
  {
    method: 'POST',
    pattern: /^\/packs\/update\/([^/]+)$/,
    handler: async (_req, match, { packManager }) => {
      const id = decodeURIComponent(match[1] ?? '')
      return responseFor(await packManager.update(id))
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/packs\/([^/]+)$/,
    handler: async (_req, match, { packManager }) => {
      const id = decodeURIComponent(match[1] ?? '')
      return responseFor(await packManager.uninstall(id))
    },
  },
]
