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
// Heavy lifting lives in the built-in pack tools — routes are thin wrappers
// that look up the registered tool and forward params, so REST and agent
// surfaces stay in lock-step.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { getAvailablePacks } from '../../packs/registry.ts'

// Small helper: invoke a built-in pack tool and return its result as JSON.
const invoke = async (
  system: { toolRegistry: { get: (name: string) => { execute: (p: Record<string, unknown>, ctx: { callerId: string; callerName: string }) => Promise<{ success: boolean; data?: unknown; error?: string }> } | undefined } },
  toolName: string,
  params: Record<string, unknown>,
): Promise<Response> => {
  const tool = system.toolRegistry.get(toolName)
  if (!tool) return errorResponse(`Tool ${toolName} not registered`, 500)
  const result = await tool.execute(params, { callerId: 'api', callerName: 'api' })
  if (!result.success) return errorResponse(result.error ?? 'operation failed', 400)
  return json(result.data ?? {})
}

export const packsRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/packs$/,
    handler: async (_req, _match, { system }) => invoke(system, 'list_packs', {}),
  },
  {
    // Browse view — pack registry merged with installed flag. Powers the
    // "Available packs" section of the Packs modal. Cached 5 min server-side.
    method: 'GET',
    pattern: /^\/packs\/registry$/,
    handler: async (_req, _match, { system }) => {
      const available = await getAvailablePacks()
      // Get installed list to mark each available pack. Registry names are
      // canonical (registry strips `samsinn-pack-` from repo basenames).
      // A Pack descriptor id is authoritative after installation.
      const listTool = system.toolRegistry.get('list_packs')
      const installedRes = listTool
        ? await listTool.execute({}, { callerId: 'api', callerName: 'api' })
        : { success: false }
      const installed = installedRes.success && Array.isArray(installedRes.data)
        ? new Set((installedRes.data as Array<{ id: string }>).map(pack => pack.id))
        : new Set<string>()
      return json(available.map(p => ({ ...p, installed: installed.has(p.name) })))
    },
  },
  {
    method: 'POST',
    pattern: /^\/packs\/install$/,
    handler: async (req, _match, { system, broadcast }) => {
      const body = await parseBody(req)
      if (typeof body.source !== 'string' || !body.source.trim()) {
        return errorResponse('source is required')
      }
      const response = await invoke(system, 'install_pack', { source: body.source.trim() })
      if (response.status === 200) {
        try { broadcast({ type: 'packs_changed' }) } catch { /* ignore */ }
      }
      return response
    },
  },
  {
    method: 'POST',
    pattern: /^\/packs\/update\/([^/]+)$/,
    handler: async (_req, match, { system, broadcast }) => {
      const id = decodeURIComponent(match[1] ?? '')
      const response = await invoke(system, 'update_pack', { id })
      if (response.status === 200) {
        try { broadcast({ type: 'packs_changed' }) } catch { /* ignore */ }
      }
      return response
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/packs\/([^/]+)$/,
    handler: async (_req, match, { system, broadcast }) => {
      const id = decodeURIComponent(match[1] ?? '')
      const response = await invoke(system, 'uninstall_pack', { id })
      if (response.status === 200) {
        try { broadcast({ type: 'packs_changed' }) } catch { /* ignore */ }
      }
      return response
    },
  },
]
