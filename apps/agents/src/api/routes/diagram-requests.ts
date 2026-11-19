import { z } from 'zod'
import type { RouteEntry } from './types.ts'
import { json, errorResponse } from './helpers.ts'
import { DIAGRAM_REQUEST_STATUS, isDiagramRequestRefusal } from '../../core/diagram-request.ts'
import { MAX_MERMAID_SOURCE } from '../../core/render-validators/mermaid-limits.ts'

const bodySchema = z.object({
  requesterId: z.string().min(1),
  diagramIndex: z.number().int().nonnegative(),
  source: z.string().min(1).max(MAX_MERMAID_SOURCE).refine(source => source.trim().length > 0, 'Diagram source must not be blank'),
  initialSource: z.string().min(1).max(MAX_MERMAID_SOURCE),
  instruction: z.string().trim().min(1),
}).strict()

export const diagramRequestRoutes: RouteEntry[] = [{
  method: 'POST',
  pattern: /^\/rooms\/([^/]+)\/messages\/([^/]+)\/diagram-request$/,
  handler: async (request, match, { system }) => {
    let roomId: string, messageId: string
    try { roomId = decodeURIComponent(match[1]!); messageId = decodeURIComponent(match[2]!) }
    catch (error) {
      if (error instanceof URIError) return errorResponse('Malformed Room or message id', 400)
      throw error
    }
    let raw: unknown
    try { raw = await request.json() }
    catch { return errorResponse('Request body must be JSON', 400) }
    const body = bodySchema.safeParse(raw)
    if (!body.success) return errorResponse(z.prettifyError(body.error), 400)
    try { return json(system.requestDiagramRevision(roomId, messageId, body.data), 202) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'workspace_closing') return json({ error: error.message, code: error.code }, 409)
      if (!isDiagramRequestRefusal(error)) throw error
      return json({ error: error.message, code: error.code }, DIAGRAM_REQUEST_STATUS[error.code])
    }
  },
}]
