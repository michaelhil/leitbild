import { DEMO_CATALOG } from '../../core/definitions/demo-catalog.ts'
import { applyDemo, runPromptDeckEntry } from '../../core/definitions/demo-service.ts'
import { errorResponse, json } from './helpers.ts'
import type { RouteEntry } from './types.ts'

export const demoRoutes: ReadonlyArray<RouteEntry> = [
  {
    method: 'GET',
    pattern: /^\/demos$/,
    handler: () => json({ demos: DEMO_CATALOG }),
  },
  {
    method: 'POST',
    pattern: /^\/demos\/([^/]+)\/apply$/,
    handler: async (_req, match, { system }) => {
      try {
        return json(await applyDemo(system, decodeURIComponent(match[1]!)), 201)
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : 'Failed to apply demo', 400)
      }
    },
  },
  {
    method: 'POST',
    pattern: /^\/demos\/([^/]+)\/rooms\/([^/]+)\/entries\/([^/]+)\/run$/,
    handler: async (_req, match, { system }) => {
      try {
        const entry = await runPromptDeckEntry(
          system,
          decodeURIComponent(match[1]!),
          decodeURIComponent(match[2]!),
          decodeURIComponent(match[3]!),
        )
        return json({ ran: true, entry })
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : 'Failed to run Prompt Deck entry', 400)
      }
    },
  },
]
