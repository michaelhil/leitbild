import { json, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'

export const workspaceSettingsRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/workspace\/settings$/,
    handler: (_req, _match, { system }) => json({
      workspacePrompt: system.settings.getPrompt(),
      responseFormat: system.settings.getResponseFormat(),
    }),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/workspace\/settings$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (typeof body.workspacePrompt === 'string') system.settings.setPrompt(body.workspacePrompt)
      if (typeof body.responseFormat === 'string') system.settings.setResponseFormat(body.responseFormat)
      return json({
        workspacePrompt: system.settings.getPrompt(),
        responseFormat: system.settings.getResponseFormat(),
      })
    },
  },
]
