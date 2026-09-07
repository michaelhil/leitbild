import { readProductSource } from '@leitbild/knowledge/source'
import { resolve } from 'node:path'
import { errorResponse, json } from './helpers.ts'
import type { RouteEntry } from './types.ts'

export const productSourceRoutes: ReadonlyArray<RouteEntry> = [{
  method: 'GET',
  pattern: /^\/product-source$/,
  handler: async (request) => {
    const path = new URL(request.url).searchParams.get('path')
    if (!path) return errorResponse('path is required', 400)
    try {
      return json(await readProductSource(path, resolve(import.meta.dir, '../../../../..')))
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Product source is unavailable', 404)
    }
  },
}]
