import { readProductSource } from '../../core/product-source.ts'
import { errorResponse, json } from './helpers.ts'
import type { RouteEntry } from './types.ts'

export const productSourceRoutes: ReadonlyArray<RouteEntry> = [{
  method: 'GET',
  pattern: /^\/product-source$/,
  handler: async (request) => {
    const path = new URL(request.url).searchParams.get('path')
    if (!path) return errorResponse('path is required', 400)
    try {
      return json(await readProductSource(path))
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Product source is unavailable', 404)
    }
  },
}]
