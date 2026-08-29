import type { GeoJsonLineString, GeoJsonPoint, Meters } from '../core/model/index.ts'

export interface RouteRequest {
  readonly from: GeoJsonPoint
  readonly to: GeoJsonPoint
}

export interface RouteResult {
  readonly geometry: GeoJsonLineString
  readonly distanceM: Meters
  readonly durationSeconds: number
  readonly provider: string
}

export interface RoutingAdapter {
  readonly id: string
  readonly route: (request: RouteRequest) => Promise<RouteResult>
}
