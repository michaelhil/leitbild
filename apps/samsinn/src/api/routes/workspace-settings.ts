import { errorResponse, json, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'

export const workspaceSettingsRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/settings$/,
    handler: (_req, _match, { system }) => json({
      workspacePrompt: system.settings.getPrompt(),
      responseFormat: system.settings.getResponseFormat(),
    }),
  },
  {
    method: 'PUT',
    pattern: /^\/settings$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      const unexpected = Object.keys(body).filter(key => !['workspacePrompt', 'responseFormat'].includes(key))
      if (unexpected.length > 0) return errorResponse(`unexpected fields: ${unexpected.join(', ')}`, 400)
      if (body.workspacePrompt !== undefined && typeof body.workspacePrompt !== 'string') return errorResponse('workspacePrompt must be a string', 400)
      if (body.responseFormat !== undefined && typeof body.responseFormat !== 'string') return errorResponse('responseFormat must be a string', 400)
      if (typeof body.workspacePrompt === 'string') system.settings.setPrompt(body.workspacePrompt)
      if (typeof body.responseFormat === 'string') system.settings.setResponseFormat(body.responseFormat)
      system.notifyAgentSettingsChanged()
      return json({
        workspacePrompt: system.settings.getPrompt(),
        responseFormat: system.settings.getResponseFormat(),
      })
    },
  },
]
