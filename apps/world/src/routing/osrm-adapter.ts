import { z } from 'zod'
import type { GeoJsonLineString, GeoJsonPosition2D, Meters } from '../core/model/index.ts'
import type { RoutingAdapter } from './protocol.ts'
import type { RouteRequest, RouteResult } from './protocol.ts'
import { geoJsonLineStringSchema, geoJsonPointSchema, meters } from '../core/model/index.ts'

// Routing blocks an operator decision, not background ingestion. Bound the full
// request (headers and decoded body), while allowing slower hosts to opt in.
export const defaultRoutingTimeoutMs = 10_000
const maxResponseBytes = 4 * 1024 * 1024
const maxRouteVertices = 50_000

const osrmRouteSchema = z.object({
  code: z.literal('Ok'),
  routes: z.array(z.object({
    distance: z.number().finite().nonnegative(),
    duration: z.number().finite().nonnegative(),
    geometry: geoJsonLineStringSchema.extend({
      coordinates: geoJsonLineStringSchema.shape.coordinates.max(maxRouteVertices),
    }),
  })).length(1),
})

export interface OsrmRoutingConfig {
  readonly baseUrl: string
  /** Whole request deadline, including response body; 1–120000 ms. */
  readonly timeoutMs?: number
}

const formatCoord = (position: GeoJsonPosition2D): string => `${position[0]},${position[1]}`

export const createOsrmRoutingAdapter = (config: OsrmRoutingConfig): RoutingAdapter => {
  const endpoint = new URL(config.baseUrl)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('OSRM baseUrl must be an HTTP(S) endpoint without credentials, query or fragment')
  }
  const baseUrl = endpoint.href.replace(/\/+$/, '')
  const timeoutMs = z.number().int().positive().max(120_000).parse(config.timeoutMs ?? defaultRoutingTimeoutMs)
  return {
    id: 'osrm',
    route: async (request: RouteRequest): Promise<RouteResult> => {
      request.signal?.throwIfAborted()
      const from = formatCoord(geoJsonPointSchema.parse(request.from).coordinates)
      const to = formatCoord(geoJsonPointSchema.parse(request.to).coordinates)
      const url = `${baseUrl}/route/v1/driving/${from};${to}?overview=full&geometries=geojson&alternatives=false&steps=false`
      const controller = new AbortController()
      const timeout = new DOMException(`OSRM routing exceeded ${timeoutMs} ms deadline`, 'TimeoutError')
      const deadline = performance.now() + timeoutMs
      const timer = setTimeout(() => controller.abort(timeout), timeoutMs)
      const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal
      const assertActive = (): void => {
        signal.throwIfAborted()
        // Synchronous decoding/validation can delay the timeout callback.
        if (performance.now() >= deadline) { controller.abort(timeout); throw timeout }
      }
      try {
        const response = await fetch(url, { signal, redirect: 'error' })
        assertActive()
        if (!response.ok) throw new Error(`OSRM route request failed with HTTP ${response.status}`)
        const declaredLength = response.headers.get('content-length')
        if (declaredLength !== null && Number(declaredLength) > maxResponseBytes) {
          throw new Error(`OSRM response exceeds ${maxResponseBytes} byte budget`)
        }
        if (!response.body) throw new Error('OSRM returned an empty response body')
        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let bytes = 0
        let body = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            assertActive()
            if (done) break
            bytes += value.byteLength
            if (bytes > maxResponseBytes) throw new Error(`OSRM response exceeds ${maxResponseBytes} byte budget`)
            body += decoder.decode(value, { stream: true })
          }
          body += decoder.decode()
        } finally { reader.releaseLock() }
        const parsed = osrmRouteSchema.parse(JSON.parse(body))
        assertActive()
        const route = parsed.routes[0]!
        return {
          geometry: route.geometry as GeoJsonLineString,
          distanceM: meters(route.distance) as Meters,
          durationSeconds: route.duration,
          provider: 'osrm',
        }
      } catch (error) {
        // Abort the actual I/O, not just a Promise.race that leaves late work alive.
        if (signal.aborted) throw signal.reason
        throw error
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    },
  }
}
