import { z } from 'zod'
import type { GeoJsonLineString, GeoJsonPosition2D, Meters } from '../core/model/index.ts'
import type { RoutingAdapter } from './protocol.ts'
import type { RouteRequest, RouteResult } from './protocol.ts'
import { geoJsonLineStringSchema, meters } from '../core/model/index.ts'

const osrmRouteSchema = z.object({
  code: z.literal('Ok'),
  routes: z.array(z.object({
    distance: z.number().finite().nonnegative(),
    duration: z.number().finite().nonnegative(),
    geometry: geoJsonLineStringSchema,
  })).min(1),
})

export interface OsrmRoutingConfig {
  readonly baseUrl: string
}

const formatCoord = (position: GeoJsonPosition2D): string => `${position[0]},${position[1]}`

export const createOsrmRoutingAdapter = (config: OsrmRoutingConfig): RoutingAdapter => {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  return {
    id: 'osrm',
    route: async (request: RouteRequest): Promise<RouteResult> => {
      const from = formatCoord(request.from.coordinates)
      const to = formatCoord(request.to.coordinates)
      const url = `${baseUrl}/route/v1/driving/${from};${to}?overview=full&geometries=geojson`
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`OSRM route request failed with HTTP ${response.status}`)
      }
      const parsed = osrmRouteSchema.parse(await response.json())
      const route = parsed.routes[0]
      if (!route) throw new Error('OSRM returned no route')
      return {
        geometry: route.geometry as GeoJsonLineString,
        distanceM: meters(route.distance) as Meters,
        durationSeconds: route.duration,
        provider: 'osrm',
      }
    },
  }
}
