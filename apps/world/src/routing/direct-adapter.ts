import type { RoutingAdapter, RouteRequest, RouteResult } from './protocol.ts'
import { geoJsonPointSchema, meters } from '../core/model/index.ts'

const distanceMeters = (request: RouteRequest): number => {
  const [fromLon, fromLat] = request.from.coordinates
  const [toLon, toLat] = request.to.coordinates
  const meanLatRad = ((fromLat + toLat) / 2) * Math.PI / 180
  const dx = (toLon - fromLon) * 111_320 * Math.cos(meanLatRad)
  const dy = (toLat - fromLat) * 110_540
  return Math.sqrt(dx * dx + dy * dy)
}

export const createDirectRoutingAdapter = (): RoutingAdapter => ({
  id: 'direct',
  route: async (request: RouteRequest): Promise<RouteResult> => {
    request.signal?.throwIfAborted()
    const from = geoJsonPointSchema.parse(request.from)
    const to = geoJsonPointSchema.parse(request.to)
    const distanceM = distanceMeters({ from, to })
    return {
      geometry: {
        type: 'LineString',
        coordinates: [from.coordinates, to.coordinates],
      },
      distanceM: meters(distanceM),
      durationSeconds: distanceM / 15,
      provider: 'direct',
    }
  },
})
